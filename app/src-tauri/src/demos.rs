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
//! out of the game folder also needs CS2 closed. The store's paths are checked like the Valve
//! folder's: a junction in `replays\` or in the store is refused.

use crate::botmode::hash;
use crate::botmode::paths::{is_reparse, Layout};
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

/// The store folder and its files.
pub struct Store {
    pub root: PathBuf,
}

impl Store {
    /// `demos\` beside the Bot Mode folder: `%APPDATA%\BotMatchStats\demos`.
    pub fn of(layout: &Layout) -> Result<Store, String> {
        let parent = layout.data.parent().ok_or_else(|| format!("{}: no parent folder for the demos", layout.data.display()))?;
        Ok(Store { root: parent.join("demos") })
    }
    pub fn dem(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.dem"))
    }
    fn meta_path(&self, id: &str) -> PathBuf {
        self.root.join(format!("{id}.meta.json"))
    }
    fn ledger(&self) -> PathBuf {
        self.root.join("ledger.jsonl")
    }
    fn keeps_file(&self) -> PathBuf {
        self.root.join("keeps.json")
    }

    /// The store folder, created if missing; refused when it is a junction or link.
    fn ensure(&self) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| format!("{}: {e}", self.root.display()))?;
        let m = fs::symlink_metadata(&self.root).map_err(|e| format!("{}: {e}", self.root.display()))?;
        if is_reparse(&m) {
            return Err(format!("{} is a junction or link; demos are not kept through one", self.root.display()));
        }
        Ok(())
    }

    pub fn read_meta(&self, id: &str) -> Result<Meta, String> {
        if !is_id(id) {
            return Err(format!("{id}: not a demo id"));
        }
        let p = self.meta_path(id);
        let text = fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", p.display()))
    }

    fn write_meta(&self, m: &Meta) -> Result<(), String> {
        let text = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
        crate::botmode::changes::write_atomic(&self.meta_path(&m.id), text.as_bytes())
    }

    /// Every sidecar in the store, oldest first. A sidecar that cannot be read is an error, so a
    /// sweep never runs on a partial list.
    pub fn metas(&self) -> Result<Vec<Meta>, String> {
        let mut out = Vec::new();
        let items = match fs::read_dir(&self.root) {
            Ok(i) => i,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
            Err(e) => return Err(format!("{}: {e}", self.root.display())),
        };
        for item in items {
            let item = item.map_err(|e| format!("{}: {e}", self.root.display()))?;
            let name = item.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".meta.json").filter(|id| is_id(id)) {
                out.push(self.read_meta(id)?);
            }
        }
        out.sort_by(|a, b| (&a.created_utc, &a.id).cmp(&(&b.created_utc, &b.id)));
        Ok(out)
    }

    fn log(&self, id: &str, event: &str, reason: Option<&str>) -> Result<(), String> {
        let line = serde_json::json!({ "at": iso_utc(SystemTime::now()), "id": id, "event": event, "reason": reason });
        let p = self.ledger();
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .and_then(|mut f| writeln!(f, "{line}"))
            .map_err(|e| format!("{}: {e}", p.display()))
    }

    pub fn keeps(&self) -> Result<Vec<Keep>, String> {
        match fs::read_to_string(self.keeps_file()) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| format!("{}: {e}", self.keeps_file().display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("{}: {e}", self.keeps_file().display())),
        }
    }

    fn set_keeps(&self, keeps: &[Keep]) -> Result<(), String> {
        let text = serde_json::to_string(keeps).map_err(|e| e.to_string())?;
        crate::botmode::changes::write_atomic(&self.keeps_file(), text.as_bytes())
    }
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
pub fn take(store: &Store, layout: &Layout, probe: &dyn ProcessProbe, _lock: &OpLock, now: SystemTime) -> Result<Taken, String> {
    ensure_cs2_closed(probe, Phase::Operation)?;
    let mut out = Taken::default();
    let replays = layout.csgo.join("replays");
    let rm = match fs::symlink_metadata(&replays) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("{}: {e}", replays.display())),
    };
    if is_reparse(&rm) || !rm.is_dir() {
        return Err(format!("{} is a junction, link or file; demos are not taken from it", replays.display()));
    }
    store.ensure()?;
    adopt_orphans(store)?;
    let build = game_build(layout);
    let mut names: Vec<String> = fs::read_dir(&replays)
        .map_err(|e| format!("{}: {e}", replays.display()))?
        .filter_map(|i| i.ok().map(|i| i.file_name().to_string_lossy().into_owned()))
        .filter(|n| is_auto_demo(n))
        .collect();
    names.sort();
    for name in names {
        let src = replays.join(&name);
        // every message below names the demo by its place in the list, never by its name
        let which = format!("a recorded demo in {}", replays.display());
        let m = match fs::symlink_metadata(&src) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if is_reparse(&m) {
            out.refused.push(format!("{which} is a link; it was left where it is"));
            continue;
        }
        if !m.is_file() {
            continue;
        }
        let modified = m.modified().unwrap_or(now);
        if now.duration_since(modified).unwrap_or_default() < SETTLE {
            out.waiting += 1;
            continue;
        }
        let sha = match hash::file(&src) {
            Ok(s) => s,
            Err(_) => {
                out.refused.push(format!("{which} could not be read; it was left where it is"));
                continue;
            }
        };
        let map = map_of_auto_name(&name).unwrap_or("unknown");
        let created = m.created().unwrap_or(modified);
        let id = demo_id(created, map, &sha);
        let dst = store.dem(&id);
        if dst.exists() {
            if store.read_meta(&id).is_ok_and(|have| have.sha256 == sha) {
                fs::remove_file(&src).map_err(|e| format!("{which}, already kept as {id}, could not be removed: {}", e.kind()))?;
            } else {
                out.refused.push(format!("{which} has the id of a different demo, {id}; it was left where it is"));
            }
            continue;
        }
        if let Err(e) = move_into(&src, &dst, &sha) {
            out.refused.push(format!("{which} could not be moved into {} ({e}); it was left where it is", store.root.display()));
            continue;
        }
        let meta = Meta {
            id: id.clone(),
            sha256: sha,
            dem_bytes: m.len(),
            map: map.to_string(),
            created_utc: iso_utc(created),
            game_build: build.clone(),
            state: State::Taken,
            pinned: false,
            fail_reason: None,
            fail_detail: None,
            failed_versions: Vec::new(),
            kept: None,
        };
        store.write_meta(&meta)?;
        store.log(&id, "taken", None)?;
        out.taken.push(id);
    }
    Ok(out)
}

