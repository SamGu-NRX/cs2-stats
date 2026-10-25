//! Backed-up, verified, reversible writes to the game folder.
//!
//! Every write goes through a [`ChangeSet`], one per operation (an install, an overlay, a
//! setting). Before a file is replaced, its current content is copied into
//! `backups\<id>\files\` and checked against its hash. Then a line naming the path, the old
//! hash and the new hash is appended to `backups\<id>\entries.jsonl` and flushed. Only then
//! is the new content written, to a temporary file next to the target that is renamed into
//! place and hashed again.
//!
//! Because the journal line lands before the write, a crash leaves a change that
//! [`rollback`] can still undo: each entry is restored only if the file still holds the
//! content Bot Mode wrote, and is left alone if it already holds the old content.

use super::hash;
use super::paths::{self, Layout, Protection, TMP_SUFFIX};
use super::process::{ensure_cs2_closed, OpLock, ProcessProbe};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Still running, or interrupted by a crash. Rollback treats it like a finished change.
    InProgress,
    Complete,
    RolledBack,
    /// Failed part-way and was rolled back automatically.
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// Changes are numbered in the order they began; rollback goes by this number.
    pub seq: u64,
    pub id: String,
    pub operation: String,
    /// UTC, ISO 8601.
    pub created: String,
    pub status: Status,
    /// Files written by the change.
    pub files: usize,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entry {
    pub path: String,
    /// SHA-256 before the change; `None` when the change created the file.
    pub before: Option<String>,
    pub after: String,
}

const META: &str = "meta.json";
const ENTRIES: &str = "entries.jsonl";
const STATE_BEFORE: &str = "state-before.json";

pub struct ChangeSet {
    layout: Layout,
    /// The game folder with links resolved; every write must land inside it.
    root_canon: PathBuf,
    dir: PathBuf,
    meta: Meta,
    entries: Vec<Entry>,
    log: File,
}

