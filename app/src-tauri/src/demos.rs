//! The demos CS2 records during Bot Mode matches, and how many are kept (design/recording.md).
//!
//! With recording on, Bot Mode starts CS2 with GOTV recording ([`TOKENS`]), and CS2 writes each
//! match to `game\csgo\replays\auto-<date>-<time>-<map>-<server name>.dem`. A listen server is
//! named after the player hosting it, so that name ends in the user's Steam name. Once CS2 has
//! exited, [`take`] moves each such demo into the store, `%APPDATA%\BotMatchStats\demos`, as
//! `<id>.dem`, with `<id>` = `<yyyymmddThhmmZ>_<map>_<sha8>`; the original name is never stored,
//! shown or put in an error. Each demo has a sidecar, `<id>.meta.json`, and every event is a line
//! in `ledger.jsonl`. extractor/local_import.py turns a demo into tables under `local\<id>\`; the
//! tables are the product, and the demo is a cache kept for clips.
//!
//! [`sweep`] decides which demos stay. A demo is kept while it is pinned, the app's engine names
//! it (an unrendered clip-worthy moment: `demos_sweep`'s keeps), it is among the newest
//! `demo_keep_last`, it has not been extracted yet, or its extraction failed and the extractor
//! has not changed since. The rest go. Kept demos then go too, oldest game build first (CS2 cannot
//! play those, so they make no clips) and then oldest, while the store is over its cap or the disk
//! is under the floor. Pinned demos are never deleted by a sweep.
//!
//! Every write to the store happens under the Bot Mode operation lock ([`OpLock`]); taking a demo
//! out of the game folder also needs CS2 closed. Every file in the store, and each demo taken from
//! `replays\`, is opened, checked and changed through one handle ([`handle`]): a junction, link or
//! hard link there is refused and left alone.

mod handle;

use crate::botmode::paths::Layout;
use crate::botmode::process::{ensure_cs2_closed, OpLock, Phase, ProcessProbe};
use crate::botmode::settings::AppSettings;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// What Bot Mode adds to the launch to record: GOTV on, recording each match from its start, no
/// spectator slots. They come after the user's own options, so they win over any the user set.
pub const TOKENS: [&str; 6] = ["+tv_enable", "1", "+tv_autorecord", "1", "+tv_maxclients", "0"];
/// Bytes in the GB the settings and the UI speak of: 2^30, as Windows Explorer counts them.
pub const GB: u64 = 1 << 30;
/// Room a match needs above the floor to be recorded. A full match is expected at 70 to 300 MB
/// (design/recording.md, a hypothesis until one is recorded), so 1 GB keeps a match from
/// pushing the disk under the floor.
pub const RESERVE: u64 = GB;
/// A demo modified this recently may still be being written, and is left for a later take.
pub const SETTLE: Duration = Duration::from_secs(60);

/// Where a demo is in its life.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// In the store, not yet extracted.
    Taken,
    Extracted,
    /// The last extraction failed; `fail_reason` says why.
    Failed,
    /// The sidecar is here but the demo is gone: deleted by hand.
    Missing,
}

/// A demo's sidecar, `<id>.meta.json`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub sha256: String,
    pub dem_bytes: u64,
    pub map: String,
    /// The demo file's creation time, UTC ISO-8601: when recording started.
    pub created_utc: String,
    /// `steam.inf`'s ClientVersion when the demo was taken: the build that can play it.
    pub game_build: Option<String>,
    pub state: State,
    #[serde(default)]
    pub pinned: bool,
    /// local_import.py's reason for the last failure: "no_rounds" or "extract_failed".
    #[serde(default)]
    pub fail_reason: Option<String>,
    /// The importer's first error for it.
    #[serde(default)]
    pub fail_detail: Option<String>,
    /// The extractor versions that failed on it; one failure is retried once the version changes.
    #[serde(default)]
    pub failed_versions: Vec<String>,
    /// Why the last sweep kept it.
    #[serde(default)]
    pub kept: Option<String>,
}

/// A demo the engine wants kept, and why ("moment": an unrendered clip-worthy moment).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Keep {
    pub id: String,
    pub reason: String,
}

/// The store folder and its files. Every file in it is opened, checked and changed through
/// [`handle::Dir`]: one handle per file, never a path that could lead elsewhere.
pub struct Store {
    /// `%APPDATA%\BotMatchStats\demos`, as the card shows it.
    pub root: PathBuf,
    /// Its canonical path, read once for this operation: on the first use, or when [`Store::ensure`]
    /// creates the folder.
    dir: std::cell::OnceCell<handle::Dir>,
}

const LEDGER: &str = "ledger.jsonl";
const KEEPS: &str = "keeps.json";

impl Store {
    /// `demos\` beside the Bot Mode folder: `%APPDATA%\BotMatchStats\demos`.
    pub fn of(layout: &Layout) -> Result<Store, String> {
        let parent = layout.data.parent().ok_or_else(|| format!("{}: no parent folder for the demos", layout.data.display()))?;
        Store::in_base(parent)
    }

    /// `demos\` in `base` (`%APPDATA%\BotMatchStats`). Refused at once when `demos\` is a junction or
    /// link; the folders above it may be (a relocated AppData).
    pub fn in_base(base: &Path) -> Result<Store, String> {
        let s = Store { root: base.join("demos"), dir: std::cell::OnceCell::new() };
        s.dir()?;
        Ok(s)
    }

    /// The folder, None while it does not exist.
    fn dir(&self) -> Result<Option<&handle::Dir>, String> {
        if let Some(d) = self.dir.get() {
            return Ok(Some(d));
        }
        match fs::symlink_metadata(&self.root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => {
                let d = handle::Dir::open(&self.root)?;
                Ok(Some(self.dir.get_or_init(|| d)))
            }
        }
    }

    /// The folder, created if missing.
    fn ensure(&self) -> Result<&handle::Dir, String> {
        if let Some(d) = self.dir()? {
            return Ok(d);
        }
        fs::create_dir_all(&self.root).map_err(|e| format!("{}: {e}", self.root.display()))?;
        self.dir()?.ok_or_else(|| format!("{} could not be created", self.root.display()))
    }

    /// Where the demo would be, for display and tests. Nothing opens a store file by this path.
    pub fn dem(&self, id: &str) -> PathBuf {
        self.root.join(dem_name(id))
    }

    /// Whether anything is at the demo's name; a link counts, and is refused when opened.
    fn has_dem(&self, id: &str) -> bool {
        self.dir().ok().flatten().is_some_and(|d| d.exists(&dem_name(id)))
    }

    /// The demo's canonical path, for the importer to read, once its file passes the checks.
    fn dem_checked(&self, id: &str) -> Result<PathBuf, String> {
        let d = self.dir()?.ok_or("the demos folder is gone")?;
        d.open_file(&dem_name(id), handle::Mode::Read)?.ok_or_else(|| format!("{} is gone", dem_name(id)))?;
        Ok(d.path().join(dem_name(id)))
    }

    pub fn read_meta(&self, id: &str) -> Result<Meta, String> {
        if !is_id(id) {
            return Err(format!("{id}: not a demo id"));
        }
        let name = meta_name(id);
        let bytes = self.dir()?.map(|d| d.read(&name)).transpose()?.flatten().ok_or_else(|| format!("{name}: not in the demos folder"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("{name}: {e}"))
    }

    fn write_meta(&self, m: &Meta) -> Result<(), String> {
        let text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
        self.ensure()?.write_atomic(&meta_name(&m.id), text.as_bytes())
    }

    /// Every sidecar in the store, oldest first. A sidecar that cannot be read, or fails a check, is
    /// an error, so a sweep never runs on a partial list.
    pub fn metas(&self) -> Result<Vec<Meta>, String> {
        let Some(d) = self.dir()? else { return Ok(Vec::new()) };
        let mut out = Vec::new();
        for name in d.names()? {
            if let Some(id) = name.strip_suffix(".meta.json").filter(|id| is_id(id)) {
                out.push(self.read_meta(id)?);
            }
        }
        out.sort_by(|a, b| (&a.created_utc, &a.id).cmp(&(&b.created_utc, &b.id)));
        Ok(out)
    }

    /// Appends one event to the ledger through one checked handle, and flushes it to disk. A record
    /// cut off by a crash or a power loss is an incomplete last line; it is dropped first and the drop
    /// is recorded, so the next record does not run on from it into one line that reads as neither.
    /// A ledger that fails a check (a link, a hard link) is not written.
    fn log(&self, id: &str, event: &str, reason: Option<&str>) -> Result<(), String> {
        use std::io::{Read, Seek, SeekFrom};
        let (mut f, info) = self.ensure()?.open_file(LEDGER, handle::Mode::Write)?.ok_or("the ledger could not be created")?;
        let fail = |e: std::io::Error| format!("{LEDGER}: {e}");
        let mut lines = Vec::new();
        if info.size > 0 {
            let mut last = [0u8];
            f.seek(SeekFrom::End(-1)).and_then(|_| f.read_exact(&mut last)).map_err(fail)?;
            if last[0] != b'\n' {
                let mut text = Vec::new();
                f.seek(SeekFrom::Start(0)).and_then(|_| f.read_to_end(&mut text)).map_err(fail)?;
                let keep = text.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
                f.set_len(keep as u64).map_err(fail)?;
                let why = format!("an incomplete last record of {} bytes was dropped", text.len() - keep);
                lines.push(serde_json::json!({ "at": iso_utc(SystemTime::now()), "id": null, "event": "ledger_repaired", "reason": why }));
            }
        }
        lines.push(serde_json::json!({ "at": iso_utc(SystemTime::now()), "id": id, "event": event, "reason": reason }));
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        f.seek(SeekFrom::End(0)).map_err(fail)?;
        f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(fail)
    }

    /// Records a file the store would not touch, and why.
    fn refused(&self, name: &str, why: &str) {
        let _ = self.log(name, "refused", Some(why));
    }

    pub fn keeps(&self) -> Result<Vec<Keep>, String> {
        match self.dir()?.map(|d| d.read(KEEPS)).transpose()?.flatten() {
            Some(t) => serde_json::from_slice(&t).map_err(|e| format!("{KEEPS}: {e}")),
            None => Ok(Vec::new()),
        }
    }

    fn set_keeps(&self, keeps: &[Keep]) -> Result<(), String> {
        let text = serde_json::to_string(keeps).map_err(|e| e.to_string())?;
        self.ensure()?.write_atomic(KEEPS, text.as_bytes())
    }
}

fn dem_name(id: &str) -> String {
    format!("{id}.dem")
}
fn meta_name(id: &str) -> String {
    format!("{id}.meta.json")
}

/// `<yyyymmddThhmmZ>_<map>_<8 hex>`, as [`demo_id`] makes and local_import.py's ID_RE reads.
pub fn is_id(s: &str) -> bool {
    let b = s.as_bytes();
    let head = b.len() >= 25
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..13].iter().all(u8::is_ascii_digit)
        && &b[13..15] == b"Z_";
    let Some((map, sha)) = s.get(15..).and_then(|rest| rest.rsplit_once('_')) else { return false };
    head && !map.is_empty()
        && map.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        && sha.len() == 8
        && sha.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// The recording's start from a demo's id, to the minute: `<yyyymmddThhmmZ>_...` as
/// `yyyy-mm-ddThh:mm:00Z`. The id has passed [`is_id`], so the digits are there.
fn created_of_id(id: &str) -> String {
    format!("{}-{}-{}T{}:{}:00Z", &id[0..4], &id[4..6], &id[6..8], &id[9..11], &id[11..13])
}

/// The id a recorded demo is stored under. The map is lowercased with anything but letters, digits
/// and '_' turned to '_', as local_import.py does.
pub fn demo_id(created: SystemTime, map: &str, sha256: &str) -> String {
    let mut slug: String = map.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    slug = slug.trim_matches('_').to_string();
    if slug.is_empty() {
        slug = "unknown".into();
    }
    let (y, mo, d, h, mi, _) = civil(created);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}Z_{slug}_{}", &sha256[..8])
}

