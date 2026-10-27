//! Bot Mode sessions, each run by one dedicated supervisor process.
//!
//! `cs2-stats botmode supervise-session` is the only thing that turns Bot Mode on (the two
//! `gameinfo.gi` search paths). The app and the CLI start it detached, so closing either does
//! not affect it, and then read its progress from `session-status.json` in the app folder.
//! [`supervise_session`] is its whole life:
//! 1. take the session lease (`process::LockKind::Session`, a named mutex keyed to the game
//!    folder, which the OS releases when the process dies);
//! 2. record the session start time;
//! 3. turn Bot Mode on, with a session marker written first (see [`SessionMarker`]);
//! 4. ask Steam to start CS2;
//! 5. watch until the last CS2 of this install exits, ending the unsafe ones;
//! 6. turn Bot Mode off, if `gameinfo.gi` is still exactly what step 3 wrote;
//! 7. exit.
//!
//! "Supervised" means exactly "the lease is held". The supervisor does not recover from a
//! panic: release builds abort on panic, and the dead process frees the lease.
//!
//! Who owns Bot Mode. Other tools turn Bot Mode on too: ed0ard's CS2-Bot-Improver Panel keeps
//! it on for as long as the user wants it, by editing the same file. CS2 Stats turns Bot Mode
//! off on its own only where it knows the "on" is its own: a live supervisor that wrote it and
//! finds the file unchanged when CS2 exits. Nothing else is evidence. After a crash, the file
//! cannot say who wrote it: an identical rewrite on NTFS can keep the same modification time,
//! an in-place write keeps the file's identity, and a write by another tool with the same bytes
//! hashes the same. So [`cleanup`], which runs when the app starts and before every command that
//! changes anything, never turns Bot Mode off. When a session died with Bot Mode on, it raises
//! [`Cleanup::Recovery`] and the user decides with [`recover`]. When a CS2 runs with Bot Mode on
//! and no supervisor, it starts one in adopt mode, which watches that CS2 (ending it if unsafe)
//! and never writes `gameinfo.gi`.
//!
//! What this cannot cover, by its nature:
//! - The supervisor is killed (a crash, a reboot, Task Manager) between the write that turns
//!   Bot Mode on and the one that turns it off. Bot Mode stays on until the user answers the
//!   recovery prompt; a CS2 started from Steam before then is unprotected. [`UNPROTECTED`] is
//!   the notice the app shows about it.
//! - Another tool writing exactly the bytes a live session wrote, during that session. The
//!   supervisor cannot tell that write from its own and turns Bot Mode off when CS2 exits.
//! - A Steam launch of CS2 that was already queued (say, from the Steam client) when the
//!   supervisor turned Bot Mode on. It is watched like any other CS2 of this install, but it
//!   was not started by Bot Mode, so its options are whatever Steam had.
//! - A CS2 that starts between the supervisor's last process-list poll and its write that
//!   turns Bot Mode off. It may load the mod with nothing left watching it.
//! - Another program (Valve's updater, the Panel) rewriting `gameinfo.gi` at the same instant as
//!   any write here, the recovery answer included: the write compares the file's hash before
//!   writing and again just before renaming its new content into place
//!   (`ChangeSet::put_bytes_if_unchanged`). Windows has no atomic compare-and-swap for files, so
//!   that second check narrows the window to the moment between the check and the rename; it
//!   cannot close it.

use super::changes::{self, Kind, Meta, Status};
use super::gameinfo;
use super::hash;
use super::launch::{self, LaunchPlan};
use super::monitor::{self, Checked, Control, Event, Mode, Outcome, System};
use super::paths::Layout;
use super::process::{ensure_cs2_closed, session_held, LockKind, NamedLock, OpLock, Phase, ProcessProbe};
use super::steam::SteamConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// Shown with Bot Mode in the app and the CLI.
pub const UNPROTECTED: &str =
    "Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.";

/// Bot Mode is on and no session of this app wrote the current file.
pub const MANAGED_BY_OTHER_TOOL: &str = "Bot Mode is managed by another tool (left as is)";
/// Nothing was written to `gameinfo.gi`.
pub const NOT_CHANGED: &str = "Bot Mode was not changed";
/// The recovery prompt: a session died with Bot Mode on.
pub const RECOVERY: &str = "Bot Mode is on after CS2 Stats closed unexpectedly. If you didn't turn it on with another tool, turn it off. Leave it on to keep another tool's setting, such as the Bot-Improver Panel's.";

/// Records that a session of this app was turning Bot Mode on, in `bot-mode-session.json` in the
/// app folder. A launch writes it as `pending` right before its "on" write and marks it
/// `committed` once that write landed; its supervisor deletes it when the session ends. A marker
/// left behind means a session died in flight, nothing more: it is never taken as proof that the
/// current `gameinfo.gi` is that session's (see the module notes). It keeps the file as it was
/// before, so "Turn off Bot Mode" in the recovery prompt can restore it exactly.
///
/// A marker written before the last time CS2 Stats saw Bot Mode off (`bot-mode-off-seen.json`)
/// is stale: whatever that session wrote was undone since, so a later "on" is another tool's.
/// That keeps a marker that could not be deleted from ever raising the prompt for the Panel.
/// It relies on the system clock not running backwards between the two writes.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct SessionMarker {
    /// "pending" or "committed". Recovery treats both alike.
    state: String,
    run_id: String,
    /// Unix nanoseconds when the marker was written; 0 in markers from earlier builds of this
    /// branch, which then count as stale once Bot Mode has been seen off.
    #[serde(default)]
    written_at_ns: u64,
    before_hash: String,
    after_hash: String,
    before_content: String,
}

