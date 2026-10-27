//! Backed-up, verified, reversible writes to the game folder.
//!
//! Every write goes through a [`ChangeSet`], one per operation (an install, an overlay, a
//! setting). Before a file is replaced, its current content is copied into
//! `backups\<id>\files\` and checked against its hash. Then a line naming the path, the old
//! hash and the new hash is appended to `backups\<id>\entries.jsonl` and flushed. Only then
//! is the new content written, to a temporary file next to the target that is renamed into
//! place and hashed again. Folders are flushed after each file is created, renamed or removed
//! in them, so the order survives a power cut.
//!
//! Because the journal line lands before the write, a crash leaves a change that
//! [`rollback`] can still undo: each entry is restored only if the file still holds the
//! content Bot Mode wrote, and is left alone if it already holds the old content. Until an
//! interrupted or partly undone change is rolled back, no new change can begin.

use super::hash;
use super::paths::{self, Layout, Protection, TMP_SUFFIX};
use super::process::{ensure_cs2_closed, OpLock, Phase, ProcessProbe};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Still running, or interrupted by a crash. Must be rolled back before anything else.
    InProgress,
    Complete,
    RolledBack,
    /// Failed part-way and was rolled back automatically, completely.
    Failed,
    /// Failed part-way, and the automatic rollback could not finish (CS2 was running, or a
    /// file had changed). Must be rolled back before anything else.
    RollbackPending,
    /// An interrupted session toggle that was closed without being rolled back. Cleanup has
    /// verified that restoring it is unsafe or that ownership was not recorded.
    Superseded,
}

impl Status {
    /// Changes `rollback` can still take off.
    fn in_effect(&self) -> bool {
        matches!(self, Status::Complete | Status::InProgress | Status::RollbackPending)
    }

    /// Changes that leave the game folder half-written.
    fn unfinished(&self) -> bool {
        matches!(self, Status::InProgress | Status::RollbackPending)
    }
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
    /// Folders Windows would not flush to disk (see `paths::flush_dir`).
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub kind: Kind,
}

/// What a change is for.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// An install, overlay or setting: rolled back with `rollback`.
    #[default]
    Normal,
    /// A session turning Bot Mode on or off in `gameinfo.gi`. Journaled for crash safety, but
    /// never taken off by `rollback`: undoing an "off" would turn Bot Mode on with nothing
    /// watching CS2. An interrupted one is finished in the off direction instead.
    Session,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entry {
    pub path: String,
    /// SHA-256 before the change; `None` when the change created the file.
    pub before: Option<String>,
    pub after: String,
}

/// In the error of a compare-and-swap whose file changed after it was read.
pub const CHANGED_SINCE_READ: &str = "changed since it was read";

const META: &str = "meta.json";
const ENTRIES: &str = "entries.jsonl";
const STATE_BEFORE: &str = "state-before.json";

/// Flushes folders and remembers those Windows refused, to report once per change.
#[derive(Default)]
struct Flusher {
    refused: BTreeSet<PathBuf>,
}

impl Flusher {
    fn flush(&mut self, dir: &Path) -> Result<(), String> {
        if !paths::flush_dir(dir)? {
            self.refused.insert(dir.to_path_buf());
        }
        Ok(())
    }

    fn parent_of(&mut self, path: &Path) -> Result<(), String> {
        match path.parent() {
            Some(p) => self.flush(p),
            None => Ok(()),
        }
    }

    /// After folders were created, flushes the parent of each new one, deepest first, so the
    /// whole new chain is on disk. `created` comes from `paths::missing_ancestors`.
    fn created(&mut self, created: &[PathBuf]) -> Result<(), String> {
        for dir in created {
            self.parent_of(dir)?;
        }
        Ok(())
    }

    /// Creates `dir` and any missing ancestors, then flushes them.
    fn create_dir_all(&mut self, dir: &Path) -> Result<(), String> {
        let missing = paths::missing_ancestors(dir);
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        self.created(&missing)
    }

    fn warnings(&self) -> Vec<String> {
        self.refused
            .iter()
            .map(|d| format!("Windows would not flush folder {} to disk without administrator rights; the change is complete, but a power cut in the next few seconds could lose its last steps", d.display()))
            .collect()
    }
}