impl ChangeSet {
    /// Starts a change, right before its writes. Needs the operation lock, and refuses while
    /// CS2 runs, so no change exists without both.
    pub fn begin(layout: &Layout, probe: &dyn ProcessProbe, _lock: &OpLock, operation: &str) -> Result<ChangeSet, String> {
        ensure_cs2_closed(probe)?;
        let root_canon = layout.csgo.canonicalize().map_err(|e| format!("{}: {e}", layout.csgo.display()))?;
        let (compact, iso) = now_utc();
        let seq = list(layout)?.iter().map(|m| m.seq).max().unwrap_or(0) + 1;
        let id = format!("{seq:04}-{compact}-{operation}");
        let dir = layout.backups().join(&id);
        fs::create_dir_all(dir.join("files")).map_err(|e| format!("{}: {e}", dir.display()))?;
        // The app state (installed release, applied overlays) is restored along with the files.
        let state = layout.state_file();
        if state.is_file() {
            copy_synced(&state, &dir.join(STATE_BEFORE)).map_err(|e| format!("{}: {e}", state.display()))?;
        }
        let meta = Meta { seq, id, operation: operation.into(), created: iso, status: Status::InProgress, files: 0, error: None };
        write_meta(&dir, &meta)?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(ENTRIES))
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(ChangeSet { layout: layout.clone(), root_canon, dir, meta, entries: Vec::new(), log })
    }

    pub fn id(&self) -> &str {
        &self.meta.id
    }

    /// Writes a mod file whose final content must hash to `expected`. `fill` writes that
    /// content into the temporary file. Returns false when the file already matched.
    /// Protected user files are refused here, whatever the caller.
    pub fn put(
        &mut self,
        rel: &str,
        expected: &str,
        fill: impl FnOnce(&mut File) -> Result<(), String>,
    ) -> Result<bool, String> {
        let rel = paths::rel(rel)?;
        if paths::protection(&rel) != Protection::None {
            return Err(format!("{rel}: a protected user file; Bot Mode never replaces it"));
        }
        self.put_inner(rel, expected, fill)
    }

    pub fn put_bytes(&mut self, rel: &str, data: &[u8]) -> Result<bool, String> {
        let expected = hash::bytes(data);
        self.put(rel, &expected, |f| f.write_all(data).map_err(|e| e.to_string()))
    }

    pub fn put_file(&mut self, rel: &str, src: &Path, expected: &str) -> Result<bool, String> {
        self.put(rel, expected, |f| {
            let r = File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
            hash::copy(r, f).map(|_| ()).map_err(|e| format!("{}: {e}", src.display()))
        })
    }

    /// Writes the result of merging convar lines into a protected cfg. The caller has
    /// already kept every other line of the user's file.
    pub fn put_merged_cfg(&mut self, rel: &str, merged: &[u8]) -> Result<bool, String> {
        let rel = paths::rel(rel)?;
        if paths::protection(&rel) != Protection::MergeConvars {
            return Err(format!("{rel}: not a cfg Bot Mode merges convars into"));
        }
        let expected = hash::bytes(merged);
        self.put_inner(rel, &expected, |f| f.write_all(merged).map_err(|e| e.to_string()))
    }

    fn put_inner(
        &mut self,
        rel: String,
        expected: &str,
        fill: impl FnOnce(&mut File) -> Result<(), String>,
    ) -> Result<bool, String> {
        if self.entries.iter().any(|e| e.path.eq_ignore_ascii_case(&rel)) {
            return Err(format!("{rel}: written twice in one change"));
        }
        let target = paths::confined(&self.layout.csgo, &self.root_canon, &rel, true)?;
        let before = hash::file_if_exists(&target)?;
        if before.as_deref() == Some(expected) {
            return Ok(false);
        }
        if let Some(old) = &before {
            let saved = backup_path(&self.dir, &rel);
            if let Some(parent) = saved.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            copy_synced(&target, &saved).map_err(|e| format!("backing up {rel}: {e}"))?;
            if hash::file(&saved)? != *old {
                return Err(format!("{rel}: the backup copy does not match the original"));
            }
        }
        let entry = Entry { path: rel.clone(), before, after: expected.to_string() };
        let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
        writeln!(self.log, "{line}")
            .and_then(|_| self.log.sync_data())
            .map_err(|e| format!("writing the change journal: {e}"))?;
        self.entries.push(entry);

        let tmp = tmp_path(&target);
        let written = File::create(&tmp)
            .map_err(|e| format!("{}: {e}", tmp.display()))
            .and_then(|mut f| {
                fill(&mut f)?;
                f.sync_all().map_err(|e| e.to_string())
            })
            .and_then(|_| hash::file(&tmp));
        match written {
            Ok(got) if got == expected => {}
            Ok(got) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("{rel}: new content hashes to {got}, expected {expected}"));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("{rel}: {e}"));
            }
        }
        fs::rename(&tmp, &target).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("{rel}: {e}")
        })?;
        let after = hash::file(&target)?;
        if after != expected {
            return Err(format!("{rel}: hashes to {after} after the copy, expected {expected}"));
        }
        Ok(true)
    }

    /// Finishes the change. A change that wrote nothing leaves no backup behind.
    pub fn commit(mut self) -> Result<Meta, String> {
        self.meta.files = self.entries.len();
        if self.entries.is_empty() {
            drop(self.log);
            fs::remove_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
            self.meta.status = Status::Complete;
            return Ok(self.meta);
        }
        self.meta.status = Status::Complete;
        write_meta(&self.dir, &self.meta)?;
        Ok(self.meta)
    }

    /// Undoes what this change wrote after `error`, and returns a message naming both.
    pub fn abort(mut self, error: String) -> String {
        self.meta.files = self.entries.len();
        let undo = restore(&self.layout, &self.root_canon, &self.dir, &self.entries, None)
            .and_then(|r| restore_state(&self.layout, &self.dir).map(|_| r));
        self.meta.status = Status::Failed;
        self.meta.error = Some(error.clone());
        let _ = write_meta(&self.dir, &self.meta);
        match undo {
            Ok(r) => format!("{error}. Nothing was left changed: {} file(s) restored from backup {}.", r.restored + r.removed, self.meta.id),
            Err(e) => format!("{error}. Restoring the backup also failed ({e}); run `botmode rollback {}` once the cause is fixed.", self.meta.id),
        }
    }
}