impl SessionMarker {
    /// The before-image is what its hash says, and has Bot Mode off. A marker an earlier build
    /// wrote for Bot Mode that was already on carried an empty before-image; restoring that would
    /// empty `gameinfo.gi`.
    fn is_sound(&self) -> bool {
        matches!(self.state.as_str(), "pending" | "committed")
            && hash::bytes(self.before_content.as_bytes()) == self.before_hash
            && gameinfo::is_bot_mode(&self.before_content) == Ok(false)
    }
}

pub(crate) fn marker_path(layout: &Layout) -> PathBuf {
    layout.data.join("bot-mode-session.json")
}

pub(crate) fn off_seen_path(layout: &Layout) -> PathBuf {
    layout.data.join("bot-mode-off-seen.json")
}

fn unix_now_ns() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64)
}

/// What `bot-mode-off-seen.json` says about when CS2 Stats last saw Bot Mode off. Only `At` can
/// make a marker stale. A missing or unusable record is unknown evidence, and unknown evidence
/// must end in asking, never in hiding: a false prompt is safe, since the user can choose "Leave
/// it on", while a hidden one leaves a dead session's Bot Mode on unannounced.
enum OffSeen {
    At(u64),
    /// No record: Bot Mode was never seen off with a marker present.
    Missing,
    /// A record that cannot be trusted; why. [`cleanup`] logs it and deletes the file.
    Invalid(String),
}

/// How far past the current time a recorded time may be and still count. A time further ahead
/// would make every marker written until then read as stale. Five minutes allows ordinary clock
/// corrections; the figure is a judgement, not a measurement.
const OFF_SEEN_FUTURE_LIMIT: Duration = Duration::from_secs(5 * 60);

fn off_seen(layout: &Layout) -> OffSeen {
    let path = off_seen_path(layout);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return OffSeen::Missing,
        Err(e) => return OffSeen::Invalid(format!("{}: {e}", path.display())),
    };
    let at = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v.get("at_ns").and_then(serde_json::Value::as_u64));
    match at {
        None => OffSeen::Invalid(format!("{}: no numeric at_ns in it", path.display())),
        Some(at) if at > unix_now_ns().saturating_add(OFF_SEEN_FUTURE_LIMIT.as_nanos() as u64) => {
            OffSeen::Invalid(format!("{}: its time is more than {} minutes past the current time", path.display(), OFF_SEEN_FUTURE_LIMIT.as_secs() / 60))
        }
        Some(at) => OffSeen::At(at),
    }
}

/// Records that Bot Mode is off now, which makes every marker written before it stale.
fn note_bot_mode_off(layout: &Layout) -> Result<(), String> {
    let text = serde_json::json!({ "at_ns": unix_now_ns() }).to_string();
    changes::write_atomic(&off_seen_path(layout), text.as_bytes())
}

/// The marker, when one is present, sound, and not shown stale by a trusted record of Bot Mode
/// seen off after it was written (see [`OffSeen`]). Any other marker is no evidence of a session
/// in flight; [`cleanup`] deletes it.
fn read_marker(layout: &Layout) -> Option<SessionMarker> {
    let seen_off_at = match off_seen(layout) {
        OffSeen::At(at) => Some(at),
        OffSeen::Missing | OffSeen::Invalid(_) => None,
    };
    std::fs::read_to_string(marker_path(layout))
        .ok()
        .and_then(|text| serde_json::from_str::<SessionMarker>(&text).ok())
        .filter(|m| m.is_sound() && seen_off_at.is_none_or(|at| m.written_at_ns > at))
}

fn write_marker(layout: &Layout, marker: &SessionMarker) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(marker).map_err(|e| e.to_string())?;
    changes::write_atomic(&marker_path(layout), &text)
}

fn clear_marker(layout: &Layout) -> Result<(), String> {
    let path = marker_path(layout);
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("deleting {}: {e}", path.display())),
        _ => Ok(()),
    }
}

/// Deletes the marker only if `run_id` wrote it.
fn clear_own_marker(layout: &Layout, run_id: &str) -> Result<(), String> {
    if read_marker(layout).is_some_and(|m| m.run_id == run_id) {
        clear_marker(layout)?;
    }
    Ok(())
}

/// Deletes the marker after Bot Mode was seen off. When the file will not go, the off time is
/// recorded first so the marker reads as stale from now on; the error says what is left.
fn clear_marker_after_off(layout: &Layout) -> Result<(), String> {
    let noted = note_bot_mode_off(layout);
    clear_marker(layout).map_err(|e| match noted {
        Ok(()) => format!("{e}; CS2 Stats ignores it from now on and deletes it at its next start"),
        Err(n) => format!("{e}; recording that Bot Mode is off also failed ({n}), so CS2 Stats may ask about Bot Mode again"),
    })
}

/// How long a launch waits for CS2 to start before turning Bot Mode off again. Steam may be
/// updating the game first.
pub const START_LIMIT: Duration = Duration::from_secs(15 * 60);

/// Whether the `gameinfo.gi` search paths are in place. `Unknown` when the file cannot be read
/// or parsed: callers report it and never treat it as off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotMode {
    On,
    Off,
    Unknown(String),
}

pub fn bot_mode(layout: &Layout) -> BotMode {
    match read_gameinfo(layout).and_then(|(t, _)| gameinfo::is_bot_mode(&t)) {
        Ok(true) => BotMode::On,
        Ok(false) => BotMode::Off,
        Err(e) => BotMode::Unknown(e),
    }
}

fn read_gameinfo(layout: &Layout) -> Result<(String, String), String> {
    let path = layout.confined("gameinfo.gi")?;
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = String::from_utf8(bytes.clone()).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok((text, hash::bytes(&bytes)))
}

/// How many times a toggle re-reads `gameinfo.gi` when it changed between the read and the write.
const CAS_TRIES: usize = 3;