pub struct ChangeSet<'p> {
    layout: Layout,
    probe: &'p dyn ProcessProbe,
    /// The game folder with links resolved; every write must land inside it.
    root_canon: PathBuf,
    dir: PathBuf,
    meta: Meta,
    entries: Vec<Entry>,
    log: File,
    flusher: Flusher,
    /// Set by `put_bytes_if_unchanged` for the length of its write.
    guard_hash: Option<String>,
}

impl<'p> ChangeSet<'p> {
    /// Starts a change, right before its writes. Needs the operation lock, refuses while CS2
    /// runs, and refuses while an earlier change is unfinished.
    pub fn begin(layout: &Layout, probe: &'p dyn ProcessProbe, lock: &OpLock, operation: &str) -> Result<ChangeSet<'p>, String> {
        Self::begin_kind(layout, probe, lock, operation, Kind::Normal)
    }

    fn begin_kind(layout: &Layout, probe: &'p dyn ProcessProbe, _lock: &OpLock, operation: &str, kind: Kind) -> Result<ChangeSet<'p>, String> {
        ensure_cs2_closed(probe, Phase::ChangeBegin)?;
        let existing = list(layout)?;
        // Turning Bot Mode off must work even with an install left half-done: it only touches
        // gameinfo.gi, which installs leave alone. Interrupted session toggles must be
        // superseded first.
        let blocks = |m: &&Meta| m.status.unfinished() && (kind == Kind::Normal || m.kind == Kind::Session);
        // Checked again here, under the operation lock, at the write boundary: no install,
        // overlay, setting or rollback runs while a session supervisor holds the lease.
        if kind == Kind::Normal && super::process::session_held(&layout.csgo)? {
            return Err("a Bot Mode session is running; wait until CS2 has exited".into());
        }
        if let Some(m) = existing.iter().find(blocks) {
            return Err(format!(
                "change {} ({}) is unfinished, so the game folder may be half-written; run `botmode rollback` first",
                m.id, m.operation
            ));
        }
        let root_canon = layout.csgo.canonicalize().map_err(|e| format!("{}: {e}", layout.csgo.display()))?;
        let (compact, iso) = now_utc();
        let seq = existing.iter().map(|m| m.seq).max().unwrap_or(0) + 1;
        let id = format!("{seq:04}-{compact}-{operation}");
        let dir = layout.backups().join(&id);
        let mut flusher = Flusher::default();
        let meta = Meta {
            seq,
            id,
            operation: operation.into(),
            created: iso,
            status: Status::InProgress,
            files: 0,
            error: None,
            warnings: Vec::new(),
            kind,
        };
        // The journal and the saved app state exist, on disk, before meta.json records the
        // change as in progress. A failure before that point removes the partial record, so
        // no change is ever listed without its journal.
        let init = |flusher: &mut Flusher| -> Result<File, String> {
            flusher.create_dir_all(&dir.join("files"))?;
            let log = OpenOptions::new()
                .create_new(true)
                .append(true)
                .open(dir.join(ENTRIES))
                .map_err(|e| format!("{}: {e}", dir.display()))?;
            log.sync_all().map_err(|e| format!("{}: {e}", dir.display()))?;
            // The app state (installed release, applied overlays) is restored along with the files.
            let state = layout.state_file();
            if state.is_file() {
                copy_synced(&state, &dir.join(STATE_BEFORE)).map_err(|e| format!("{}: {e}", state.display()))?;
            }
            flusher.flush(&dir)?;
            write_meta(&dir, &meta)?;
            Ok(log)
        };
        let log = match init(&mut flusher) {
            Ok(log) => log,
            Err(e) => {
                let _ = fs::remove_dir_all(&dir);
                let _ = paths::flush_dir(&layout.backups());
                return Err(format!("starting the change failed: {e}"));
            }
        };
        Ok(ChangeSet { layout: layout.clone(), probe, root_canon, dir, meta, entries: Vec::new(), log, flusher, guard_hash: None })
    }

    pub fn id(&self) -> &str {
        &self.meta.id
    }

    /// This change's backup folder.
    pub fn dir(&self) -> &Path {
        &self.dir
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

    /// [`put_bytes`](Self::put_bytes), refused unless the file still hashes to `read_hash`, the
    /// content the caller computed `data` from. The hash is compared when the write starts and
    /// again immediately before the new content is renamed into place. That narrows the window
    /// in which another program (Valve's updater) could write the file in between, but does not
    /// close it: Windows offers no atomic compare-and-swap of a file against an unrelated writer.
    pub fn put_bytes_if_unchanged(&mut self, rel: &str, data: &[u8], read_hash: &str) -> Result<bool, String> {
        let rel = paths::rel(rel)?;
        let path = paths::confined(&self.layout.csgo, &self.root_canon, &rel, false)?;
        if hash::file_if_exists(&path)?.as_deref() != Some(read_hash) {
            return Err(format!("{rel}: {CHANGED_SINCE_READ}"));
        }
        if paths::protection(&rel) != Protection::None {
            return Err(format!("{rel}: a protected user file; Bot Mode never replaces it"));
        }
        let expected = hash::bytes(data);
        self.guard_hash = Some(read_hash.to_string());
        let r = self.put_inner(rel, &expected, |f| f.write_all(data).map_err(|e| e.to_string()));
        self.guard_hash = None;
        r
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

    fn confine(&self, rel: &str) -> Result<PathBuf, String> {
        paths::confined(&self.layout.csgo, &self.root_canon, rel, true)
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
        let new_dirs = paths::missing_ancestors(self.layout.target(&rel).parent().unwrap_or(&self.layout.csgo));
        let target = self.confine(&rel)?;
        self.flusher.created(&new_dirs)?;
        let before = hash::file_if_exists(&target)?;
        if before.as_deref() == Some(expected) {
            return Ok(false);
        }
        if let Some(old) = &before {
            let saved = backup_path(&self.dir, &rel);
            if let Some(parent) = saved.parent() {
                self.flusher.create_dir_all(parent)?;
            }
            self.confine(&rel)?;
            copy_synced(&target, &saved).map_err(|e| format!("backing up {rel}: {e}"))?;
            self.flusher.parent_of(&saved)?;
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
        self.confine(&rel)?;
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
        if let Err(e) = self.confine(&rel) {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        if let Some(guard) = &self.guard_hash {
            if hash::file_if_exists(&target)?.as_deref() != Some(guard.as_str()) {
                let _ = fs::remove_file(&tmp);
                return Err(format!("{rel}: {CHANGED_SINCE_READ}"));
            }
        }
        fs::rename(&tmp, &target).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("{rel}: {e}")
        })?;
        self.flusher.parent_of(&target)?;
        let after = hash::file(&target)?;
        if after != expected {
            return Err(format!("{rel}: hashes to {after} after the copy, expected {expected}"));
        }
        Ok(true)
    }

    /// Whether `state.json` differs from the copy saved when the change began, so the change
    /// did something rollback must undo even when it wrote no game file.
    fn state_changed(&self) -> Result<bool, String> {
        let before = hash::file_if_exists(&self.dir.join(STATE_BEFORE))?;
        let now = hash::file_if_exists(&self.layout.state_file())?;
        Ok(before != now)
    }

    /// Finishes the change. A change that changed neither a game file nor the app state
    /// leaves no backup behind.
    fn commit(&mut self) -> Result<Meta, String> {
        self.meta.files = self.entries.len();
        self.meta.warnings = self.flusher.warnings();
        if self.entries.is_empty() && !self.state_changed()? {
            fs::remove_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
            self.flusher.parent_of(&self.dir)?;
        } else {
            self.meta.status = Status::Complete;
            write_meta(&self.dir, &self.meta)?;
        }
        self.meta.status = Status::Complete;
        Ok(self.meta.clone())
    }

    /// Undoes what this change wrote after `error`, and returns a message naming both. CS2 is
    /// checked again first; if it is running, or the undo cannot finish, the change is left
    /// as `RollbackPending` and the message says how to finish it.
    fn abort(mut self, error: String) -> String {
        self.meta.files = self.entries.len();
        self.meta.error = Some(error.clone());
        // A failed session "off" is never undone: restoring its before-image would turn Bot Mode
        // back on. Whatever it managed to write stays, and the change is closed; the supervisor
        // or the next cleanup turns Bot Mode off from there. A failed "on" is undone as usual,
        // which is the off direction.
        if self.meta.kind == Kind::Session && self.meta.operation == "bot-mode-off" {
            self.meta.status = Status::Superseded;
            let _ = write_meta(&self.dir, &self.meta);
            return format!("{error}. Turning Bot Mode off was not undone; it is retried until Bot Mode is off.");
        }
        let undo = restore(&self.layout, &self.root_canon, &self.dir, &self.entries, Some((self.probe, Phase::AutomaticRollback)), &mut self.flusher)
            .and_then(|r| restore_state(&self.layout, &self.dir).map(|_| r));
        self.meta.warnings = self.flusher.warnings();
        let msg = match &undo {
            Ok(r) => {
                self.meta.status = Status::Failed;
                format!("{error}. Nothing was left changed: {} file(s) restored from backup {}.", r.restored + r.removed, self.meta.id)
            }
            Err(e) => {
                self.meta.status = Status::RollbackPending;
                format!(
                    "{error}. The automatic rollback did not finish ({e}), so the game folder is partly changed; run `botmode rollback {}` once the cause is dealt with.",
                    self.meta.id
                )
            }
        };
        match write_meta(&self.dir, &self.meta) {
            Ok(()) => msg,
            // The meta file still says InProgress, which rollback also picks up.
            Err(e) => format!("{msg} (Recording the change's state also failed: {e}.)"),
        }
    }
}

/// Runs `body` inside a change: commits on success. A failure in `body`, or in finishing the
/// change, rolls the change back and reports.
pub fn run<T>(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    lock: &OpLock,
    operation: &str,
    body: impl FnOnce(&mut ChangeSet) -> Result<T, String>,
) -> Result<(T, Meta), String> {
    run_kind(layout, probe, lock, operation, Kind::Normal, body)
}

/// [`run`] for a change of the given kind.
pub fn run_kind<T>(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    lock: &OpLock,
    operation: &str,
    kind: Kind,
    body: impl FnOnce(&mut ChangeSet) -> Result<T, String>,
) -> Result<(T, Meta), String> {
    let mut cs = ChangeSet::begin_kind(layout, probe, lock, operation, kind)?;
    match body(&mut cs) {
        Ok(v) => match cs.commit() {
            Ok(meta) => Ok((v, meta)),
            Err(e) => Err(cs.abort(format!("finishing the change failed: {e}"))),
        },
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

/// Writes app data (not game files) through a synced temporary file and a rename, then flushes
/// the folder. The app folder is the user's own, so a refused folder flush is not reported.
pub fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let tmp = tmp_path(path);
    File::create(&tmp)
        .and_then(|mut f| f.write_all(data).and_then(|_| f.sync_all()))
        .map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))?;
    if let Some(parent) = path.parent() {
        paths::flush_dir(parent)?;
    }
    Ok(())
}

/// Copies a file and flushes the copy to disk before returning, so a backup or restored file
/// survives a crash right after it is made.
fn copy_synced(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::copy(src, dst)?;
    OpenOptions::new().write(true).open(dst)?.sync_all()
}

fn read_entries(dir: &Path) -> Result<Vec<Entry>, String> {
    let path = dir.join(ENTRIES);
    let f = match File::open(&path) {
        Ok(f) => f,
        // A record from before the journal was created first: every write is journaled
        // before it happens, so no journal means nothing was written.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
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

/// The newest change left interrupted or partly undone, which must be rolled back before any
/// other change. Shown by status and by every CLI command. Session toggles are not counted:
/// session cleanup finishes them.
pub fn unfinished(layout: &Layout) -> Result<Option<Meta>, String> {
    Ok(list(layout)?.into_iter().find(|m| m.status.unfinished() && m.kind == Kind::Normal))
}

/// Closes every interrupted session toggle as superseded, without restoring anything. The
/// caller must verify ownership before deciding whether another change can turn Bot Mode off.
pub fn supersede_unfinished_sessions(layout: &Layout) -> Result<(), String> {
    for mut m in list(layout)?.into_iter().filter(|m| m.kind == Kind::Session && m.status.unfinished()) {
        m.status = Status::Superseded;
        m.error = Some("interrupted; closed without rollback; ownership was not recorded".into());
        write_meta(&layout.backups().join(&m.id), &m)?;
    }
    Ok(())
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
    pub warnings: Vec<String>,
}

/// Rolls back the newest change that is still in effect, or the one named by `id`, which
/// must be that newest one: changes come off in the reverse order they went on.
pub fn rollback(layout: &Layout, probe: &dyn ProcessProbe, id: Option<&str>) -> Result<RollbackReport, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let _lock = OpLock::acquire(layout)?;
    // Under the operation lock, like every change's write boundary: never while a session runs.
    if super::process::session_held(&layout.csgo)? {
        return Err("a Bot Mode session is running; wait until CS2 has exited".into());
    }
    let root_canon = layout.csgo.canonicalize().map_err(|e| format!("{}: {e}", layout.csgo.display()))?;
    let all = list(layout)?;
    if let Some(m) = id.and_then(|id| all.iter().find(|m| m.id == id)).filter(|m| m.kind == Kind::Session) {
        return Err(format!(
            "{} turned Bot Mode {} for a session; session changes are never rolled back (Bot Mode is turned off when the session ends, or by the next Bot Mode command)",
            m.id,
            if m.operation == "bot-mode-on" { "on" } else { "off" }
        ));
    }
    // Session toggles are never taken off; interrupted ones are finished by session cleanup.
    let active: Vec<Meta> = all.into_iter().filter(|m| m.status.in_effect() && m.kind == Kind::Normal).collect();
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
    // Recorded, on disk, before anything is put back: if this rollback stops part-way, the
    // change stays pending and selectable instead of claiming to be complete.
    meta.status = Status::RollbackPending;
    write_meta(&dir, &meta)?;
    let mut flusher = Flusher::default();
    let mut report = restore(layout, &root_canon, &dir, &entries, Some((probe, Phase::Rollback)), &mut flusher)?;
    restore_state(layout, &dir)?;
    meta.status = Status::RolledBack;
    write_meta(&dir, &meta)?;
    report.id = meta.id;
    report.operation = meta.operation;
    report.warnings = flusher.warnings();
    Ok(report)
}

/// Puts `state.json` back as it was when the change began.
fn restore_state(layout: &Layout, dir: &Path) -> Result<(), String> {
    let saved = dir.join(STATE_BEFORE);
    let state = layout.state_file();
    if saved.is_file() {
        copy_synced(&saved, &state).map_err(|e| format!("restoring the app state: {e}"))?;
    } else if state.is_file() {
        fs::remove_file(&state).map_err(|e| format!("restoring the app state: {e}"))?;
    }
    paths::flush_dir(&layout.data).map(|_| ())
}

/// Puts `entries` back to their `before` content. Checks every file first and changes
/// nothing if any file holds neither the old nor the new content, because something else
/// wrote it after Bot Mode did. Then, with `probe`, checks CS2 again, and re-hashes each file
/// immediately before restoring it: a file another program changed after the first pass is
/// left alone and stops the rollback, which can be run again once the cause is dealt with.
fn restore(
    layout: &Layout,
    root_canon: &Path,
    dir: &Path,
    entries: &[Entry],
    probe: Option<(&dyn ProcessProbe, Phase)>,
    flusher: &mut Flusher,
) -> Result<RollbackReport, String> {
    let confine = |rel: &str| paths::confined(&layout.csgo, root_canon, rel, false);
    let mut todo = Vec::new();
    let mut conflicts = Vec::new();
    let mut report = RollbackReport::default();
    for e in entries.iter().rev() {
        let target = confine(&e.path)?;
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
    if let Some((probe, phase)) = probe {
        ensure_cs2_closed(probe, phase)?;
    }
    for (e, target) in todo {
        confine(&e.path)?;
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
                confine(&e.path)?;
                copy_synced(&saved, &tmp).map_err(|err| format!("{}: {err}", e.path))?;
                confine(&e.path)?;
                fs::rename(&tmp, &target).map_err(|err| format!("{}: {err}", e.path))?;
                flusher.parent_of(&target)?;
                if hash::file(&target)? != *old {
                    return Err(format!("{}: restored content does not match the backup", e.path));
                }
                report.restored += 1;
            }
            None => {
                confine(&e.path)?;
                fs::remove_file(&target).map_err(|err| format!("{}: {err}", e.path))?;
                flusher.parent_of(&target)?;
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