/// The map in a tv_autorecord name, `auto-<yyyymmdd>-<hhmm>-<map>-<server name>.dem`. Map names
/// hold no '-', so the map is the fourth part, whatever the server name holds.
pub fn map_of_auto_name(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".dem")?.strip_prefix("auto-")?;
    let mut parts = stem.splitn(4, '-');
    let (date, time, map) = (parts.next()?, parts.next()?, parts.next()?);
    let digits = |s: &str, n: usize| s.len() == n && s.bytes().all(|c| c.is_ascii_digit());
    (digits(date, 8) && digits(time, 4) && !map.is_empty()).then_some(map)
}

fn is_auto_demo(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("auto-") && lower.ends_with(".dem")
}

/// UTC (year, month, day, hour, minute, second) of a time, by the civil-from-days algorithm
/// (Howard Hinnant's), so no date crate is needed.
fn civil(t: SystemTime) -> (i64, u32, u32, u32, u32, u32) {
    let secs = t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32)
}

pub fn iso_utc(t: SystemTime) -> String {
    let (y, mo, d, h, mi, s) = civil(t);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `steam.inf`'s ClientVersion in the game folder: the build that recorded a demo taken now.
pub fn game_build(layout: &Layout) -> Option<String> {
    let text = fs::read_to_string(layout.csgo.join("steam.inf")).ok()?;
    text.lines().find_map(|l| l.trim().strip_prefix("ClientVersion=").map(|v| v.trim().to_string())).filter(|v| !v.is_empty())
}

/// What a take did. Demos are counted, never named: their names hold the Steam name.
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Taken {
    /// The ids of the demos moved into the store.
    pub taken: Vec<String>,
    /// Demos modified in the last [`SETTLE`], left for a later take.
    pub waiting: usize,
    /// Demos left because they are links, or could not be moved; why.
    pub refused: Vec<String>,
}

/// Moves every settled `auto-*.dem` in `game\csgo\replays` into the store, with CS2 closed and
/// the operation lock held. A demo already in the store (the same content under the same id) is
/// removed from `replays\`. A sidecar left without its demo stays for [`sweep`] to mark missing.
///
/// Each demo is opened once, shared with no one, and everything happens through that handle: the
/// checks, the hash, the move and the removal. CS2 writing it, or anything else holding it open,
/// makes the open fail, and the demo waits for a later take. CS2 is checked again right before
/// each move or removal. On one volume the handle is renamed into the store. Across volumes (a
/// Steam library on another drive) the demo is copied into a temporary file in the store, flushed,
/// checked against its hash and renamed into place; the original is deleted through its handle
/// only if CS2 is still closed. If CS2 has started, the original stays, the copy stands, and a later
/// take, finding the copy by its hash, removes the original.
pub fn take(store: &Store, layout: &Layout, probe: &dyn ProcessProbe, lock: &OpLock, now: SystemTime) -> Result<Taken, String> {
    take_with(store, layout, probe, lock, now, &|dir, f, name| dir.rename_into(f, name))
}

/// [`take`] with the move into the store as a parameter, so a test can have it report another volume.
fn take_with(store: &Store, layout: &Layout, probe: &dyn ProcessProbe, _lock: &OpLock, now: SystemTime, move_into: &dyn Fn(&handle::Dir, &fs::File, &str) -> std::io::Result<()>) -> Result<Taken, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let mut out = Taken::default();
    let replays = layout.csgo.join("replays");
    let rdir = match handle::Dir::open(&replays) {
        Ok(d) => d,
        Err(_) if fs::symlink_metadata(&replays).is_err() => return Ok(out),
        Err(e) => return Err(e),
    };
    let dir = store.ensure()?;
    adopt_orphans(store, dir)?;
    let build = game_build(layout);
    let mut names: Vec<String> = rdir.names()?.into_iter().filter(|n| is_auto_demo(n)).collect();
    names.sort();
    for name in names {
        // every message below names the demo by its place in the list, never by its name
        let which = format!("a recorded demo in {}", replays.display());
        let mut f = match handle::open_exclusive(&rdir.path().join(&name)) {
            Ok(f) => f,
            Err(e) if e.raw_os_error() == Some(handle::SHARING_VIOLATION) => {
                out.waiting += 1;
                continue;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                out.refused.push(format!("{which} could not be opened ({}); it was left where it is", e.kind()));
                continue;
            }
        };
        let info = match rdir.check(&f) {
            Ok(i) => i,
            Err(why) => {
                out.refused.push(format!("{which} {why}; it was left where it is"));
                continue;
            }
        };
        if now.duration_since(info.modified).unwrap_or_default() < SETTLE {
            out.waiting += 1;
            continue;
        }
        let Ok(sha) = handle::hash(&mut f) else {
            out.refused.push(format!("{which} could not be read; it was left where it is"));
            continue;
        };
        let map = map_of_auto_name(&name).unwrap_or("unknown");
        let id = demo_id(info.created, map, &sha);
        let dst = dem_name(&id);
        if dir.exists(&dst) {
            // the original goes only when the store's copy, opened and checked, hashes the same
            match kept_copy_matches(dir, &dst, &sha) {
                Ok(()) => {
                    ensure_cs2_closed(probe, Phase::Operation)?;
                    handle::delete(&f).map_err(|e| format!("{which}, already kept as {id}, could not be removed: {}", e.kind()))?;
                }
                Err(why) => {
                    store.refused(&dst, &format!("the original in replays\\ was kept: {why}"));
                    out.refused.push(format!("{which} has the id of {id}, but {why}; it was left where it is"));
                }
            }
            continue;
        }
        ensure_cs2_closed(probe, Phase::Operation)?;
        let meta = Meta {
            id: id.clone(),
            sha256: sha.clone(),
            dem_bytes: info.size,
            map: map.to_string(),
            created_utc: iso_utc(info.created),
            game_build: build.clone(),
            state: State::Taken,
            pinned: false,
            fail_reason: None,
            fail_detail: None,
            failed_versions: Vec::new(),
            kept: None,
        };
        match move_into(dir, &f, &dst) {
            Ok(()) => {
                store.write_meta(&meta)?;
                store.log(&id, "taken", None)?;
                out.taken.push(id);
            }
            Err(e) if e.raw_os_error() == Some(handle::NOT_SAME_DEVICE) => {
                if let Err(e) = copy_into(dir, &mut f, &id, &sha) {
                    out.refused.push(format!("{which} could not be copied into {} ({e}); it was left where it is", store.root.display()));
                    continue;
                }
                store.write_meta(&meta)?;
                store.log(&id, "taken", Some("copied from another volume"))?;
                out.taken.push(id.clone());
                // the copy stands either way; the original goes only while CS2 is closed
                ensure_cs2_closed(probe, Phase::Operation)?;
                if let Err(e) = handle::delete(&f) {
                    out.refused.push(format!("{which} was copied into the store as {id}, but the original could not be removed ({}); a later take removes it", e.kind()));
                }
            }
            Err(e) => out.refused.push(format!("{which} could not be moved into {} ({}); it was left where it is", store.root.display(), e.kind())),
        }
    }
    Ok(out)
}

/// Whether the store's `<id>.dem` is a copy of the demo hashing `sha`: opened and checked like every
/// store file, and hashed through that handle. A sidecar's hash is not trusted for this, since the
/// file beside it can have changed since.
fn kept_copy_matches(dir: &handle::Dir, dst: &str, sha: &str) -> Result<(), String> {
    let (mut f, _) = dir.open_file(dst, handle::Mode::Read)?.ok_or("the store's copy is gone")?;
    let got = handle::hash(&mut f).map_err(|e| format!("the store's copy could not be read ({})", e.kind()))?;
    if got == sha {
        Ok(())
    } else {
        Err("the store's copy holds other bytes".into())
    }
}