/// What a launch's own "on" write put in `gameinfo.gi`. The supervisor keeps it in memory for
/// the whole session, so ending the session never depends on reading the marker back.
struct Written {
    after_hash: String,
    before_content: String,
}

/// Turns Bot Mode on as a compare-and-swap: the change is written only if `gameinfo.gi` still
/// has the content it was computed from, so a Valve update landing in between is never
/// overwritten; the toggle reads the new file and tries again. `None` when Bot Mode was already
/// on: then nothing is written, the session does not own Bot Mode, and an older session's
/// marker is left for the recovery prompt.
///
/// An error carries the session's `Written` when its bytes are in `gameinfo.gi` anyway (the write
/// landed, then finishing the change failed and its rollback could not run), so the supervisor
/// still undoes it.
fn turn_on(layout: &Layout, probe: &dyn ProcessProbe, lock: &OpLock, run_id: &str) -> Result<Option<(Meta, Written)>, (String, Option<Written>)> {
    let mut last = String::new();
    for _ in 0..CAS_TRIES {
        let (text, read_hash) = read_gameinfo(layout).map_err(|e| (e, None))?;
        let new = gameinfo::enable(&text).map_err(|e| (e, None))?;
        if new == text {
            // Another tool turned it on between tries: an earlier try's marker is not a session
            // in flight, and left behind it would raise the prompt for that tool's Bot Mode.
            clear_own_marker(layout, run_id)
                .map_err(|e| (format!("{NOT_CHANGED}: another tool turned Bot Mode on, and this launch's session record could not be removed ({e})"), None))?;
            return Ok(None);
        }
        let after_hash = hash::bytes(new.as_bytes());
        let mut marker = SessionMarker { state: "pending".into(), run_id: run_id.into(), written_at_ns: unix_now_ns(), before_hash: read_hash.clone(), after_hash: after_hash.clone(), before_content: text.clone() };
        write_marker(layout, &marker).map_err(|e| (format!("writing the Bot Mode session marker before the gameinfo edit: {e}"), None))?;
        match changes::run_kind(layout, probe, lock, "bot-mode-on", Kind::Session, |cs| cs.put_bytes_if_unchanged("gameinfo.gi", new.as_bytes(), &read_hash)) {
            Ok((_, meta)) => {
                marker.state = "committed".into();
                // Best effort: the pending marker already holds everything recovery needs, and
                // recovery treats both states alike.
                let _ = write_marker(layout, &marker);
                return Ok(Some((meta, Written { after_hash, before_content: text })));
            }
            Err(e) if e.contains(changes::CHANGED_SINCE_READ) => last = e,
            Err(e) => {
                let landed = read_gameinfo(layout).is_ok_and(|(_, h)| h == after_hash);
                return Err(if landed { (e, Some(Written { after_hash, before_content: text })) } else { (format!("{NOT_CHANGED}: {e}"), None) });
            }
        }
    }
    // The compare-and-swap refuses before renaming anything into place, so no try landed.
    let kept = clear_own_marker(layout, run_id).err().map(|e| format!("; the session record could not be removed ({e})")).unwrap_or_default();
    Err((format!("{NOT_CHANGED}: gameinfo.gi kept changing while Bot Mode was being turned on: {last}{kept}"), None))
}

/// How a session's own "on" write ended.
#[derive(Debug)]
enum Ending {
    /// The supervisor restored the file it changed.
    TurnedOff(Meta),
    /// Bot Mode was already off: something else turned it off during the session.
    AlreadyOff,
    /// The file is no longer what the session wrote, so it was left as is.
    ChangedByOther,
    /// The session never turned Bot Mode on (adopt mode, Bot Mode already on, or a failed write).
    NeverWritten,
}

/// Undoes the session's own "on" write, only while `gameinfo.gi` is still exactly what it wrote.
/// Another tool writing those same bytes during the session is the one case this gets wrong, and
/// a write landing between the final hash check and the rename is not caught either (see the
/// module notes); a file that differs in any byte when checked is left alone.
fn turn_off_own(layout: &Layout, probe: &dyn ProcessProbe, lock: &OpLock, w: &Written) -> Result<Ending, String> {
    let (text, hash) = read_gameinfo(layout)?;
    if !gameinfo::is_bot_mode(&text)? {
        return Ok(Ending::AlreadyOff);
    }
    if hash != w.after_hash {
        return Ok(Ending::ChangedByOther);
    }
    changes::supersede_unfinished_sessions(layout)?;
    let (_, meta) = changes::run_kind(layout, probe, lock, "bot-mode-off", Kind::Session, |cs| cs.put_bytes_if_unchanged("gameinfo.gi", w.before_content.as_bytes(), &w.after_hash))?;
    if bot_mode(layout) != BotMode::Off {
        return Err("gameinfo.gi does not read back as off".into());
    }
    Ok(Ending::TurnedOff(meta))
}

/// The progress of a supervisor, in `session-status.json`. Liveness comes from the lease, not
/// from this file.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// Which start this is, set by whoever started the supervisor.
    pub run_id: String,
    pub mode: RunMode,
    /// "starting", "waiting", "running", "cannotSee", "done" or "failed".
    pub state: String,
    pub message: String,
    pub verdicts: Vec<Checked>,
    pub errors: Vec<String>,
    /// Unix seconds of the supervisor's last poll.
    pub heartbeat: u64,
    pub outcome: Option<Outcome>,
    pub bot_mode_on: Option<Meta>,
    pub bot_mode_off: Option<Meta>,
    /// Why Bot Mode was left on at the end, if it was.
    pub left_on: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunMode {
    /// Turn Bot Mode on, start CS2 through Steam, watch, turn off.
    Launch,
    /// Watch a CS2 already running with Bot Mode on, ending it if unsafe. Never writes
    /// `gameinfo.gi`.
    Adopt,
}