/// Runs `body` inside a change: commits on success, rolls back and reports on failure.
pub fn run<T>(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    lock: &OpLock,
    operation: &str,
    body: impl FnOnce(&mut ChangeSet) -> Result<T, String>,
) -> Result<(T, Meta), String> {
    let mut cs = ChangeSet::begin(layout, probe, lock, operation)?;
    match body(&mut cs) {
        Ok(v) => Ok((v, cs.commit()?)),
        Err(e) => Err(cs.abort(e)),
    }
}

fn backup_path(dir: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(dir.join("files"), |p, part| p.join(part))
}

fn tmp_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(TMP_SUFFIX);
    target.with_file_name(name)
}

fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    let text = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(META), text.as_bytes())
}

/// Writes app data (not game files) through a temporary file and a rename.
pub fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let tmp = tmp_path(path);
    File::create(&tmp)
        .and_then(|mut f| f.write_all(data).and_then(|_| f.sync_all()))
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Copies a file and flushes the copy to disk before returning, so a backup or restored file
/// survives a crash right after it is made.
fn copy_synced(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::copy(src, dst)?;
    OpenOptions::new().write(true).open(dst)?.sync_all()
}

fn read_entries(dir: &Path) -> Result<Vec<Entry>, String> {
    let path = dir.join(ENTRIES);
    let f = File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let lines: Vec<String> = BufReader::new(f).lines().collect::<Result<_, _>>().map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        match serde_json::from_str::<Entry>(line) {
            Ok(e) => out.push(e),
            // A torn last line means the process died while journaling, before that write began.
            Err(_) if i + 1 == lines.len() => {}
            Err(e) => return Err(format!("{} line {}: {e}", path.display(), i + 1)),
        }
    }
    Ok(out)
}