/// Copies the open demo `src` into the store as `<id>.dem`: a new temporary file, flushed, its hash
/// checked against `sha`, then renamed into place. On any failure the temporary file is deleted.
fn copy_into(dir: &handle::Dir, src: &mut fs::File, id: &str, sha: &str) -> Result<(), String> {
    let part = format!("{id}.dem.part");
    if dir.exists(&part) {
        dir.delete(&part)?;
    }
    let mut tmp = dir.create_new(&part)?;
    let done = handle::copy(src, &mut tmp)
        .map_err(|e| format!("copy: {}", e.kind()))
        .and_then(|(got, _)| if got == sha { Ok(()) } else { Err("the copy differs from the demo".to_string()) })
        .and_then(|_| dir.rename_into(&tmp, &dem_name(id)).map_err(|e| format!("{}: {}", dem_name(id), e.kind())));
    if done.is_err() {
        let _ = handle::delete(&tmp);
    }
    done
}

/// Tidies the store before a take. A demo with no sidecar (a take stopped between its move and its
/// sidecar) gets one from its id and file, read through a checked handle. A leftover temporary file
/// is deleted. A file that fails a check is left alone and recorded in the ledger.
fn adopt_orphans(store: &Store, dir: &handle::Dir) -> Result<(), String> {
    for name in dir.names()? {
        if name.ends_with(".dem.part") || name.ends_with(".tmp") {
            if let Err(why) = dir.delete(&name) {
                store.refused(&name, &why);
            }
            continue;
        }
        let Some(id) = name.strip_suffix(".dem").filter(|id| is_id(id)) else { continue };
        if dir.exists(&meta_name(id)) {
            continue;
        }
        let (mut f, info) = match dir.open_file(&name, handle::Mode::Read) {
            Ok(Some(x)) => x,
            Ok(None) => continue,
            Err(why) => {
                store.refused(&name, &why);
                continue;
            }
        };
        let sha = handle::hash(&mut f).map_err(|e| format!("{name}: {e}"))?;
        drop(f);
        let meta = Meta {
            id: id.to_string(),
            sha256: sha,
            dem_bytes: info.size,
            map: id[15..id.len() - 9].to_string(),
            // the file in the store can be a copy made after recording started (another volume), so
            // its creation time is not the recording's; the id holds the recording's minute
            created_utc: created_of_id(id),
            game_build: None,
            state: State::Taken,
            pinned: false,
            fail_reason: None,
            fail_detail: None,
            failed_versions: Vec::new(),
            kept: None,
        };
        store.write_meta(&meta)?;
        store.log(id, "taken", Some("sidecar rebuilt"))?;
    }
    Ok(())
}

/// The cap, floor and keep-last in bytes and counts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Policy {
    pub cap: u64,
    pub floor: u64,
    pub keep_last: usize,
}

impl Policy {
    pub fn of(s: &AppSettings) -> Policy {
        let bytes = |gb: f64| (gb.max(0.0) * GB as f64) as u64;
        Policy { cap: bytes(s.demo_cap_gb), floor: bytes(s.demo_floor_gb), keep_last: s.demo_keep_last as usize }
    }
}

/// What a sweep keeps (id to reason) and deletes (id and reason), in the order it deletes them, and
/// a breach of the cap or floor that only protected demos are left holding.
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct Plan {
    pub kept: BTreeMap<String, String>,
    pub delete: Vec<(String, String)>,
    pub held: Option<Held>,
}

/// The store is still over its cap, or the disk under the floor, after a sweep deleted everything it
/// may: what is left is pinned, not yet extracted, or waiting for a newer extractor, and a sweep
/// never deletes those. The floor stops the next recording; the card says which limit is breached.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub over_cap: bool,
    pub under_floor: bool,
}

/// Decides a sweep. `demos` are the sidecars (oldest first), `free` the bytes free on the store's
/// disk, `reserve` room to leave under the cap and above the floor (a launch is about to record),
/// `build` the game's current build and `extractor` the extractor's current version, when known.
pub fn plan_sweep(demos: &[Meta], keeps: &[Keep], policy: &Policy, free: u64, reserve: u64, build: Option<&str>, extractor: Option<&str>) -> Plan {
    let live: Vec<&Meta> = demos.iter().filter(|m| m.state != State::Missing).collect();
    let recent: Vec<&str> = live.iter().rev().take(policy.keep_last).map(|m| m.id.as_str()).collect();
    let retrying = |m: &Meta| m.state == State::Failed && m.failed_versions.len() == 1 && extractor.is_none_or(|v| m.failed_versions[0] == v);
    // never deleted by a sweep, whatever the cap and floor: the user's pins, and demos whose tables
    // do not exist yet (deleting one would lose its match)
    let protected = |m: &Meta| m.pinned || m.state == State::Taken || retrying(m);
    let reason = |m: &Meta| -> Option<String> {
        if m.pinned {
            return Some("pinned".into());
        }
        if let Some(k) = keeps.iter().find(|k| k.id == m.id) {
            return Some(k.reason.clone());
        }
        if recent.contains(&m.id.as_str()) {
            return Some("recent".into());
        }
        match m.state {
            State::Taken => Some("not extracted yet".into()),
            State::Failed if retrying(m) => Some("extraction failed; retried when the extractor changes".into()),
            _ => None,
        }
    };
    let mut plan = Plan::default();
    let mut used = 0u64;
    let mut free = free;
    let mut kept: Vec<&Meta> = Vec::new();
    for m in &live {
        match reason(m) {
            Some(r) => {
                plan.kept.insert(m.id.clone(), r);
                used += m.dem_bytes;
                kept.push(m);
            }
            None => {
                plan.delete.push((m.id.clone(), "no reason to keep it".into()));
                free = free.saturating_add(m.dem_bytes);
            }
        }
    }
    // Under pressure: only demos that are not protected, an older build before the current one,
    // then oldest.
    let old_build = |m: &Meta| build.is_some_and(|b| m.game_build.as_deref().is_some_and(|g| g != b));
    let mut order: Vec<&Meta> = kept.into_iter().filter(|m| !protected(m)).collect();
    order.sort_by_key(|m| (!old_build(m), m.created_utc.clone()));
    let breach = |used: u64, free: u64| (used + reserve > policy.cap, free < policy.floor + reserve);
    for m in order {
        let (over_cap, under_floor) = breach(used, free);
        if !over_cap && !under_floor {
            break;
        }
        plan.kept.remove(&m.id);
        let why = match (over_cap, old_build(m)) {
            (true, true) => "over the cap; an older game build",
            (true, false) => "over the cap",
            (false, true) => "under the free-space floor; an older game build",
            (false, false) => "under the free-space floor",
        };
        plan.delete.push((m.id.clone(), why.into()));
        used -= m.dem_bytes;
        free = free.saturating_add(m.dem_bytes);
    }
    let (over_cap, under_floor) = breach(used, free);
    plan.held = (over_cap || under_floor).then_some(Held { over_cap, under_floor });
    plan
}

/// Runs a sweep under the operation lock: marks demos deleted by hand as missing, then deletes
/// what [`plan_sweep`] says and records why each remaining demo stays. `keeps`, when given,
/// replaces the engine's list kept in the store (`keeps.json`); otherwise the last one is used.
pub fn sweep(store: &Store, _lock: &OpLock, policy: &Policy, keeps: Option<&[Keep]>, reserve: u64, build: Option<&str>, extractor: Option<&str>) -> Result<Plan, String> {
    if store.dir()?.is_none() {
        return Ok(Plan::default());
    }
    if let Some(k) = keeps {
        store.set_keeps(k)?;
    }
    let keeps = store.keeps()?;
    let mut metas = store.metas()?;
    for m in metas.iter_mut().filter(|m| m.state != State::Missing && !store.has_dem(&m.id)) {
        m.state = State::Missing;
        m.kept = None;
        store.write_meta(m)?;
        store.log(&m.id, "missing", None)?;
    }
    let free = free_bytes(&store.root)?;
    let plan = plan_sweep(&metas, &keeps, policy, free, reserve, build, extractor);
    for (id, why) in &plan.delete {
        remove(store, id, why)?;
    }
    for m in metas.iter_mut() {
        if let Some(r) = plan.kept.get(&m.id) {
            if m.kept.as_ref() != Some(r) {
                m.kept = Some(r.clone());
                store.write_meta(m)?;
                store.log(&m.id, "kept", Some(r))?;
            }
        }
    }
    Ok(plan)
}

fn remove(store: &Store, id: &str, why: &str) -> Result<(), String> {
    let Some(dir) = store.dir()? else { return Ok(()) };
    for name in [dem_name(id), meta_name(id)] {
        if let Err(e) = dir.delete(&name) {
            store.refused(&name, &e);
            return Err(e);
        }
    }
    store.log(id, "deleted", Some(why))
}

/// Pins or unpins a demo. A pinned demo is never deleted by a sweep.
pub fn pin(store: &Store, _lock: &OpLock, id: &str, on: bool) -> Result<Meta, String> {
    let mut m = store.read_meta(id)?;
    if m.pinned != on {
        m.pinned = on;
        store.write_meta(&m)?;
        store.log(id, if on { "pinned" } else { "unpinned" }, None)?;
    }
    Ok(m)
}

/// Deletes a demo the user chose, pinned or not. Its tables stay.
pub fn delete(store: &Store, _lock: &OpLock, id: &str) -> Result<(), String> {
    store.read_meta(id)?;
    remove(store, id, "deleted in the app")
}