impl RunMode {
    pub fn parse(s: &str) -> Result<RunMode, String> {
        match s {
            "launch" => Ok(RunMode::Launch),
            "adopt" => Ok(RunMode::Adopt),
            _ => Err(format!("{s}: mode is launch or adopt")),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            RunMode::Launch => "launch",
            RunMode::Adopt => "adopt",
        }
    }
}

pub fn status_path(layout: &Layout) -> PathBuf {
    layout.data.join("session-status.json")
}

pub fn read_status(layout: &Layout) -> Option<SessionStatus> {
    std::fs::read_to_string(status_path(layout)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Writes the status file, best effort: a status that cannot be written never stops the watch.
struct Reporter<'a> {
    layout: &'a Layout,
    status: std::cell::RefCell<SessionStatus>,
    last_write: std::cell::Cell<u64>,
}

impl Reporter<'_> {
    fn update(&self, f: impl FnOnce(&mut SessionStatus)) {
        f(&mut self.status.borrow_mut());
        self.write();
    }
    fn write(&self) {
        let mut s = self.status.borrow_mut();
        s.heartbeat = unix_now();
        self.last_write.set(s.heartbeat);
        if let Ok(text) = serde_json::to_string_pretty(&*s) {
            let _ = changes::write_atomic(&status_path(self.layout), text.as_bytes());
        }
    }
    /// The heartbeat, written at most every few seconds.
    fn tick(&self) {
        if unix_now() >= self.last_write.get() + 5 {
            self.write();
        }
    }
    fn event(&self, e: &Event) {
        self.update(|s| match e {
            Event::Waiting { message } => {
                s.state = "waiting".into();
                s.message = message.clone();
            }
            Event::Checked { checked, message } => {
                s.state = "running".into();
                s.message = message.clone();
                s.verdicts.push(checked.clone());
            }
            Event::Outage { message, error } => {
                s.state = "cannotSee".into();
                s.message = message.clone();
                s.errors.push(format!("reading the process list keeps failing: {error}"));
            }
            Event::Recovered { message } => {
                s.state = "running".into();
                s.message = message.clone();
            }
        });
    }
}

/// The supervisor's whole life; see the module notes. `spawn` asks Steam to start CS2 (only in
/// launch mode). Returns the final status, also left in the status file. It returns once its own
/// "on" write is settled (undone, or found replaced or already off), or when it could not start
/// at all (with nothing turned on). A session that wrote nothing leaves Bot Mode as it is.
pub fn supervise_session(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    sys: &dyn System,
    steam: Option<&SteamConfig>,
    mode: RunMode,
    run_id: &str,
    spawn: &dyn Fn(&LaunchPlan) -> Result<(), String>,
) -> SessionStatus {
    let initial = SessionStatus {
        run_id: run_id.into(),
        mode,
        state: "starting".into(),
        message: "starting the Bot Mode session".into(),
        verdicts: Vec::new(),
        errors: Vec::new(),
        heartbeat: 0,
        outcome: None,
        bot_mode_on: None,
        bot_mode_off: None,
        left_on: None,
    };
    // 1. The lease comes before anything is written. A supervisor that loses the race to
    // another one writes nothing, so it never overwrites the status of the one that runs.
    let _lease = match NamedLock::acquire(LockKind::Session, &layout.csgo) {
        Ok(l) => l,
        Err(e) => {
            let mut s = initial;
            s.state = "failed".into();
            s.message = e;
            return s;
        }
    };
    let r = Reporter { layout, status: std::cell::RefCell::new(initial), last_write: std::cell::Cell::new(0) };
    let fail = |why: String| {
        r.update(|s| {
            s.state = "failed".into();
            s.message = why.clone();
            s.errors.push(why.clone());
        });
        r.status.borrow().clone()
    };
    let image = match monitor::cs2_image(&layout.csgo) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    // The handshake the starter waits for: lease held, watcher ready.
    r.update(|s| {
        s.state = "ready".into();
        s.message = "the Bot Mode supervisor is running".into();
    });
    let mut launch_error = None;
    let mut written = None;
    let watch_mode = match mode {
        RunMode::Launch => {
            let Some(steam) = steam else { return fail("no Steam configuration to launch with".into()) };
            match start_cs2(layout, probe, sys, steam, run_id, spawn) {
                Ok((since, on)) => {
                    if let Some((meta, w)) = on {
                        r.update(|s| s.bot_mode_on = Some(meta));
                        written = Some(w);
                    }
                    Some(Mode::Launched { since })
                }
                // Nothing was turned on: nothing to undo.
                Err(StartError::BeforeOn(e)) => return fail(e),
                // Bot Mode may be on: go through the same turn-off loop as a finished session.
                Err(StartError::AfterOn(e, w)) => {
                    r.update(|s| s.errors.push(e.clone()));
                    launch_error = Some(e);
                    written = w;
                    None
                }
            }
        }
        RunMode::Adopt => Some(Mode::Adopt),
    };
    // 5. Watch until the last CS2 of this install exits.
    let limit = (mode == RunMode::Launch).then_some(START_LIMIT);
    let watch = |mode: Mode, limit: Option<Duration>| monitor::supervise_with_tick(sys, &image, mode, limit, &|| Control::Go, &|e| r.event(e), &|| r.tick());
    let mut checked = watch_mode.map(|m| checked_of(&watch(m, limit))).unwrap_or_default();
    let mut outcome = None;
    // Why the session marker could not be deleted at the end, if it could not.
    let mut record_kept: Option<String> = None;
    // 6. Undo this session's own write, and leave only once that is settled: a CS2 that started
    // again is watched until it exits, and a failure is retried, with the lease kept throughout.
    let ending = loop {
        match end(layout, probe, sys, &image, written.as_ref()) {
            End::Done(ending) => {
                if written.is_some() {
                    let cleared = match ending {
                        // Bot Mode is off now, so the marker can be made stale if it will not go.
                        Ending::TurnedOff(_) | Ending::AlreadyOff => clear_marker_after_off(layout),
                        _ => clear_own_marker(layout, run_id),
                    };
                    if let Err(e) = cleared {
                        let why = format!("the session record could not be removed: {e}");
                        r.update(|s| s.errors.push(why.clone()));
                        record_kept = Some(e);
                    }
                }
                if let Ending::TurnedOff(meta) = &ending {
                    r.update(|s| s.bot_mode_off = Some(meta.clone()));
                }
                break ending;
            }
            End::StillRunning => {
                r.update(|s| s.message = "a CS2 of this install is running; watching it until it exits".into());
                let more = watch(Mode::Adopt, None);
                checked.extend(checked_of(&more));
                outcome = Some(more);
            }
            End::Failed(why) => {
                r.update(|s| {
                    s.state = "closing".into();
                    s.message = format!("Bot Mode is still on ({why}); close CS2 now. Bot Mode keeps trying to turn it off.");
                    s.left_on = Some(why.clone());
                    if s.errors.last() != Some(&why) {
                        s.errors.push(why.clone());
                    }
                });
                sys.sleep(Duration::from_secs(5));
            }
        }
    };
    let outcome = match outcome {
        // CS2 never started and nothing appeared after: say so.
        None if checked.is_empty() && mode == RunMode::Launch => Outcome::NoStart { last_error: None },
        _ => Outcome::Exited { checked },
    };
    r.update(|s| {
        match &launch_error {
            Some(e) => {
                s.state = "failed".into();
                s.message = match &ending {
                    Ending::TurnedOff(_) => format!("{e}; Bot Mode was turned off again"),
                    Ending::AlreadyOff => format!("{e}; Bot Mode is off"),
                    Ending::ChangedByOther => format!("{e}; {MANAGED_BY_OTHER_TOOL}"),
                    Ending::NeverWritten if e.starts_with(NOT_CHANGED) => e.clone(),
                    Ending::NeverWritten if e.contains("before the gameinfo edit") => format!("{e}; Bot Mode was not turned on."),
                    Ending::NeverWritten => format!("{e}; {NOT_CHANGED}"),
                };
            }
            None => {
                s.state = "done".into();
                s.message = match &ending {
                    Ending::ChangedByOther => format!("{} {MANAGED_BY_OTHER_TOOL}.", monitor::describe(&outcome)),
                    _ => monitor::describe(&outcome),
                };
            }
        }
        if let Some(e) = &record_kept {
            s.message = match &ending {
                Ending::TurnedOff(_) | Ending::AlreadyOff => format!("{} Bot Mode is off, but the session record couldn't be removed ({e}).", s.message),
                _ => format!("{} The session record couldn't be removed ({e}), so CS2 Stats may ask about Bot Mode at its next start.", s.message),
            };
        }
        s.outcome = Some(outcome);
        s.left_on = None;
    });
    let done = r.status.borrow().clone();
    done
}