/// A rename, which keeps the creation time and is instant on one volume. Across volumes (a Steam
/// library on another drive) the demo is copied beside its target, checked against its hash, put
/// in place, and only then removed from `replays\`. Errors say what failed, never the source name.
fn move_into(src: &Path, dst: &Path, sha: &str) -> Result<(), String> {
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    let part = dst.with_extension("dem.part");
    let copied = fs::copy(src, &part).map_err(|e| format!("copy: {}", e.kind())).and_then(|_| {
        let got = hash::file(&part).map_err(|_| "the copy could not be read back".to_string())?;
        if got == sha {
            Ok(())
        } else {
            Err("the copy differs from the demo".to_string())
        }
    });
    if let Err(e) = copied {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, dst).map_err(|e| format!("{}: {e}", dst.display()))?;
    fs::remove_file(src).map_err(|e| format!("the copy is kept, but the original could not be removed: {}", e.kind()))
}

/// A demo in the store with no sidecar (a take stopped between its move and its sidecar) gets one
/// from its id and file; a leftover `.part` copy is deleted.
fn adopt_orphans(store: &Store) -> Result<(), String> {
    for item in fs::read_dir(&store.root).map_err(|e| format!("{}: {e}", store.root.display()))? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if name.ends_with(".dem.part") {
            let _ = fs::remove_file(item.path());
            continue;
        }
        let Some(id) = name.strip_suffix(".dem").filter(|id| is_id(id)) else { continue };
        if store.meta_path(id).exists() {
            continue;
        }
        let m = fs::metadata(item.path()).map_err(|e| format!("{}: {e}", item.path().display()))?;
        let created = m.created().or_else(|_| m.modified()).unwrap_or(UNIX_EPOCH);
        let map = id[15..id.len() - 9].to_string();
        let meta = Meta {
            id: id.to_string(),
            sha256: hash::file(&item.path())?,
            dem_bytes: m.len(),
            map,
            created_utc: iso_utc(created),
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

/// What a sweep keeps (id to reason) and deletes (id and reason), in the order it deletes them.
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct Plan {
    pub kept: BTreeMap<String, String>,
    pub delete: Vec<(String, String)>,
}

/// Decides a sweep. `demos` are the sidecars (oldest first), `free` the bytes free on the store's
/// disk, `reserve` room to leave under the cap and above the floor (a launch is about to record),
/// `build` the game's current build and `extractor` the extractor's current version, when known.
pub fn plan_sweep(demos: &[Meta], keeps: &[Keep], policy: &Policy, free: u64, reserve: u64, build: Option<&str>, extractor: Option<&str>) -> Plan {
    let live: Vec<&Meta> = demos.iter().filter(|m| m.state != State::Missing).collect();
    let recent: Vec<&str> = live.iter().rev().take(policy.keep_last).map(|m| m.id.as_str()).collect();
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
            State::Failed if m.failed_versions.len() == 1 && extractor.is_none_or(|v| m.failed_versions[0] == v) => {
                Some("extraction failed; retried when the extractor changes".into())
            }
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
                free += m.dem_bytes;
            }
        }
    }
    // Under pressure: not pinned, extracted before not yet extracted, an older build before the
    // current one, then oldest.
    let old_build = |m: &Meta| build.is_some_and(|b| m.game_build.as_deref().is_some_and(|g| g != b));
    let mut order: Vec<&Meta> = kept.into_iter().filter(|m| !m.pinned).collect();
    order.sort_by_key(|m| (m.state == State::Taken, !old_build(m), m.created_utc.clone()));
    for m in order {
        let over_cap = used + reserve > policy.cap;
        let under_floor = free < policy.floor + reserve;
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
        free += m.dem_bytes;
    }
    plan
}