/// Records an import's result for a demo it ran on: extracted, or failed with local_import.py's
/// reason ("no_rounds", "extract_failed"), its first error, and the extractor version that failed.
pub fn record_import(store: &Store, _lock: &OpLock, id: &str, ok: bool, reason: Option<&str>, detail: Option<&str>, extractor: &str) -> Result<(), String> {
    let mut m = store.read_meta(id)?;
    if ok {
        m.state = State::Extracted;
        (m.fail_reason, m.fail_detail) = (None, None);
        store.write_meta(&m)?;
        store.log(id, "extracted", None)
    } else {
        m.state = State::Failed;
        m.fail_reason = Some(reason.unwrap_or("extract_failed").to_string());
        m.fail_detail = detail.map(str::to_string);
        if !m.failed_versions.iter().any(|v| v == extractor) {
            m.failed_versions.push(extractor.to_string());
        }
        store.write_meta(&m)?;
        store.log(id, "failed", Some(&format!("{}: {}", m.fail_reason.as_deref().unwrap_or(""), detail.unwrap_or(""))))
    }
}

/// The demos an import should run on: not yet extracted, or failed with an older extractor than
/// `extractor` and not yet retried.
pub fn to_extract(store: &Store, extractor: &str) -> Result<Vec<String>, String> {
    Ok(store
        .metas()?
        .into_iter()
        .filter(|m| store.has_dem(&m.id))
        .filter(|m| match m.state {
            State::Taken => true,
            State::Failed => m.failed_versions.len() == 1 && m.failed_versions[0] != extractor,
            _ => false,
        })
        .map(|m| m.id)
        .collect())
}

/// Bytes free on the disk holding `path` (its nearest existing folder).
pub fn free_bytes(path: &Path) -> Result<u64, String> {
    let mut p = path;
    while !p.exists() {
        p = p.parent().ok_or_else(|| format!("{}: no existing folder to measure", path.display()))?;
    }
    free_on(p)
}

#[cfg(windows)]
fn free_on(p: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the other outputs may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 {
        return Err(format!("{}: free space could not be read ({})", p.display(), std::io::Error::last_os_error()));
    }
    Ok(free)
}

#[cfg(not(windows))]
fn free_on(p: &Path) -> Result<u64, String> {
    Err(format!("{}: free space is only read on Windows", p.display()))
}

/// Whether the next launch records, and why not.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    /// The setting.
    pub on: bool,
    /// What the launch adds: [`TOKENS`], or nothing when recording is off or blocked.
    pub tokens: Vec<String>,
    /// Why a launch with recording on will not record this time, for the launch dialog.
    pub blocked: Option<String>,
    pub free: Option<u64>,
    pub floor: u64,
}

/// "9.4", "10": GB rounded down to one decimal, none when whole, so free space never reads as more than it is.
pub fn gb(bytes: u64) -> String {
    let tenths = (bytes as f64 / GB as f64 * 10.0).floor() as u64;
    if tenths % 10 == 0 { format!("{}", tenths / 10) } else { format!("{}.{}", tenths / 10, tenths % 10) }
}

/// A GOTV setting Steam's stored launch options mention, in any form: `+tv_enable 1`,
/// `-TV_AUTORECORD`, a quoted `"+tv_enable 0"`, with any value or none. Steam adds those options
/// after the app's, so whatever they set wins over [`TOKENS`]. Their values are not read: Bot Mode
/// never records half on, and never edits Steam's options, so a launch with one records nothing and
/// says which.
pub fn steam_conflict(steam_options: &str) -> Option<&'static str> {
    let lower = steam_options.to_ascii_lowercase();
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    ["tv_enable", "tv_autorecord", "tv_maxclients"].into_iter().find(|name| {
        lower.match_indices(name).any(|(i, _)| !word(lower[..i].chars().next_back()) && !word(lower[i + name.len()..].chars().next()))
    })
}

/// The launch records when the setting is on, Steam's stored launch options (`steam_options`, when
/// they could be read) do not undo the recording, and the disk has the floor plus [`RESERVE`] free.
/// Otherwise the launch goes ahead without [`TOKENS`], and `blocked` says why.
pub fn recording(s: &AppSettings, free: Result<u64, String>, steam_options: Option<&str>) -> Recording {
    let floor = Policy::of(s).floor;
    let mut r = Recording { on: s.record_demos, tokens: Vec::new(), blocked: None, free: free.as_ref().ok().copied(), floor };
    if !s.record_demos {
        return r;
    }
    if let Some(c) = steam_options.and_then(steam_conflict) {
        r.blocked = Some(format!("Recording off this time: your Steam launch options set {c}."));
        return r;
    }
    match free {
        Err(e) => r.blocked = Some(format!("Recording off this time: free space could not be read ({e}).")),
        Ok(f) if f < floor => r.blocked = Some(format!("Recording off this time: {} GB free, floor {} GB.", gb(f), gb(floor))),
        Ok(f) if f < floor + RESERVE => {
            r.blocked = Some(format!("Recording off this time: {} GB free, and a match needs {} GB above the {} GB floor.", gb(f), gb(RESERVE), gb(floor)))
        }
        Ok(_) => r.tokens = TOKENS.map(String::from).to_vec(),
    }
    r
}

/// Free space for a launch: the less of the disk CS2 records to (`replays\`) and the store's.
pub fn launch_free(layout: &Layout) -> Result<u64, String> {
    let replays = free_bytes(&layout.csgo.join("replays"))?;
    let store = free_bytes(&Store::of(layout)?.root)?;
    Ok(replays.min(store))
}

/// The store as the Data & settings card shows it.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DemoStore {
    pub folder: String,
    pub used: u64,
    pub cap: u64,
    pub floor: u64,
    pub free: Option<u64>,
    pub free_error: Option<String>,
    pub keep_last: usize,
    pub recording: bool,
    pub demos: Vec<DemoRow>,
    /// The newest failed extraction: which demo and why.
    pub last_failure: Option<Failure>,
    /// Over the cap or under the floor with nothing left a sweep may delete ([`Held`]); None otherwise.
    pub held: Option<Held>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DemoRow {
    pub id: String,
    pub map: String,
    pub created_utc: String,
    pub size: u64,
    pub state: State,
    pub pinned: bool,
    pub game_build: Option<String>,
    pub fail_reason: Option<String>,
    pub fail_detail: Option<String>,
    pub kept: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub id: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
}

/// Reads the store; writes nothing.
pub fn status(store: &Store, s: &AppSettings) -> Result<DemoStore, String> {
    let p = Policy::of(s);
    let metas = store.metas()?;
    let (free, free_error) = match free_bytes(&store.root) {
        Ok(f) => (Some(f), None),
        Err(e) => (None, Some(e)),
    };
    let present = |m: &Meta| m.state != State::Missing && store.has_dem(&m.id);
    let last_failure = metas.iter().rev().find(|m| m.state == State::Failed).map(|m| Failure { id: m.id.clone(), reason: m.fail_reason.clone(), detail: m.fail_detail.clone() });
    // what a sweep now would leave; with free space unknown, only the cap is judged
    let live: Vec<Meta> = metas.iter().filter(|m| present(m)).cloned().collect();
    let held = plan_sweep(&live, &store.keeps()?, &p, free.unwrap_or(u64::MAX), 0, None, None).held;
    Ok(DemoStore {
        held,
        folder: store.root.display().to_string(),
        used: metas.iter().filter(|m| present(m)).map(|m| m.dem_bytes).sum(),
        cap: p.cap,
        floor: p.floor,
        free,
        free_error,
        keep_last: p.keep_last,
        recording: s.record_demos,
        last_failure,
        demos: metas
            .into_iter()
            .rev()
            .map(|m| DemoRow {
                state: if m.state != State::Missing && !store.has_dem(&m.id) { State::Missing } else { m.state },
                id: m.id,
                map: m.map,
                created_utc: m.created_utc,
                size: m.dem_bytes,
                pinned: m.pinned,
                game_build: m.game_build,
                fail_reason: m.fail_reason,
                fail_detail: m.fail_detail,
                kept: m.kept,
            })
            .collect(),
    })
}

// ---------------------------------------------------------------- commands

/// The store and settings with no game folder at hand: both live under the Bot Mode folder's parent.
fn app_store() -> Result<(Store, AppSettings), String> {
    let data = crate::botmode::paths::default_data_dir()?;
    let settings = crate::botmode::settings::load_app_in(&data)?;
    let base = data.parent().ok_or("the Bot Mode folder has no parent")?;
    Ok((Store::in_base(base)?, settings))
}