fn checked_of(o: &Outcome) -> Vec<Checked> {
    match o {
        Outcome::Exited { checked } | Outcome::Stopped { checked, .. } => checked.clone(),
        Outcome::NoStart { .. } => Vec::new(),
    }
}

/// Why [`start_cs2`] failed, by whether Bot Mode may already be on.
enum StartError {
    BeforeOn(String),
    /// The supervisor ends the session with the loop it uses after every session; it turns Bot
    /// Mode off only if this start wrote it (the `Written`).
    AfterOn(String, Option<Written>),
}

/// Steps 2 to 4: under the operation lock, prepare, record the start time, turn Bot Mode on,
/// and ask Steam to start CS2. Any failure from the "on" write onward is `AfterOn`: the caller
/// keeps the lease until its own write is undone or found replaced.
fn start_cs2(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    sys: &dyn System,
    steam: &SteamConfig,
    run_id: &str,
    spawn: &dyn Fn(&LaunchPlan) -> Result<(), String>,
) -> Result<(u64, Option<(Meta, Written)>), StartError> {
    let lock = OpLock::acquire(layout).map_err(StartError::BeforeOn)?;
    let plan = launch::prepare(layout, probe, steam, &lock).map_err(StartError::BeforeOn)?;
    launch::check_start(&plan, layout, probe, steam).map_err(StartError::BeforeOn)?;
    // Taken before Bot Mode is on, so no CS2 that could have loaded the mod is older.
    let since = sys.file_time();
    changes::supersede_unfinished_sessions(layout).map_err(StartError::BeforeOn)?;
    let on = turn_on(layout, probe, &lock, run_id).map_err(|(e, w)| StartError::AfterOn(e, w))?;
    match spawn(&plan) {
        Ok(()) => Ok((since, on)),
        Err(e) => Err(StartError::AfterOn(e, on.map(|(_, w)| w))),
    }
}

enum End {
    /// The session's own write is settled; how.
    Done(Ending),
    /// A CS2 of this install runs, so Bot Mode cannot be turned off yet.
    StillRunning,
    /// Turning it off failed this time (CS2 could not be seen, the lock was busy, the write
    /// failed); the reason.
    Failed(String),
}