/// Runs a sweep under the operation lock: marks demos deleted by hand as missing, then deletes
/// what [`plan_sweep`] says and records why each remaining demo stays. `keeps`, when given,
/// replaces the engine's list kept in the store (`keeps.json`); otherwise the last one is used.
pub fn sweep(store: &Store, _lock: &OpLock, policy: &Policy, keeps: Option<&[Keep]>, reserve: u64, build: Option<&str>, extractor: Option<&str>) -> Result<Plan, String> {
    if !store.root.exists() {
        return Ok(Plan::default());
    }
    store.ensure()?;
    if let Some(k) = keeps {
        store.set_keeps(k)?;
    }
    let keeps = store.keeps()?;
    let mut metas = store.metas()?;
    for m in metas.iter_mut().filter(|m| m.state != State::Missing && !store.dem(&m.id).exists()) {
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
    let dem = store.dem(id);
    if let Ok(m) = fs::symlink_metadata(&dem) {
        if is_reparse(&m) {
            return Err(format!("{} is a link; it was not deleted", dem.display()));
        }
        fs::remove_file(&dem).map_err(|e| format!("{}: {e}", dem.display()))?;
    }
    fs::remove_file(store.meta_path(id)).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
        .map_err(|e| format!("{}: {e}", store.meta_path(id).display()))?;
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
        .filter(|m| store.dem(&m.id).exists())
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

/// The launch records when the setting is on and the disk has the floor plus [`RESERVE`] free.
/// Otherwise the launch goes ahead without [`TOKENS`], and `blocked` says why.
pub fn recording(s: &AppSettings, free: Result<u64, String>) -> Recording {
    let floor = Policy::of(s).floor;
    let mut r = Recording { on: s.record_demos, tokens: Vec::new(), blocked: None, free: free.as_ref().ok().copied(), floor };
    if !s.record_demos {
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
    let present = |m: &Meta| m.state != State::Missing && store.dem(&m.id).exists();
    let last_failure = metas.iter().rev().find(|m| m.state == State::Failed).map(|m| Failure { id: m.id.clone(), reason: m.fail_reason.clone(), detail: m.fail_detail.clone() });
    Ok(DemoStore {
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
                state: if m.state != State::Missing && !store.dem(&m.id).exists() { State::Missing } else { m.state },
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
    let root = data.parent().ok_or("the Bot Mode folder has no parent")?.join("demos");
    Ok((Store { root }, settings))
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

/// `seen` is the policy the card showed; refused when it has changed since.
#[tauri::command]
pub async fn demos_set_policy(policy: crate::botmode::settings::DemoPolicy, seen: Option<crate::botmode::settings::DemoPolicy>) -> Result<DemoStore, String> {
    with_lock(move |ctx, _, _| crate::botmode::settings::set_demo_policy(&ctx.layout, policy, seen).map(|_| ())).await
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

/// What `import_local` did: the take, then the importer's run (none when nothing needed extracting).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalImport {
    /// None when nothing could be taken from `replays\` this time (CS2 running, say); `take_error` says why.
    pub taken: Option<Taken>,
    pub take_error: Option<String>,
    pub extracted: Vec<String>,
    pub failed: Vec<String>,
    pub code: Option<i32>,
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

/// Takes finished recordings out of `replays\` (only with CS2 closed), runs extractor/local_import.py
/// on every demo not yet extracted (or failed under an older extractor), records each result, and
/// sweeps. The app calls it at start and when a Bot Mode session ends. Progress lines go out as
/// "local-import-progress" events.
#[tauri::command]
pub async fn import_local(app: tauri::AppHandle) -> Result<LocalImport, String> {
    use tauri::Emitter;
    {
        let mut s = local_state();
        if s.running {
            return Err("an import of recorded demos is already running".into());
        }
        s.running = true;
        s.at = None;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        let ctx = crate::botmode::Ctx::new(crate::botmode::Game::Steam, None)?;
        let store = Store::of(&ctx.layout)?;
        let probe = crate::botmode::process::SystemProbe;
        let take_result = OpLock::acquire(&ctx.layout).and_then(|lock| take(&store, &ctx.layout, &probe, &lock, SystemTime::now()));
        let (taken, take_error) = match take_result {
            Ok(t) => (Some(t), None),
            Err(e) => (None, Some(e)),
        };
        let mut out = LocalImport { taken, take_error, extracted: Vec::new(), failed: Vec::new(), code: None, error: None };
        let x = crate::Extractor::find("local_import.py")?;
        let version = x.version()?;
        let ids = to_extract(&store, &version)?;
        if !ids.is_empty() {
            let mut args: Vec<std::ffi::OsString> = vec!["--out".into(), local_dir()?.into()];
            if let Some(m) = &x.mapdata {
                args.extend(["--mapdata".into(), m.clone().into_os_string()]);
            }
            // a demo with more than one human is the user's by the SteamID64 the Valve import saved
            if let Ok(Some(user)) = crate::valve_dir().and_then(|d| crate::valve_user(&d)) {
                args.extend(["--user".into(), user.into()]);
            }
            args.extend(ids.iter().map(|id| store.dem(id).into_os_string()));
            let run = x.run(&args, &|ev| {
                local_state().at = Some(ev.clone());
                let _ = app.emit("local-import-progress", ev);
            })?;
            let rows = run.summary.as_ref().and_then(|s| s.get("results")).and_then(|r| r.as_array()).cloned().unwrap_or_default();
            let lock = OpLock::acquire(&ctx.layout)?;
            for row in rows {
                let Some(id) = row.get("demo").and_then(|d| d.as_str()).filter(|id| ids.iter().any(|x| x == id)) else { continue };
                let ok = row.get("ok").and_then(|v| v.as_bool()) == Some(true);
                let reason = row.get("reason").and_then(|v| v.as_str());
                let detail = row.get("errors").and_then(|e| e.get(0)).and_then(|e| e.as_str());
                record_import(&store, &lock, id, ok, reason, detail, &version)?;
                if ok {
                    out.extracted.push(id.to_string());
                } else {
                    out.failed.push(id.to_string());
                }
            }
            out.code = run.code;
            out.error = run.error;
        }
        let lock = OpLock::acquire(&ctx.layout)?;
        let s = crate::botmode::settings::load_app(&ctx.layout)?;
        sweep(&store, &lock, &Policy::of(&s), None, 0, game_build(&ctx.layout).as_deref(), Some(&version))?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let mut s = local_state();
    s.running = false;
    if let Ok(r) = &result {
        s.last = Some(r.clone());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(take(&store, &layout, &CLOSED, &lock, later()).unwrap_err().contains("junction"));
        assert!(elsewhere.join(AUTO).exists());

        // nor kept in a store folder that is one
        fs::remove_dir(layout.target("replays")).unwrap();
        write(&layout.target(&format!("replays/{AUTO}")), b"a recorded match");
        junction(&store.root, &elsewhere);
        assert!(take(&store, &layout, &CLOSED, &lock, later()).unwrap_err().contains("junction"));
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
    fn under_the_floor_a_sweep_frees_space_and_an_unextracted_demo_goes_last() {
        let a = meta("20261101T1200Z_de_dust2_00000001", "2026-11-01T12:00:00Z", 2 * GB, "200", State::Taken);
        let b = meta("20261102T1200Z_de_dust2_00000002", "2026-11-02T12:00:00Z", 2 * GB, "200", State::Extracted);
        let plan = plan_sweep(&[a.clone(), b.clone()], &[], &policy(20, 10, 10), 9 * GB, 0, Some("200"), None);
        assert_eq!(plan.delete, [(b.id.clone(), "under the free-space floor".to_string())]);
        // a launch's reserve counts against the cap and the floor
        let plan = plan_sweep(&[a, b.clone()], &[], &policy(4, 0, 10), 100 * GB, RESERVE, Some("200"), None);
        assert_eq!(plan.delete, [(b.id, "over the cap".to_string())]);
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
        assert!(fs::read_to_string(store.ledger()).unwrap().contains("\"missing\""));
    }

    #[test]
    fn recording_needs_the_floor_plus_a_match_free_and_says_why_it_is_off() {
        let s = AppSettings::default();
        // free space is shown rounded down to the tenth, so it never reads as more than there is
        let r = recording(&s, Ok(94 * GB / 10 + GB / 20));
        assert_eq!((r.tokens.len(), r.blocked.as_deref()), (0, Some("Recording off this time: 9.4 GB free, floor 10 GB.")));
        let r = recording(&s, Ok(10 * GB + GB / 2));
        assert_eq!(r.blocked.as_deref(), Some("Recording off this time: 10.5 GB free, and a match needs 1 GB above the 10 GB floor."));
        let r = recording(&s, Ok(11 * GB));
        assert_eq!((r.tokens, r.blocked), (TOKENS.map(String::from).to_vec(), None));
        let off = AppSettings { record_demos: false, ..AppSettings::default() };
        assert_eq!((recording(&off, Ok(500 * GB)).tokens.len(), recording(&off, Ok(0)).blocked), (0, None));
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
}