/// Runs `f` with CS2 found through Steam and the operation lock held, off the UI thread, then returns
/// the store as the card shows it.
async fn with_lock(f: impl FnOnce(&crate::botmode::Ctx, &Store, &OpLock) -> Result<(), String> + Send + 'static) -> Result<DemoStore, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = crate::botmode::Ctx::new(crate::botmode::Game::Steam, None)?;
        let store = Store::of(&ctx.layout)?;
        {
            let lock = OpLock::acquire(&ctx.layout)?;
            f(&ctx, &store, &lock)?;
        }
        status(&store, &crate::botmode::settings::load_app(&ctx.layout)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn demos_status() -> Result<DemoStore, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (store, s) = app_store()?;
        status(&store, &s)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the cap, floor and keep-last and returns the store as the card shows it. `update_app` takes
/// the operation lock for the write, so this holds none: taking it twice in one process fails, since
/// the lock file is opened shared with no one.
fn set_policy(layout: &Layout, policy: crate::botmode::settings::DemoPolicy, seen: Option<crate::botmode::settings::DemoPolicy>) -> Result<DemoStore, String> {
    let s = crate::botmode::settings::set_demo_policy(layout, policy, seen)?;
    status(&Store::of(layout)?, &s)
}

/// `seen` is the policy the card showed; refused when it has changed since.
#[tauri::command]
pub async fn demos_set_policy(policy: crate::botmode::settings::DemoPolicy, seen: Option<crate::botmode::settings::DemoPolicy>) -> Result<DemoStore, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = crate::botmode::Ctx::new(crate::botmode::Game::Steam, None)?;
        set_policy(&ctx.layout, policy, seen)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn demos_pin(id: String, on: bool) -> Result<DemoStore, String> {
    with_lock(move |_, store, lock| pin(store, lock, &id, on).map(|_| ())).await
}

#[tauri::command]
pub async fn demos_delete(id: String) -> Result<DemoStore, String> {
    with_lock(move |_, store, lock| delete(store, lock, &id)).await
}

/// The engine's keeps (demos with an unrendered clip-worthy moment), then a sweep.
#[tauri::command]
pub async fn demos_sweep(keeps: Vec<Keep>) -> Result<DemoStore, String> {
    with_lock(move |ctx, store, lock| {
        let s = crate::botmode::settings::load_app(&ctx.layout)?;
        sweep(store, lock, &Policy::of(&s), Some(&keeps), 0, game_build(&ctx.layout).as_deref(), None).map(|_| ())
    })
    .await
}

/// `%APPDATA%\BotMatchStats\local` (CS2_LOCAL_MATCHES overrides it): local_import.py's tables, one
/// folder per demo id, in the extractor's versioned layout.
pub fn local_dir() -> Result<PathBuf, String> {
    if let Some(d) = crate::env_path("CS2_LOCAL_MATCHES")? {
        return Ok(d);
    }
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join("local"))
}

#[derive(Serialize)]
pub struct LocalListing {
    folder: String,
    files: Vec<crate::FileEntry>,
    skipped: Vec<crate::Skipped>,
}

/// Every recorded demo's tables whose CURRENT version is complete, as "local/<id>/<version>". The
/// recording player is in each match's `extra.pov`, so no user file comes with them.
pub fn list_local_in(root: &Path) -> Result<LocalListing, String> {
    let (files, skipped) = crate::list_tables_in(root, "local", "recorded demos")?;
    Ok(LocalListing { folder: root.display().to_string(), files, skipped })
}

#[tauri::command]
pub async fn list_local() -> Result<LocalListing, String> {
    list_local_in(&local_dir()?)
}

#[tauri::command]
pub async fn read_local(path: String) -> Result<tauri::ipc::Response, String> {
    crate::read_tables_in(&local_dir()?, &path, "recorded demos").map(tauri::ipc::Response::new)
}

/// What an import did: the take, then the importer's run (none when nothing needed extracting).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalImport {
    /// None when nothing could be taken from `replays\` this time (CS2 running, say); `take_error` says why.
    pub taken: Option<Taken>,
    pub take_error: Option<String>,
    pub extracted: Vec<String>,
    pub failed: Vec<String>,
    pub code: Option<i32>,
    /// Why extraction did not run or did not finish: the importer is missing, or it failed. The
    /// take and the sweep still ran.
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Default)]
pub struct LocalImportState {
    running: bool,
    at: Option<serde_json::Value>,
    last: Option<LocalImport>,
}

static LOCAL: std::sync::Mutex<LocalImportState> = std::sync::Mutex::new(LocalImportState { running: false, at: None, last: None });

fn local_state() -> std::sync::MutexGuard<'static, LocalImportState> {
    LOCAL.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn local_import_state() -> LocalImportState {
    local_state().clone()
}