/// One attempt to settle the session's own write once no CS2 of this install runs. A session
/// that wrote nothing (`written` is `None`: adopt mode, or Bot Mode was already on) never
/// writes `gameinfo.gi` here.
fn end(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, image: &std::path::Path, written: Option<&Written>) -> End {
    match monitor::sweep(sys, image) {
        Ok((_, false)) => {}
        Ok((_, true)) => return End::StillRunning,
        Err(e) => return End::Failed(format!("whether CS2 still runs could not be checked ({e})")),
    }
    let Some(w) = written else { return End::Done(Ending::NeverWritten) };
    let lock = match OpLock::acquire(layout) {
        Ok(l) => l,
        Err(e) => return End::Failed(e),
    };
    match turn_off_own(layout, probe, &lock, w) {
        Ok(ending) => End::Done(ending),
        Err(e) => End::Failed(e),
    }
}

/// What [`cleanup`] found. Cleanup never writes `gameinfo.gi`.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "result")]
pub enum Cleanup {
    /// Bot Mode is off and no session toggle is unfinished.
    Off,
    /// A supervisor holds the lease.
    Supervised,
    /// A CS2 runs with Bot Mode on and no supervisor; a supervisor was started to watch it.
    Adopting { checked: Vec<Checked> },
    /// A session of this app died with Bot Mode on: the user is asked.
    Recovery(Recovery),
    /// Bot Mode is on, and no session of this app was turning it on.
    LeftAlone { message: String },
    /// Bot Mode is off, but an old session marker could not be deleted; `why` says what happens
    /// to it. It never raises the prompt (see [`SessionMarker`]).
    RecordKept { why: String },
    /// Something could not be done; the reason.
    Problem { why: String },
}

/// The recovery prompt, for the app and the CLI: a session of this app died with Bot Mode on.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    /// [`RECOVERY`].
    pub message: String,
    /// `gameinfo.gi`, the one file "Turn off Bot Mode" writes.
    pub file: String,
    /// The lines "Turn off Bot Mode" removes from it, as they read now, including any another
    /// tool added.
    pub lines: Vec<String>,
    /// The SHA-256 of `gameinfo.gi` when this was read. [`recover`] refuses "off" once the file
    /// hashes differently, so the answer applies to the file the user was asked about (up to
    /// the check-to-rename window in the module notes).
    pub hash: String,
}

/// The recovery prompt, if there is one to show: no supervisor holds the lease, a session
/// marker is present, and Bot Mode is on. Reads only.
pub fn recovery(layout: &Layout) -> Result<Option<Recovery>, String> {
    if session_held(&layout.csgo)? || read_marker(layout).is_none() {
        return Ok(None);
    }
    let (text, hash) = read_gameinfo(layout)?;
    if !gameinfo::is_bot_mode(&text)? {
        return Ok(None);
    }
    Ok(Some(Recovery { message: RECOVERY.into(), file: layout.target("gameinfo.gi").display().to_string(), lines: gameinfo::bot_lines(&text)?, hash }))
}

/// The user's answer to the recovery prompt.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoverAction {
    /// Turn Bot Mode off.
    Off,
    /// Leave Bot Mode as it is, and stop asking.
    Leave,
}

/// What [`recover`] did.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Recovered {
    /// The change that turned Bot Mode off; `None` when nothing was written.
    pub change: Option<Meta>,
    pub message: String,
}

/// `recover` refused "off" because the file is not the one the user was asked about.
pub const CHANGED_SINCE_ASKED: &str =
    "gameinfo.gi changed after CS2 Stats asked about it, so Bot Mode was not changed. Check Bot Mode again before turning it off.";

/// Answers the recovery prompt; either answer deletes the session marker, so the prompt is not
/// raised again. "off" refuses unless `gameinfo.gi` still hashes to `expect_hash`, the hash the
/// prompt carried, checked before writing and again just before the rename; a write by another
/// program between that last check and the rename is not caught (see the module notes).
///
/// "off" means Bot Mode off, whichever tool turned it on: the user chose it over "Leave it on".
/// When the file is exactly what the dead session wrote, it restores the marker's before-image.
/// Otherwise it removes every Bot Mode search path, including ones another tool added, and
/// nothing else, since restoring an old before-image over a file that changed since would also
/// undo that change (a Valve update, say). Refuses while a session runs or CS2 is running.
pub fn recover(layout: &Layout, probe: &dyn ProcessProbe, action: RecoverAction, expect_hash: Option<&str>) -> Result<Recovered, String> {
    // Held, not just checked, so no supervisor can start while the answer is written.
    let _lease = NamedLock::acquire(LockKind::Session, &layout.csgo)
        .map_err(|e| if e.contains("already running") { "a Bot Mode session is running; wait until CS2 has exited".to_string() } else { e })?;
    let lock = OpLock::acquire(layout)?;
    ensure_cs2_closed(probe, Phase::Operation)?;
    let expect = match action {
        RecoverAction::Leave => {
            clear_marker(layout)?;
            return Ok(Recovered { change: None, message: format!("{NOT_CHANGED}.") });
        }
        RecoverAction::Off => expect_hash.ok_or("turning Bot Mode off needs the gameinfo.gi hash from the recovery prompt")?,
    };
    let marker = read_marker(layout).ok_or_else(|| format!("No Bot Mode session was left unfinished, so there is nothing to recover. {NOT_CHANGED}."))?;
    let (text, hash) = read_gameinfo(layout)?;
    if hash != expect {
        return Err(CHANGED_SINCE_ASKED.into());
    }
    if !gameinfo::is_bot_mode(&text)? {
        let message = match clear_marker_after_off(layout) {
            Ok(()) => "Bot Mode is already off.".to_string(),
            Err(e) => format!("Bot Mode is already off, but the session record couldn't be removed ({e})."),
        };
        return Ok(Recovered { change: None, message });
    }
    let new = if hash == marker.after_hash { marker.before_content } else { gameinfo::disable(&text)? };
    changes::supersede_unfinished_sessions(layout)?;
    match changes::run_kind(layout, probe, &lock, "bot-mode-off", Kind::Session, |cs| cs.put_bytes_if_unchanged("gameinfo.gi", new.as_bytes(), expect)) {
        Ok((_, meta)) => {
            let message = match clear_marker_after_off(layout) {
                Ok(()) => "Bot Mode is off.".to_string(),
                Err(e) => format!("Bot Mode is off, but the session record couldn't be removed ({e})."),
            };
            Ok(Recovered { change: Some(meta), message })
        }
        Err(e) if e.contains(changes::CHANGED_SINCE_READ) => Err(CHANGED_SINCE_ASKED.into()),
        Err(e) => Err(e),
    }
}