/// Every recorded change, newest first.
pub fn list(layout: &Layout) -> Result<Vec<Meta>, String> {
    let dir = layout.backups();
    let items = match fs::read_dir(&dir) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let mut out = Vec::new();
    for item in items {
        let path = item.map_err(|e| e.to_string())?.path().join(META);
        if let Ok(text) = fs::read_to_string(&path) {
            out.push(serde_json::from_str::<Meta>(&text).map_err(|e| format!("{}: {e}", path.display()))?);
        }
    }
    out.sort_by(|a, b| b.seq.cmp(&a.seq));
    Ok(out)
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RollbackReport {
    pub id: String,
    pub operation: String,
    /// Files put back to their backed-up content.
    pub restored: usize,
    /// Files the change had created, now deleted.
    pub removed: usize,
    /// Files that already held their old content.
    pub unchanged: usize,
}

/// Rolls back the newest change that is still in effect, or the one named by `id`, which
/// must be that newest one: changes come off in the reverse order they went on.
pub fn rollback(layout: &Layout, probe: &dyn ProcessProbe, id: Option<&str>) -> Result<RollbackReport, String> {
    ensure_cs2_closed(probe)?;
    let _lock = OpLock::acquire(layout)?;
    let root_canon = layout.csgo.canonicalize().map_err(|e| format!("{}: {e}", layout.csgo.display()))?;
    let active: Vec<Meta> = list(layout)?
        .into_iter()
        .filter(|m| matches!(m.status, Status::Complete | Status::InProgress))
        .collect();
    let newest = active.first().ok_or("no change to roll back")?;
    if let Some(id) = id {
        if id != newest.id {
            return Err(match active.iter().position(|m| m.id == id) {
                Some(_) => format!("{id} is not the newest change; roll back {} first", newest.id),
                None => format!("{id}: no such change in effect (see `botmode backups`)"),
            });
        }
    }
    let mut meta = newest.clone();
    let dir = layout.backups().join(&meta.id);
    let entries = read_entries(&dir)?;
    let mut report = restore(layout, &root_canon, &dir, &entries, Some(probe))?;
    restore_state(layout, &dir)?;
    meta.status = Status::RolledBack;
    write_meta(&dir, &meta)?;
    report.id = meta.id;
    report.operation = meta.operation;
    Ok(report)
}

/// Puts `state.json` back as it was when the change began.
fn restore_state(layout: &Layout, dir: &Path) -> Result<(), String> {
    let saved = dir.join(STATE_BEFORE);
    let state = layout.state_file();
    if saved.is_file() {
        copy_synced(&saved, &state).map_err(|e| format!("restoring the app state: {e}"))
    } else if state.is_file() {
        fs::remove_file(&state).map_err(|e| format!("restoring the app state: {e}"))
    } else {
        Ok(())
    }
}

/// Puts `entries` back to their `before` content. Checks every file first and changes
/// nothing if any file holds neither the old nor the new content, because something else
/// wrote it after Bot Mode did. Then, with `probe`, checks CS2 again, and re-hashes each file
/// immediately before restoring it: a file another program changed after the first pass is
/// left alone and stops the rollback, which can be run again once the cause is dealt with.
fn restore(layout: &Layout, root_canon: &Path, dir: &Path, entries: &[Entry], probe: Option<&dyn ProcessProbe>) -> Result<RollbackReport, String> {
    let mut todo = Vec::new();
    let mut conflicts = Vec::new();
    let mut report = RollbackReport::default();
    for e in entries.iter().rev() {
        let target = paths::confined(&layout.csgo, root_canon, &e.path, false)?;
        let now = hash::file_if_exists(&target)?;
        if now == e.before {
            report.unchanged += 1;
        } else if now.as_deref() == Some(e.after.as_str()) {
            todo.push((e, target));
        } else {
            conflicts.push(e.path.clone());
        }
    }
    if !conflicts.is_empty() {
        let shown: Vec<_> = conflicts.iter().take(10).cloned().collect();
        return Err(format!(
            "{} file(s) changed after Bot Mode wrote them, so nothing was rolled back: {}{}",
            conflicts.len(),
            shown.join(", "),
            if conflicts.len() > 10 { ", ..." } else { "" }
        ));
    }
    if let Some(probe) = probe {
        ensure_cs2_closed(probe)?;
    }
    for (e, target) in todo {
        let now = hash::file_if_exists(&target)?;
        if now == e.before {
            report.unchanged += 1;
            continue;
        }
        if now.as_deref() != Some(e.after.as_str()) {
            return Err(format!(
                "{} changed while the rollback ran, so it was left as it is; {} file(s) were already put back. Run rollback again to finish.",
                e.path,
                report.restored + report.removed
            ));
        }
        match &e.before {
            Some(old) => {
                let saved = backup_path(dir, &e.path);
                if hash::file(&saved)? != *old {
                    return Err(format!("{}: the backup copy is damaged; it was not restored", e.path));
                }
                let tmp = tmp_path(&target);
                copy_synced(&saved, &tmp).map_err(|err| format!("{}: {err}", e.path))?;
                fs::rename(&tmp, &target).map_err(|err| format!("{}: {err}", e.path))?;
                if hash::file(&target)? != *old {
                    return Err(format!("{}: restored content does not match the backup", e.path));
                }
                report.restored += 1;
            }
            None => {
                fs::remove_file(&target).map_err(|err| format!("{}: {err}", e.path))?;
                report.removed += 1;
            }
        }
    }
    Ok(report)
}

/// The current time in UTC as a compact id part ("20261025T191500Z") and as ISO 8601.
pub fn now_utc() -> (String, String) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    (
        format!("{y:04}{m:02}{d:02}T{h:02}{mi:02}{s:02}Z"),
        format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z"),
    )
}