/// One import of recorded demos at a time, across processes: the app's (at start, or the command)
/// and a Bot Mode supervisor's at session end. A file in the Bot Mode folder opened with no sharing,
/// as [`OpLock`] is; the OS closes it when the holder dies.
struct ImportLock(#[allow(dead_code)] fs::File);

impl ImportLock {
    fn acquire(layout: &Layout) -> Result<ImportLock, String> {
        fs::create_dir_all(&layout.data).map_err(|e| format!("{}: {e}", layout.data.display()))?;
        let path = layout.data.join("demos-import.lock");
        let mut opts = fs::OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::share_mode(&mut opts, 0);
        match opts.open(&path) {
            Ok(f) => Ok(ImportLock(f)),
            // ERROR_SHARING_VIOLATION: another import holds it
            Err(e) if e.raw_os_error() == Some(32) => Err("an import of recorded demos is already running".into()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }
}

/// The operation lock, waited for up to five seconds: at app start, Bot Mode's own session cleanup
/// takes it at the same moment.
fn op_lock_soon(layout: &Layout) -> Result<OpLock, String> {
    let mut last = String::new();
    for _ in 0..20 {
        match OpLock::acquire(layout) {
            Ok(l) => return Ok(l),
            Err(e) => last = e,
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(last)
}

/// Takes finished recordings out of `replays\` (only with CS2 closed), runs extractor/local_import.py
/// on every demo not yet extracted (or failed under an older extractor), records each result, and
/// sweeps. It runs at app start ([`on_app_start`]), when a Bot Mode session ends with CS2 exited (the
/// supervisor, botmode/cli.rs), and from the `import_local` command. Without the importer the take
/// and the sweep still run, so recorded demos never pile up in `replays\` or past the cap; `error`
/// says why nothing was extracted. Until the app sends its keeps (`demos_sweep`), the sweep keeps
/// pinned, unextracted, failed-once and the newest demos, under the cap and above the floor.
pub fn run_import(layout: &Layout, probe: &dyn ProcessProbe, progress: &dyn Fn(serde_json::Value)) -> Result<LocalImport, String> {
    run_import_with(layout, probe, &|| crate::Extractor::find("local_import.py"), progress)
}

/// [`run_import`] with the importer lookup as a parameter, so a test can run it without one.
fn run_import_with(layout: &Layout, probe: &dyn ProcessProbe, find: &dyn Fn() -> Result<crate::Extractor, String>, progress: &dyn Fn(serde_json::Value)) -> Result<LocalImport, String> {
    let _import = ImportLock::acquire(layout)?;
    let store = Store::of(layout)?;
    let take_result = op_lock_soon(layout).and_then(|lock| take(&store, layout, probe, &lock, SystemTime::now()));
    let (taken, take_error) = match take_result {
        Ok(t) => (Some(t), None),
        Err(e) => (None, Some(e)),
    };
    let mut out = LocalImport { taken, take_error, extracted: Vec::new(), failed: Vec::new(), code: None, error: None };
    let version = match find().and_then(|x| x.version().map(|v| (x, v))) {
        Ok((x, version)) => {
            if let Err(e) = extract(&store, layout, &x, &version, progress, &mut out) {
                out.error = Some(e);
            }
            Some(version)
        }
        Err(e) => {
            out.error = Some(e);
            None
        }
    };
    let lock = op_lock_soon(layout)?;
    let s = crate::botmode::settings::load_app(layout)?;
    sweep(&store, &lock, &Policy::of(&s), None, 0, game_build(layout).as_deref(), version.as_deref())?;
    Ok(out)
}

/// Runs the importer on the demos [`to_extract`] names and records each one's result.
fn extract(store: &Store, layout: &Layout, x: &crate::Extractor, version: &str, progress: &dyn Fn(serde_json::Value), out: &mut LocalImport) -> Result<(), String> {
    let ids = to_extract(store, version)?;
    if ids.is_empty() {
        return Ok(());
    }
    let mut args: Vec<std::ffi::OsString> = vec!["--out".into(), local_dir()?.into()];
    if let Some(m) = &x.mapdata {
        args.extend(["--mapdata".into(), m.clone().into_os_string()]);
    }
    // a demo with more than one human is the user's by the SteamID64 the Valve import saved
    if let Ok(Some(user)) = crate::valve_dir().and_then(|d| crate::valve_user(&d)) {
        args.extend(["--user".into(), user.into()]);
    }
    // each demo passes the store's checks before the importer is given its path
    let mut paths = Vec::new();
    for id in &ids {
        match store.dem_checked(id) {
            Ok(p) => paths.push(p.into_os_string()),
            Err(why) => store.refused(&dem_name(id), &why),
        }
    }
    if paths.is_empty() {
        return Ok(());
    }
    args.extend(paths);
    let run = x.run(&args, progress)?;
    let rows = run.summary.as_ref().and_then(|s| s.get("results")).and_then(|r| r.as_array()).cloned().unwrap_or_default();
    let lock = op_lock_soon(layout)?;
    for row in rows {
        let Some(id) = row.get("demo").and_then(|d| d.as_str()).filter(|id| ids.iter().any(|x| x == id)) else { continue };
        let ok = row.get("ok").and_then(|v| v.as_bool()) == Some(true);
        let reason = row.get("reason").and_then(|v| v.as_str());
        let detail = row.get("errors").and_then(|e| e.get(0)).and_then(|e| e.as_str());
        record_import(store, &lock, id, ok, reason, detail, version)?;
        if ok {
            out.extracted.push(id.to_string());
        } else {
            out.failed.push(id.to_string());
        }
    }
    out.code = run.code;
    out.error = run.error;
    Ok(())
}

/// [`run_import`] in the app's process, with its state kept for `local_import_state` and its progress
/// sent as "local-import-progress" events.
fn run_tracked(app: &tauri::AppHandle) -> Result<LocalImport, String> {
    use tauri::Emitter;
    {
        let mut s = local_state();
        if s.running {
            return Err("an import of recorded demos is already running".into());
        }
        s.running = true;
        s.at = None;
    }
    let result = crate::botmode::Ctx::new(crate::botmode::Game::Steam, None).and_then(|ctx| {
        run_import(&ctx.layout, &crate::botmode::process::SystemProbe, &|ev| {
            local_state().at = Some(ev.clone());
            let _ = app.emit("local-import-progress", ev);
        })
    });
    let mut s = local_state();
    s.running = false;
    if let Ok(r) = &result {
        s.last = Some(r.clone());
    }
    result
}

/// The import the app runs at start, off the UI thread, for demos a session left in `replays\` or
/// the store while the app was closed.
pub fn on_app_start(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new().name("demos-import".into()).spawn(move || {
        let _ = run_tracked(&app);
    });
}

#[tauri::command]
pub async fn import_local(app: tauri::AppHandle) -> Result<LocalImport, String> {
    tauri::async_runtime::spawn_blocking(move || run_tracked(&app)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::botmode::hash;
    use crate::botmode::process::fake::Running;
    use crate::botmode::testutil::{fake_game, junction, write, Scratch};

    const CLOSED: Running = Running(false);
    // tv_autorecord's name shape: the server name, on a listen server the host's Steam name, comes last
    const AUTO: &str = "auto-20261025-0335-de_dust2-Some-vs-the-persona.dem";

    fn later() -> SystemTime {
        SystemTime::now() + Duration::from_secs(120)
    }

    fn meta(id: &str, created: &str, bytes: u64, build: &str, state: State) -> Meta {
        Meta {
            id: id.into(),
            sha256: "0".repeat(64),
            dem_bytes: bytes,
            map: "de_dust2".into(),
            created_utc: created.into(),
            game_build: Some(build.into()),
            state,
            pinned: false,
            fail_reason: None,
            fail_detail: None,
            failed_versions: Vec::new(),
            kept: None,
        }
    }

    fn policy(cap_gb: u64, floor_gb: u64, keep_last: usize) -> Policy {
        Policy { cap: cap_gb * GB, floor: floor_gb * GB, keep_last }
    }

    fn all_files(root: &Path) -> String {
        let mut out = String::new();
        for e in fs::read_dir(root).unwrap() {
            let p = e.unwrap().path();
            out.push_str(&p.file_name().unwrap().to_string_lossy());
            out.push('\n');
            if p.extension().is_some_and(|x| x == "json" || x == "jsonl") {
                out.push_str(&fs::read_to_string(&p).unwrap());
            }
        }
        out
    }

    #[test]
    fn a_taken_demo_is_stored_under_an_id_that_carries_nothing_of_its_original_name() {
        let s = Scratch::new("demos-take");
        let layout = fake_game(&s);
        write(&layout.target(&format!("replays/{AUTO}")), b"a recorded match");
        write(&layout.target("steam.inf"), b"ClientVersion=2000935\r\nServerVersion=2000935\r\n");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        let t = take(&store, &layout, &CLOSED, &lock, later()).unwrap();
        assert_eq!((t.taken.len(), t.waiting, t.refused.len()), (1, 0, 0));
        let id = &t.taken[0];
        assert!(is_id(id) && id.contains("_de_dust2_") && id.ends_with(&hash::bytes(b"a recorded match")[..8]), "{id}");
        assert!(!layout.target(&format!("replays/{AUTO}")).exists());
        assert_eq!(fs::read(store.dem(id)).unwrap(), b"a recorded match");
        let m = store.read_meta(id).unwrap();
        assert_eq!((m.state, m.game_build.as_deref(), m.dem_bytes), (State::Taken, Some("2000935"), 16));
        assert!(!all_files(&store.root).to_lowercase().contains("persona"));
    }

    #[test]
    fn a_demo_still_being_written_is_left_and_nothing_is_taken_while_cs2_runs() {
        let s = Scratch::new("demos-wait");
        let layout = fake_game(&s);
        let src = layout.target(&format!("replays/{AUTO}"));
        write(&src, b"recording");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        let t = take(&store, &layout, &CLOSED, &lock, SystemTime::now()).unwrap();
        assert_eq!((t.taken.len(), t.waiting), (0, 1));
        assert!(take(&store, &layout, &Running(true), &lock, later()).unwrap_err().contains("CS2 is running"));
        assert!(src.exists());
    }

    #[test]
    fn demos_are_never_taken_through_a_junction() {
        let s = Scratch::new("demos-junction");
        let layout = fake_game(&s);
        let elsewhere = s.0.join("elsewhere");
        write(&elsewhere.join(AUTO), b"not the game's");
        junction(&layout.target("replays"), &elsewhere);
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        assert!(take(&store, &layout, &CLOSED, &lock, later()).unwrap_err().contains("is a junction or link"));
        assert!(elsewhere.join(AUTO).exists());

        // nor kept in a store folder that is one
        fs::remove_dir(layout.target("replays")).unwrap();
        write(&layout.target(&format!("replays/{AUTO}")), b"a recorded match");
        junction(&store.root, &elsewhere);
        assert!(take(&store, &layout, &CLOSED, &lock, later()).unwrap_err().contains("is a junction or link"));
        assert!(layout.target(&format!("replays/{AUTO}")).exists());
    }

    #[test]
    fn a_sweep_deletes_what_nothing_keeps_then_older_builds_then_the_oldest_and_never_a_pinned_demo() {
        let d = |day: u32, build: &str| meta(&format!("202611{day:02}T1200Z_de_dust2_0000000{day}"), &format!("2026-11-{day:02}T12:00:00Z"), 4 * GB, build, State::Extracted);
        let mut demos = vec![d(1, "100"), d(2, "200"), d(3, "100"), d(4, "200"), d(5, "200")];
        demos[0].pinned = true;
        let keeps = vec![Keep { id: demos[1].id.clone(), reason: "moment".into() }];
        // keep-last 2 keeps d and e; c has no reason; a is pinned, b has a moment
        let plan = plan_sweep(&demos, &keeps, &policy(100, 10, 2), 500 * GB, 0, Some("200"), None);
        assert_eq!(plan.delete, [(demos[2].id.clone(), "no reason to keep it".to_string())]);
        assert_eq!(plan.kept.get(&demos[1].id).map(String::as_str), Some("moment"));
        // a 9 GB cap leaves room for two of the four kept: the pinned one stays whatever it costs
        let plan = plan_sweep(&demos, &keeps, &policy(9, 10, 2), 500 * GB, 0, Some("200"), None);
        let deleted: Vec<&str> = plan.delete.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(deleted, [&demos[2].id, &demos[1].id, &demos[3].id]);
        assert_eq!(plan.kept.keys().collect::<Vec<_>>(), [&demos[0].id, &demos[4].id]);
        // an older build goes first even when it is newer: on build 100, d goes before b
        demos[3].game_build = Some("100".into());
        let plan = plan_sweep(&demos, &keeps, &policy(13, 10, 2), 500 * GB, 0, Some("200"), None);
        let deleted: Vec<&str> = plan.delete.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(deleted, [&demos[2].id, &demos[3].id]);
        assert_eq!(plan.delete[1].1, "over the cap; an older game build");
    }

    #[test]
    fn under_pressure_a_sweep_frees_space_but_never_takes_a_demo_whose_tables_do_not_exist_yet() {
        // fails if an unextracted demo, or a failed one waiting for a newer extractor, can be evicted to
        // meet the cap or floor (its match would be lost), or a breach only they hold goes unreported
        let a = meta("20261101T1200Z_de_dust2_00000001", "2026-11-01T12:00:00Z", 2 * GB, "200", State::Taken);
        let b = meta("20261102T1200Z_de_dust2_00000002", "2026-11-02T12:00:00Z", 2 * GB, "200", State::Extracted);
        let mut c = meta("20261103T1200Z_de_dust2_00000003", "2026-11-03T12:00:00Z", 2 * GB, "200", State::Failed);
        c.failed_versions = vec!["1.18.0".into()];
        let plan = plan_sweep(&[a.clone(), b.clone()], &[], &policy(20, 10, 10), 9 * GB, 0, Some("200"), None);
        assert_eq!((plan.delete, plan.held), (vec![(b.id.clone(), "under the free-space floor".to_string())], None));
        // the extracted one goes, and the floor is still not met: nothing else is deleted, and it says so
        let plan = plan_sweep(&[a.clone(), b.clone(), c.clone()], &[], &policy(20, 10, 10), 5 * GB, 0, Some("200"), Some("1.18.0"));
        assert_eq!(plan.delete, [(b.id.clone(), "under the free-space floor".to_string())]);
        assert_eq!(plan.held, Some(Held { over_cap: false, under_floor: true }));
        assert!(plan.kept.contains_key(&a.id) && plan.kept.contains_key(&c.id));
        // a launch's reserve counts against the cap; over it with only an unextracted demo, nothing goes
        let plan = plan_sweep(&[a.clone()], &[], &policy(1, 0, 10), 100 * GB, RESERVE, Some("200"), None);
        assert_eq!((plan.delete.len(), plan.held), (0, Some(Held { over_cap: true, under_floor: false })));
        // once the extractor has changed, the failed demo is retried, not protected: it can go
        let plan = plan_sweep(&[c.clone()], &[], &policy(1, 0, 0), 100 * GB, 0, None, Some("1.19.0"));
        assert_eq!(plan.delete.len(), 1);
    }

    #[test]
    fn the_card_hears_of_a_breach_only_protected_demos_hold() {
        let s = Scratch::new("demos-held");
        let layout = fake_game(&s);
        let store = Store::of(&layout).unwrap();
        stored(&store, "20261101T1200Z_de_dust2_00000001", State::Taken);
        let tight = AppSettings { demo_cap_gb: 1.0, demo_floor_gb: 0.0, ..AppSettings::default() };
        // the sidecar's size is what a sweep counts: say the demo takes 2 GB
        let mut m = store.read_meta("20261101T1200Z_de_dust2_00000001").unwrap();
        m.dem_bytes = 2 * GB;
        store.write_meta(&m).unwrap();
        assert_eq!(status(&store, &tight).unwrap().held, Some(Held { over_cap: true, under_floor: false }));
        assert_eq!(status(&store, &AppSettings { demo_floor_gb: 0.0, ..AppSettings::default() }).unwrap().held, None);
    }

    #[test]
    fn a_failed_extraction_is_kept_and_retried_once_after_the_extractor_changes() {
        let s = Scratch::new("demos-failed");
        let layout = fake_game(&s);
        write(&layout.target(&format!("replays/{AUTO}")), b"cut off in warmup");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        let id = take(&store, &layout, &CLOSED, &lock, later()).unwrap().taken.remove(0);
        assert_eq!(to_extract(&store, "1.18.0").unwrap(), [id.clone()]);
        record_import(&store, &lock, &id, false, Some("no_rounds"), Some("RuntimeError: no round_end events after match start"), "1.18.0").unwrap();
        assert!(to_extract(&store, "1.18.0").unwrap().is_empty());
        let keep_none = policy(20, 0, 0);
        let failed = store.metas().unwrap();
        assert!(plan_sweep(&failed, &[], &keep_none, 500 * GB, 0, None, Some("1.18.0")).delete.is_empty());
        assert_eq!(to_extract(&store, "1.19.0").unwrap(), [id.clone()]);
        record_import(&store, &lock, &id, false, Some("no_rounds"), None, "1.19.0").unwrap();
        assert!(to_extract(&store, "1.20.0").unwrap().is_empty());
        let twice = store.metas().unwrap();
        assert_eq!(plan_sweep(&twice, &[], &keep_none, 500 * GB, 0, None, Some("1.19.0")).delete.len(), 1);
    }

    #[test]
    fn a_demo_deleted_by_hand_is_marked_missing_and_no_longer_counted() {
        let s = Scratch::new("demos-missing");
        let layout = fake_game(&s);
        write(&layout.target(&format!("replays/{AUTO}")), b"a recorded match");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        let id = take(&store, &layout, &CLOSED, &lock, later()).unwrap().taken.remove(0);
        fs::remove_file(store.dem(&id)).unwrap();
        sweep(&store, &lock, &policy(20, 0, 10), None, 0, None, None).unwrap();
        let st = status(&store, &AppSettings::default()).unwrap();
        assert_eq!((st.used, st.demos[0].state), (0, State::Missing));
        assert!(fs::read_to_string(ledger(&store)).unwrap().contains("\"missing\""));
    }

    #[test]
    fn recording_needs_the_floor_plus_a_match_free_and_says_why_it_is_off() {
        let s = AppSettings::default();
        // free space is shown rounded down to the tenth, so it never reads as more than there is
        let r = recording(&s, Ok(94 * GB / 10 + GB / 20), None);
        assert_eq!((r.tokens.len(), r.blocked.as_deref()), (0, Some("Recording off this time: 9.4 GB free, floor 10 GB.")));
        let r = recording(&s, Ok(10 * GB + GB / 2), None);
        assert_eq!(r.blocked.as_deref(), Some("Recording off this time: 10.5 GB free, and a match needs 1 GB above the 10 GB floor."));
        let r = recording(&s, Ok(11 * GB), None);
        assert_eq!((r.tokens, r.blocked), (TOKENS.map(String::from).to_vec(), None));
        let off = AppSettings { record_demos: false, ..AppSettings::default() };
        assert_eq!((recording(&off, Ok(500 * GB), None).tokens.len(), recording(&off, Ok(0), None).blocked), (0, None));
    }

    #[test]
    fn recording_is_on_with_the_users_limits_for_settings_saved_before_it_existed() {
        let s: AppSettings = serde_json::from_str(r#"{"launchOptions":"-novid"}"#).unwrap();
        assert_eq!((s.record_demos, s.demo_cap_gb, s.demo_floor_gb, s.demo_keep_last), (true, 20.0, 10.0, 10));
    }

    #[test]
    fn the_id_is_the_utc_minute_the_map_and_the_hash_as_local_import_writes_it() {
        // 1784431150 is 2026-07-19T03:19:10Z
        let t = UNIX_EPOCH + Duration::from_secs(1_784_431_150);
        assert_eq!(demo_id(t, "Workshop/De Mirage!", &"ab".repeat(32)), "20260719T0319Z_workshop_de_mirage_abababab");
        assert_eq!(iso_utc(t), "2026-07-19T03:19:10Z");
        assert_eq!(map_of_auto_name(AUTO), Some("de_dust2"));
        assert!(is_id("20260719T0319Z_de_dust2_abababab") && !is_id("20260719T0319Z_de-dust2_abababab") && !is_id(AUTO));
    }

    #[test]
    fn recorded_matches_are_listed_under_their_own_prefix() {
        let s = Scratch::new("demos-list");
        let v = "v-1.18.0-0123abcd";
        let dir = s.0.join("20261025T0835Z_de_dust2_abababab");
        write(&dir.join("CURRENT"), v.as_bytes());
        write(&dir.join(v).join("match.parquet"), b"abc");
        write(&dir.join(v).join("COMPLETE"), br#"{"match.parquet": 3}"#);
        let l = list_local_in(&s.0).unwrap();
        assert_eq!(l.files.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(), [format!("local/20261025T0835Z_de_dust2_abababab/{v}")]);
    }

    /// A demo in the store as a take leaves it: the file and its sidecar.
    fn stored(store: &Store, id: &str, state: State) {
        write(&store.dem(id), b"a demo");
        store.write_meta(&meta(id, "2026-11-01T12:00:00Z", 6, "200", state)).unwrap();
    }

    fn ledger(store: &Store) -> PathBuf {
        store.root.join(LEDGER)
    }

    /// A file symlink at `link`, or where Windows does not let this account make one, a junction:
    /// both are reparse points, which the store must not follow.
    fn reparse_at(link: &Path, file: &Path) {
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(file, link).is_ok() {
            return;
        }
        junction(link, file.parent().unwrap());
    }

    #[test]
    fn a_junction_above_the_store_is_allowed_and_its_file_checks_still_hold_but_one_at_the_store_is_refused() {
        // fails if a store under a relocated AppData (a junction above demos\) is refused, if a
        // junction at demos\ itself is followed, or if a hard-linked sidecar is read as the store's own
        let s = Scratch::new("demos-store-junction");
        let layout = fake_game(&s);
        let elsewhere = s.0.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        junction(&s.0.join("demos"), &elsewhere);
        let e = Store::of(&layout).err().expect("a junctioned demos folder is refused");
        assert!(e.contains("is a junction or link"), "{e}");

        let real = s.0.join("real");
        fs::create_dir_all(real.join("data")).unwrap();
        junction(&s.0.join("linked"), &real);
        let moved = Layout { csgo: layout.csgo.clone(), data: s.0.join("linked").join("data") };
        let store = Store::of(&moved).expect("a junction above the store is allowed");
        let id = "20261101T1200Z_de_dust2_00000001";
        stored(&store, id, State::Extracted);
        assert_eq!(store.read_meta(id).unwrap().id, id);
        assert!(real.join("demos").join(dem_name(id)).exists());

        let outside = s.0.join("outside.json");
        fs::write(&outside, serde_json::to_string(&meta(id, "2026-11-02T12:00:00Z", 9, "200", State::Extracted)).unwrap()).unwrap();
        fs::remove_file(real.join("demos").join(meta_name(id))).unwrap();
        fs::hard_link(&outside, real.join("demos").join(meta_name(id))).unwrap();
        let e = store.read_meta(id).unwrap_err();
        assert!(e.contains("hard links"), "{e}");
        assert!(delete(&store, &OpLock::acquire(&moved).unwrap(), id).is_err());
        assert!(outside.exists() && real.join("demos").join(dem_name(id)).exists());
    }

    #[test]
    fn a_hard_linked_ledger_is_never_written() {
        // fails if the ledger is opened by its path and appended to: the record lands in the other file
        let s = Scratch::new("demos-ledger-link");
        let layout = fake_game(&s);
        let store = Store::of(&layout).unwrap();
        store.ensure().unwrap();
        let outside = s.0.join("notes.txt");
        fs::write(&outside, b"the user's own file\n").unwrap();
        fs::hard_link(&outside, ledger(&store)).unwrap();
        let e = store.log("20261101T1200Z_de_dust2_00000001", "taken", None).unwrap_err();
        assert!(e.contains("hard links"), "{e}");
        assert_eq!(fs::read(&outside).unwrap(), b"the user's own file\n");
    }

    #[test]
    fn a_linked_orphan_demo_is_left_alone_and_recorded() {
        // fails if an orphan .dem is read by its path: a link there would get a sidecar for, and later
        // a sweep's delete of, a file outside the store
        let s = Scratch::new("demos-orphan-link");
        let layout = fake_game(&s);
        fs::create_dir_all(layout.target("replays")).unwrap();
        let store = Store::of(&layout).unwrap();
        store.ensure().unwrap();
        let outside = s.0.join("elsewhere").join("keep.dem");
        write(&outside, b"not a demo of the store's");
        let id = "20261101T1200Z_de_dust2_00000001";
        reparse_at(&store.dem(id), &outside);
        let lock = OpLock::acquire(&layout).unwrap();
        take(&store, &layout, &CLOSED, &lock, later()).unwrap();
        assert!(store.metas().unwrap().is_empty());
        assert!(fs::read_to_string(ledger(&store)).unwrap().contains("\"refused\""));
        assert_eq!(fs::read(&outside).unwrap(), b"not a demo of the store's");
    }

    /// CS2 closed for the first `closed` checks, then running.
    struct StartsAfter(std::sync::atomic::AtomicUsize, usize);
    impl ProcessProbe for StartsAfter {
        fn cs2_running(&self, _phase: Phase) -> Result<bool, String> {
            Ok(self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= self.1)
        }
    }
    fn starts_after(closed: usize) -> StartsAfter {
        StartsAfter(std::sync::atomic::AtomicUsize::new(0), closed)
    }

    /// A demo in `replays\` whose last write is two minutes old.
    fn settled(layout: &Layout, bytes: &[u8]) -> PathBuf {
        let src = layout.target(&format!("replays/{AUTO}"));
        write(&src, bytes);
        fs::File::options().write(true).open(&src).unwrap().set_modified(SystemTime::now() - Duration::from_secs(120)).unwrap();
        src
    }

    #[test]
    fn a_demo_another_program_holds_open_waits_and_a_cs2_started_meanwhile_stops_the_take() {
        // fails if a take opens the demo shared (it would move a demo CS2 is still writing), or checks
        // CS2 only once (it would move a demo out from under a CS2 that started during the take)
        let s = Scratch::new("demos-held");
        let layout = fake_game(&s);
        let src = settled(&layout, b"recording");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        let held = fs::File::options().append(true).open(&src).unwrap();
        let t = take(&store, &layout, &CLOSED, &lock, SystemTime::now()).unwrap();
        assert_eq!((t.taken.len(), t.waiting), (0, 1));
        drop(held);
        assert!(src.exists() && store.metas().unwrap().is_empty());

        assert!(take(&store, &layout, &starts_after(1), &lock, SystemTime::now()).unwrap_err().contains("CS2 is running"));
        assert!(src.exists() && store.metas().unwrap().is_empty());
    }

    /// A move that finds the store on another volume, as a Steam library on another drive does.
    fn other_volume(_: &handle::Dir, _: &fs::File, _: &str) -> std::io::Result<()> {
        Err(std::io::Error::from_raw_os_error(handle::NOT_SAME_DEVICE))
    }

    #[test]
    fn across_volumes_a_demo_is_copied_and_its_original_removed_only_while_cs2_stays_closed() {
        // fails if the original is removed without checking CS2 after the copy, or the copy is not
        // checked and renamed into place, or a later take does not finish the job
        let s = Scratch::new("demos-cross");
        let layout = fake_game(&s);
        let src = settled(&layout, b"a recorded match");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        let t = take_with(&store, &layout, &CLOSED, &lock, SystemTime::now(), &other_volume).unwrap();
        assert_eq!(t.taken.len(), 1);
        assert!(!src.exists());
        assert_eq!(fs::read(store.dem(&t.taken[0])).unwrap(), b"a recorded match");
        assert!(!all_files(&store.root).contains(".part"));

        // CS2 starts during the copy: the copy stands and the original stays
        let s = Scratch::new("demos-cross-start");
        let layout = fake_game(&s);
        let src = settled(&layout, b"a recorded match");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        let e = take_with(&store, &layout, &starts_after(2), &lock, SystemTime::now(), &other_volume).unwrap_err();
        assert!(e.contains("CS2 is running"), "{e}");
        let kept = store.metas().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(store.dem(&kept[0].id)).unwrap(), b"a recorded match");
        assert!(src.exists());
        // with CS2 closed, the next take finds the copy by its hash and removes the original
        let t = take_with(&store, &layout, &CLOSED, &lock, SystemTime::now(), &other_volume).unwrap();
        assert_eq!((t.taken.len(), t.refused.len()), (0, 0));
        assert!(!src.exists());
        assert_eq!(store.metas().unwrap().len(), 1);
    }

    #[test]
    fn a_ledger_record_cut_off_by_a_crash_is_dropped_and_the_drop_recorded() {
        // fails if the next record is appended after the cut-off one: the two run into one line that
        // parses as neither
        let s = Scratch::new("demos-ledger");
        let layout = fake_game(&s);
        let store = Store::of(&layout).unwrap();
        store.ensure().unwrap();
        fs::write(ledger(&store), "{\"at\":\"2026-11-01T12:00:00Z\",\"id\":\"a\",\"event\":\"taken\",\"reason\":null}\n{\"at\":\"2026-11").unwrap();
        store.log("20261101T1200Z_de_dust2_00000001", "extracted", None).unwrap();
        let text = fs::read_to_string(ledger(&store)).unwrap();
        let events: Vec<String> = text.lines().map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["event"].as_str().unwrap().to_string()).collect();
        assert_eq!(events, ["taken", "ledger_repaired", "extracted"]);
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn a_take_removes_the_original_only_when_the_stores_copy_hashes_the_same() {
        // fails if a take trusts the sidecar's hash over the file beside it: a copy that changed, or a
        // hard link standing in for it, would cost the only good copy of the demo
        let s = Scratch::new("demos-dedupe");
        let layout = fake_game(&s);
        let src = settled(&layout, b"a recorded match");
        let store = Store::of(&layout).unwrap();
        let lock = OpLock::acquire(&layout).unwrap();
        // CS2 starts during a copy from another volume: the copy and its sidecar stand, the original stays
        take_with(&store, &layout, &starts_after(2), &lock, SystemTime::now(), &other_volume).unwrap_err();
        let id = store.metas().unwrap().remove(0).id;
        fs::write(store.dem(&id), b"a recorded matcX").unwrap();
        let t = take_with(&store, &layout, &CLOSED, &lock, SystemTime::now(), &other_volume).unwrap();
        assert!(src.exists(), "the original must stay while the store's copy differs");
        assert!(t.refused[0].contains("other bytes"), "{:?}", t.refused);
        assert!(fs::read_to_string(ledger(&store)).unwrap().contains("\"refused\""));

        // a hard link in place of the copy is refused before it is read
        fs::remove_file(store.dem(&id)).unwrap();
        let elsewhere = s.0.join("same-bytes.dem");
        fs::write(&elsewhere, b"a recorded match").unwrap();
        fs::hard_link(&elsewhere, store.dem(&id)).unwrap();
        let t = take_with(&store, &layout, &CLOSED, &lock, SystemTime::now(), &other_volume).unwrap();
        assert!(src.exists() && t.refused[0].contains("hard links"), "{:?}", t.refused);

        // the real copy back: now the original goes
        fs::remove_file(store.dem(&id)).unwrap();
        fs::write(store.dem(&id), b"a recorded match").unwrap();
        let t = take_with(&store, &layout, &CLOSED, &lock, SystemTime::now(), &other_volume).unwrap();
        assert!(!src.exists() && t.refused.is_empty(), "{:?}", t.refused);
    }

    #[test]
    fn an_orphan_demo_gets_its_recording_time_from_its_id() {
        // fails if the sidecar takes the store file's creation time: a copy from another volume, or a
        // file restored by hand, is created after the match was recorded
        let s = Scratch::new("demos-orphan-time");
        let layout = fake_game(&s);
        fs::create_dir_all(layout.target("replays")).unwrap();
        let store = Store::of(&layout).unwrap();
        let id = "20261101T1205Z_de_dust2_00000001";
        write(&store.dem(id), b"a demo");
        take(&store, &layout, &CLOSED, &OpLock::acquire(&layout).unwrap(), later()).unwrap();
        assert_eq!(store.read_meta(id).unwrap().created_utc, "2026-11-01T12:05:00Z");
    }

    #[test]
    fn a_policy_set_from_the_card_is_saved() {
        // fails if saving takes the operation lock that the settings write takes again: the lock file
        // is opened shared with no one, so the second open fails and nothing is ever saved
        let s = Scratch::new("demos-policy");
        let layout = fake_game(&s);
        let p = crate::botmode::settings::DemoPolicy { cap_gb: 7.5, floor_gb: 3.0, keep_last: 4 };
        let shown = AppSettings::default().demo_policy();
        let st = set_policy(&layout, p, Some(shown)).unwrap();
        assert_eq!((st.cap, st.floor, st.keep_last), ((7.5 * GB as f64) as u64, 3 * GB, 4));
        assert_eq!(crate::botmode::settings::load_app(&layout).unwrap().demo_policy(), p);
        // what the card showed has changed since: refused, and the saved policy stays
        assert!(set_policy(&layout, crate::botmode::settings::DemoPolicy { keep_last: 9, ..p }, Some(shown)).is_err());
        assert_eq!(crate::botmode::settings::load_app(&layout).unwrap().demo_keep_last, 4);
    }

    #[test]
    fn steam_options_that_mention_gotv_in_any_form_turn_recording_off_and_say_which() {
        // fails if Steam's stored options are not read, or only some forms are: Steam adds them after
        // the app's tokens, so "-tv_enable" or a quoted "+tv_enable 0" there leaves recording half on
        // while the dialog says it is on
        let s = AppSettings::default();
        let r = recording(&s, Ok(500 * GB), Some("-novid \"+tv_enable 0\""));
        assert_eq!((r.tokens.len(), r.blocked.as_deref()), (0, Some("Recording off this time: your Steam launch options set tv_enable.")));
        assert_eq!(steam_conflict("-novid -tv_enable"), Some("tv_enable"));
        assert_eq!(steam_conflict("+TV_AUTORECORD false"), Some("tv_autorecord"));
        assert_eq!(steam_conflict("+tv_maxclients=5"), Some("tv_maxclients"));
        // even the app's own values: the options are not parsed, so none is trusted
        assert_eq!(steam_conflict("+tv_enable 1"), Some("tv_enable"));
        // a longer name that only starts like one is another setting
        assert_eq!(steam_conflict("-novid +tv_enable_cheats 1 +fps_max 0"), None);
        assert_eq!(recording(&s, Ok(500 * GB), Some("-novid")).tokens.len(), TOKENS.len());
    }

    #[test]
    fn without_the_importer_an_import_still_takes_the_demos_and_sweeps() {
        // fails if a missing importer stops the import before its take and sweep: with recording on by
        // default, demos would pile up in replays\ and past the cap
        let s = Scratch::new("demos-no-importer");
        let layout = fake_game(&s);
        crate::botmode::settings::set_demo_policy(&layout, crate::botmode::settings::DemoPolicy { cap_gb: 20.0, floor_gb: 0.0, keep_last: 0 }, None).unwrap();
        write(&layout.target(&format!("replays/{AUTO}")), b"a recorded match");
        let store = Store::of(&layout).unwrap();
        let old = "20261101T1200Z_de_dust2_00000001";
        stored(&store, old, State::Extracted);
        let settled = SystemTime::now() - Duration::from_secs(120);
        fs::File::options().write(true).open(layout.target(&format!("replays/{AUTO}"))).unwrap().set_modified(settled).unwrap();
        let r = run_import_with(&layout, &CLOSED, &|| Err("The importer is not installed".into()), &|_| {}).unwrap();
        assert_eq!(r.error.as_deref(), Some("The importer is not installed"));
        let taken = r.taken.unwrap().taken;
        assert_eq!(taken.len(), 1);
        // the new demo is kept until it is extracted; the extracted one nothing keeps is gone
        let left: Vec<String> = store.metas().unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(left, taken);
        assert!(!store.dem(old).exists());
    }
}