/// Deals with Bot Mode left on without a supervisor, and with interrupted session toggles,
/// without ever writing `gameinfo.gi` (see the module notes). `start_adopter` starts a
/// supervisor in adopt mode.
pub fn cleanup(layout: &Layout, sys: &dyn System, start_adopter: &dyn Fn() -> Result<(), String>) -> Cleanup {
    match session_held(&layout.csgo) {
        Ok(true) => return Cleanup::Supervised,
        Ok(false) => {}
        Err(e) => return Cleanup::Problem { why: e },
    }
    let lock = match OpLock::acquire(layout) {
        Ok(l) => l,
        Err(e) => return Cleanup::Problem { why: e },
    };
    // Again under the operation lock: a supervisor may have taken the lease since.
    match session_held(&layout.csgo) {
        Ok(true) => return Cleanup::Supervised,
        Ok(false) => {}
        Err(e) => return Cleanup::Problem { why: e },
    }
    let unfinished = changes::list(layout).map(|l| l.iter().any(|m| m.kind == Kind::Session && matches!(m.status, Status::InProgress | Status::RollbackPending)));
    match unfinished {
        Ok(false) => {}
        // Closed without being rolled back: rolling back a toggle could turn Bot Mode on.
        Ok(true) => {
            if let Err(e) = changes::supersede_unfinished_sessions(layout) {
                return Cleanup::Problem { why: e };
            }
        }
        Err(e) => return Cleanup::Problem { why: e },
    }
    let mode = bot_mode(layout);
    if let BotMode::Unknown(why) = &mode {
        return Cleanup::Problem { why: format!("Bot Mode's state could not be read: {why}") };
    }
    if let OffSeen::Invalid(why) = off_seen(layout) {
        // Ignored from here on (markers count as live), and deleted so a valid record can follow.
        eprintln!("Bot Mode: ignoring the record of when Bot Mode was last seen off ({why})");
        if let Err(e) = std::fs::remove_file(off_seen_path(layout)) {
            eprintln!("Bot Mode: deleting {}: {e}", off_seen_path(layout).display());
        }
    }
    let marker_file = marker_path(layout).exists();
    let marker = read_marker(layout);
    if mode == BotMode::Off {
        if marker_file {
            if let Err(why) = clear_marker_after_off(layout) {
                return Cleanup::RecordKept { why };
            }
        }
        return Cleanup::Off;
    }
    // A marker that is unsound or stale is no evidence of a session in flight.
    let mut kept = None;
    if marker_file && marker.is_none() {
        kept = clear_marker(layout).err();
    }
    let image = match monitor::cs2_image(&layout.csgo) {
        Ok(i) => i,
        Err(e) => return Cleanup::Problem { why: e },
    };
    let (checked, running) = match monitor::sweep(sys, &image) {
        Ok(r) => r,
        Err(e) => return Cleanup::Problem { why: format!("whether CS2 runs could not be checked ({e})") },
    };
    if running {
        drop(lock);
        return match start_adopter() {
            Ok(()) => Cleanup::Adopting { checked },
            Err(e) => Cleanup::Problem { why: format!("a CS2 runs with Bot Mode on, and watching it could not be started: {e}") },
        };
    }
    if marker.is_none() {
        let message = match kept {
            None => MANAGED_BY_OTHER_TOOL.to_string(),
            Some(e) => format!("{MANAGED_BY_OTHER_TOOL}. An old session record could not be removed ({e}); CS2 Stats ignores it."),
        };
        return Cleanup::LeftAlone { message };
    }
    match recovery(layout) {
        Ok(Some(r)) => Cleanup::Recovery(r),
        Ok(None) => Cleanup::Off,
        Err(e) => Cleanup::Problem { why: e },
    }
}

/// A sentence for the user, when cleanup found something worth saying.
pub fn cleanup_message(c: &Cleanup) -> Option<String> {
    match c {
        Cleanup::Off | Cleanup::Supervised => None,
        Cleanup::Recovery(r) => Some(r.message.clone()),
        Cleanup::LeftAlone { message } => Some(message.clone()),
        Cleanup::RecordKept { why } => Some(format!("Bot Mode is off. An old session record could not be removed: {why}.")),
        Cleanup::Adopting { .. } => Some(format!(
            "A CS2 is running with Bot Mode on and nothing watching it; CS2 Stats now watches it and ends it if it was started without -insecure. {NOT_CHANGED}."
        )),
        Cleanup::Problem { why } => Some(format!("Bot Mode cleanup: {why}")),
    }
}

/// Run before every command that changes anything: cleanup, then refuse while a session runs
/// (its CS2 may be loading the mod's files) or while one is being adopted. Returns a notice to
/// show when cleanup found something.
pub fn guard(layout: &Layout, sys: &dyn System, start_adopter: &dyn Fn() -> Result<(), String>) -> Result<Option<String>, String> {
    let c = cleanup(layout, sys, start_adopter);
    match &c {
        Cleanup::Supervised => Err("a Bot Mode session is running; wait until CS2 has exited".into()),
        Cleanup::Adopting { .. } => Err(cleanup_message(&c).unwrap_or_default()),
        _ => Ok(cleanup_message(&c)),
    }
}

/// What starting a supervisor with `CREATE_BREAKAWAY_FROM_JOB` returned, as the caller's
/// answer. Windows refuses that flag (access denied) when the caller runs in a job that does
/// not allow breaking away. Starting without it would put the supervisor in the caller's job,
/// where closing the app or the terminal could end it mid-session, so the launch is refused
/// instead, before anything is turned on.
pub fn spawn_result(r: std::io::Result<std::process::Child>) -> Result<std::process::Child, String> {
    r.map_err(|e| match e.raw_os_error() {
        Some(5) => "Windows would not start the Bot Mode supervisor outside this program's job (CREATE_BREAKAWAY_FROM_JOB was refused), so it could be ended together with this program; Bot Mode was not turned on. Start the app or the terminal normally, not from a tool that confines its children, and try again.".into(),
        _ => format!("starting the Bot Mode supervisor: {e}"),
    })
}

/// Starts a supervisor process detached from the caller and outside its job: closing the app
/// or the terminal does not end it. It runs this same program with the hidden
/// `supervise-session` command.
pub fn start_supervisor(layout: &Layout, mode: RunMode, run_id: &str) -> Result<std::process::Child, String> {
    let exe = std::env::current_exe().map_err(|e| format!("finding this program: {e}"))?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["botmode", "supervise-session", "--mode", mode.name(), "--run", run_id])
        .arg("--game")
        .arg(&layout.csgo)
        .arg("--data")
        .arg(&layout.data)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    }
    spawn_result(cmd.spawn())
}

/// How long a starter waits for a new supervisor to say it is ready.
pub const READY_WAIT: Duration = Duration::from_secs(10);

/// Waits for the supervisor of `run_id` to hold the lease and report ready (or to have already
/// finished). `exited` reports the child's exit code once it has exited; an early exit is a
/// failure, never taken as a launch or an adoption.
pub fn await_ready(layout: &Layout, sys: &dyn System, run_id: &str, exited: &mut dyn FnMut() -> Option<i32>) -> Result<SessionStatus, String> {
    let started = sys.elapsed();
    loop {
        let status = read_status(layout).filter(|s| s.run_id == run_id);
        if let Some(s) = &status {
            match s.state.as_str() {
                "failed" => return Err(s.message.clone()),
                "done" => return Ok(s.clone()),
                _ if session_held(&layout.csgo).unwrap_or(false) => return Ok(s.clone()),
                _ => {}
            }
        }
        if let Some(code) = exited() {
            // It may have finished in between; its own final status says so.
            if let Some(s) = read_status(layout).filter(|s| s.run_id == run_id && s.state == "done") {
                return Ok(s);
            }
            return Err(format!(
                "the Bot Mode supervisor exited early (exit code {code}){}",
                status.map(|s| format!(": {}", s.message)).unwrap_or_default()
            ));
        }
        if sys.elapsed().saturating_sub(started) >= READY_WAIT {
            return Err(format!("the Bot Mode supervisor did not report ready within {} seconds", READY_WAIT.as_secs()));
        }
        sys.sleep(Duration::from_millis(100));
    }
}

/// Starts a supervisor and waits for its handshake. Returns its run id.
pub fn start_and_wait(layout: &Layout, sys: &dyn System, mode: RunMode) -> Result<String, String> {
    let run_id = new_run_id();
    let mut child = start_supervisor(layout, mode, &run_id)?;
    await_ready(layout, sys, &run_id, &mut || child.try_wait().ok().flatten().map(|s| s.code().unwrap_or(-1)))?;
    Ok(run_id)
}

/// Starts a launch with `start` (normally [`start_and_wait`]). If it fails, a supervisor may
/// have turned Bot Mode on before dying, so cleanup runs at once and its message (the recovery
/// prompt, then) is added.
pub fn start_launch(
    layout: &Layout,
    sys: &dyn System,
    start: &dyn Fn() -> Result<String, String>,
    start_adopter: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    start().map_err(|e| match cleanup_message(&cleanup(layout, sys, start_adopter)) {
        Some(c) => format!("{e}. {c}"),
        None => e,
    })
}

/// A run id that differs for every start, even two in the same second from one process.
pub fn new_run_id() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    format!("{}-{nanos}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
}

/// Follows a supervisor's status file until `until` says to stop, or the supervisor has ended:
/// its status is final, or its lease is free while its status is not (it died, in any phase,
/// starting included: the lease is taken before the first status is written). `on_change` gets
/// each new message. An error if no status for `run_id` appears within 30 seconds.
pub fn follow(
    layout: &Layout,
    sys: &dyn System,
    run_id: &str,
    until: &dyn Fn(&SessionStatus) -> bool,
    on_change: &dyn Fn(&SessionStatus),
) -> Result<SessionStatus, String> {
    let started = sys.elapsed();
    let mut last_message = String::new();
    loop {
        if let Some(s) = read_status(layout).filter(|s| s.run_id == run_id) {
            if s.message != last_message {
                last_message = s.message.clone();
                on_change(&s);
            }
            if matches!(s.state.as_str(), "done" | "failed") {
                return Ok(s);
            }
            // Liveness before `until`: progress in the file means nothing once the lease is free.
            if !session_held(&layout.csgo).unwrap_or(true) {
                let mut died = s.clone();
                died.state = "failed".into();
                died.message = "the Bot Mode supervisor stopped unexpectedly; if it left Bot Mode on, CS2 Stats asks whether to turn it off".into();
                return Ok(died);
            }
            if until(&s) {
                return Ok(s);
            }
        } else if sys.elapsed().saturating_sub(started) > Duration::from_secs(30) {
            return Err("the Bot Mode supervisor did not start (no status after 30 seconds)".into());
        }
        sys.sleep(Duration::from_millis(500));
    }
}
