//! Bot Mode sessions, each run by one dedicated supervisor process.
//!
//! `cs2-stats botmode supervise-session` is the only thing that turns Bot Mode on (the two
//! `gameinfo.gi` search paths). The app and the CLI start it detached, so closing either does
//! not affect it, and then read its progress from `session-status.json` in the app folder.
//! [`supervise_session`] is its whole life:
//! 1. take the session lease (`process::LockKind::Session`, a named mutex keyed to the game
//!    folder, which the OS releases when the process dies);
//! 2. record the session start time;
//! 3. turn Bot Mode on;
//! 4. ask Steam to start CS2;
//! 5. watch until the last CS2 of this install exits, ending the unsafe ones;
//! 6. turn Bot Mode off;
//! 7. exit.
//!
//! "Supervised" means exactly "the lease is held". The supervisor does not recover from a
//! panic: release builds abort on panic, the dead process frees the lease, and the next
//! [`cleanup`] deals with what it left. Cleanup runs when the app starts and before every
//! command that changes anything: with the lease free and Bot Mode on, it turns Bot Mode off
//! when no CS2 runs, and otherwise starts a supervisor in adopt mode, which watches the running
//! CS2 (ending it if unsafe) and turns Bot Mode off when it exits.
//!
//! What this cannot cover: the supervisor dies mid-session and the user then starts CS2 from
//! Steam before the app or a Bot Mode command runs again. Bot Mode is still on in
//! `gameinfo.gi` and nothing is watching. [`UNPROTECTED`] is the notice the app shows about it.

use super::changes::{self, Kind, Meta, Status};
use super::gameinfo;
use super::hash;
use super::launch::{self, LaunchPlan};
use super::monitor::{self, Checked, Control, Event, Mode, Outcome, System};
use super::paths::Layout;
use super::process::{session_held, LockKind, NamedLock, OpLock, ProcessProbe};
use super::steam::SteamConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// Shown with Bot Mode in the app and the CLI.
pub const UNPROTECTED: &str =
    "Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.";

/// Shown when cleanup turns off Bot Mode that something other than a Bot Mode session left on
/// (the mod's own Panel, or a copy made by hand).
pub const LEFT_BY_OTHER_TOOL: &str = "Bot Mode was left on by another tool; it's now off. Launch Bot Mode from this app.";

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

/// Turns Bot Mode on or off as a compare-and-swap: the change is written only if `gameinfo.gi`
/// still has the content it was computed from, so a Valve update landing in between is never
/// overwritten; the toggle reads the new file and tries again.
fn set_bot_mode(layout: &Layout, probe: &dyn ProcessProbe, lock: &OpLock, on: bool) -> Result<Option<Meta>, String> {
    let op = if on { "bot-mode-on" } else { "bot-mode-off" };
    let mut last = String::new();
    for _ in 0..CAS_TRIES {
        let (text, read_hash) = read_gameinfo(layout)?;
        let new = if on { gameinfo::enable(&text)? } else { gameinfo::disable(&text)? };
        if new == text {
            return Ok(None);
        }
        let result = changes::run_kind(layout, probe, lock, op, Kind::Session, |cs| cs.put_bytes_if("gameinfo.gi", new.as_bytes(), &read_hash));
        match result {
            Ok((_, meta)) => return Ok(Some(meta)),
            Err(e) if e.contains(changes::CHANGED_SINCE_READ) => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(format!("gameinfo.gi kept changing while Bot Mode was being turned {}: {last}", if on { "on" } else { "off" }))
}

/// Finishes interrupted session toggles in the off direction. A session toggle is never rolled
/// back, since that could turn Bot Mode back on; instead each unfinished one is closed as
/// superseded, and Bot Mode is then turned off. Only runs when no CS2 is running (the caller
/// checks, and the change it writes checks again).
fn turn_off(layout: &Layout, probe: &dyn ProcessProbe, lock: &OpLock) -> Result<Option<Meta>, String> {
    changes::supersede_unfinished_sessions(layout)?;
    set_bot_mode(layout, probe, lock, false)
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
    /// Watch a CS2 already running with Bot Mode on, turn off when it exits.
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
/// launch mode). Returns the final status, also left in the status file.
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
    let r = Reporter { layout, status: std::cell::RefCell::new(initial), last_write: std::cell::Cell::new(0) };
    let fail = |why: String| {
        r.update(|s| {
            s.state = "failed".into();
            s.message = why.clone();
            s.errors.push(why.clone());
        });
        r.status.borrow().clone()
    };
    r.write();
    // 1. The lease, held until this function returns.
    let _lease = match NamedLock::acquire(LockKind::Session, &layout.csgo) {
        Ok(l) => l,
        Err(e) => return fail(e),
    };
    let image = match monitor::cs2_image(&layout.csgo) {
        Ok(i) => i,
        Err(e) => return fail(e),
    };
    let watch_mode = match mode {
        RunMode::Launch => {
            let Some(steam) = steam else { return fail("no Steam configuration to launch with".into()) };
            match start_cs2(layout, probe, sys, steam, spawn) {
                Ok((since, meta)) => {
                    r.update(|s| s.bot_mode_on = meta);
                    Mode::Launched { since }
                }
                Err(e) => return fail(e),
            }
        }
        RunMode::Adopt => Mode::Adopt,
    };
    // 5. Watch until the last CS2 of this install exits.
    let limit = (mode == RunMode::Launch).then_some(START_LIMIT);
    let outcome = monitor::supervise_with_tick(sys, &image, watch_mode, limit, &|| Control::Go, &|e| r.event(e), &|| r.tick());
    // 6. Turn Bot Mode off.
    let (off, left_on) = end(layout, probe, sys, &image);
    r.update(|s| {
        s.state = "done".into();
        s.message = monitor::describe(&outcome);
        if let Some(why) = &left_on {
            s.message.push_str(&format!(" Bot Mode is still on ({why}); the next Bot Mode command or app start turns it off once CS2 has exited."));
        }
        s.outcome = Some(outcome);
        s.bot_mode_off = off;
        s.left_on = left_on;
    });
    let done = r.status.borrow().clone();
    done
}

/// Steps 2 to 4: under the operation lock, prepare, record the start time, turn Bot Mode on,
/// and ask Steam to start CS2. If Steam cannot be asked, Bot Mode is turned off again.
fn start_cs2(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    sys: &dyn System,
    steam: &SteamConfig,
    spawn: &dyn Fn(&LaunchPlan) -> Result<(), String>,
) -> Result<(u64, Option<Meta>), String> {
    let lock = OpLock::acquire(layout)?;
    let plan = launch::prepare(layout, probe, steam, &lock)?;
    launch::check_start(&plan, layout, probe, steam)?;
    // Taken before Bot Mode is on, so no CS2 that could have loaded the mod is older.
    let since = sys.file_time();
    changes::supersede_unfinished_sessions(layout)?;
    let meta = set_bot_mode(layout, probe, &lock, true)?;
    if let Err(e) = spawn(&plan) {
        return Err(match set_bot_mode(layout, probe, &lock, false) {
            Ok(_) => format!("{e}; Bot Mode was turned off again"),
            Err(e2) => format!("{e}; turning Bot Mode off again also failed ({e2})"),
        });
    }
    Ok((since, meta))
}

/// Turns Bot Mode off once no CS2 of this install runs. If one still runs, or whether one runs
/// cannot be told, Bot Mode is left on and the reason returned.
fn end(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, image: &std::path::Path) -> (Option<Meta>, Option<String>) {
    match monitor::sweep(sys, image) {
        Ok((_, false)) => {}
        Ok((_, true)) => return (None, Some("a CS2 of this install is still running".into())),
        Err(e) => return (None, Some(format!("whether CS2 still runs could not be checked ({e})"))),
    }
    let mut last = String::new();
    // Another operation may be finishing; turning Bot Mode off must not give up on that.
    for _ in 0..40 {
        match OpLock::acquire(layout) {
            Ok(lock) => {
                return match turn_off(layout, probe, &lock) {
                    Ok(m) => (m, None),
                    Err(e) => (None, Some(e)),
                }
            }
            Err(e) => last = e,
        }
        sys.sleep(Duration::from_millis(500));
    }
    (None, Some(last))
}

/// What [`cleanup`] found and did.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "result")]
pub enum Cleanup {
    /// Bot Mode is off and no session toggle is unfinished.
    Off,
    /// A supervisor holds the lease.
    Supervised,
    /// Bot Mode was on with no supervisor and no CS2 running, and was turned off. `message`
    /// says who left it on.
    TurnedOff { change: Option<Meta>, message: String },
    /// A CS2 runs with Bot Mode on and no supervisor; a supervisor was started to adopt it.
    Adopting { checked: Vec<Checked> },
    /// Something could not be done; the reason.
    Problem { why: String },
}

/// Who left Bot Mode on: a Bot Mode session (its newest toggle turned it on and none turned it
/// off), or something else.
fn left_by_other_tool(layout: &Layout) -> bool {
    let newest = changes::list(layout).ok().and_then(|l| l.into_iter().find(|m| m.kind == Kind::Session));
    newest.is_none_or(|m| m.operation != "bot-mode-on")
}

/// Deals with Bot Mode left on without a supervisor, and with interrupted session toggles.
/// `start_adopter` starts a supervisor in adopt mode.
pub fn cleanup(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, start_adopter: &dyn Fn() -> Result<(), String>) -> Cleanup {
    match session_held(&layout.csgo) {
        Ok(true) => return Cleanup::Supervised,
        Ok(false) => {}
        Err(e) => return Cleanup::Problem { why: e },
    }
    let lock = match OpLock::acquire(layout) {
        Ok(l) => l,
        Err(e) => return Cleanup::Problem { why: e },
    };
    let unfinished = changes::list(layout).map(|l| l.iter().any(|m| m.kind == Kind::Session && matches!(m.status, Status::InProgress | Status::RollbackPending)));
    let unfinished = match unfinished {
        Ok(u) => u,
        Err(e) => return Cleanup::Problem { why: e },
    };
    match bot_mode(layout) {
        BotMode::Off if !unfinished => return Cleanup::Off,
        BotMode::Unknown(why) => return Cleanup::Problem { why: format!("Bot Mode's state could not be read: {why}") },
        _ => {}
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
    let other = left_by_other_tool(layout);
    match turn_off(layout, probe, &lock) {
        Ok(change) => Cleanup::TurnedOff {
            change,
            message: if other { LEFT_BY_OTHER_TOOL.into() } else { "A Bot Mode session ended without turning Bot Mode off; it's now off.".into() },
        },
        Err(e) => Cleanup::Problem { why: e },
    }
}

/// A sentence for the user, when cleanup did something worth saying.
pub fn cleanup_message(c: &Cleanup) -> Option<String> {
    match c {
        Cleanup::Off | Cleanup::Supervised => None,
        Cleanup::TurnedOff { message, .. } => Some(message.clone()),
        Cleanup::Adopting { .. } => Some("A CS2 is running with Bot Mode on and nothing watching it; Bot Mode now watches it and turns Bot Mode off when it exits.".into()),
        Cleanup::Problem { why } => Some(format!("Bot Mode cleanup: {why}")),
    }
}

/// Run before every command that changes anything: cleanup, then refuse while a session runs
/// (its CS2 may be loading the mod's files) or while one is being adopted. Returns a notice to
/// show when cleanup did something.
pub fn guard(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, start_adopter: &dyn Fn() -> Result<(), String>) -> Result<Option<String>, String> {
    let c = cleanup(layout, probe, sys, start_adopter);
    match &c {
        Cleanup::Supervised => Err("a Bot Mode session is running; wait until CS2 has exited".into()),
        Cleanup::Adopting { .. } => Err(cleanup_message(&c).unwrap_or_default()),
        _ => Ok(cleanup_message(&c)),
    }
}

/// Starts a supervisor process detached from the caller: closing the app or the terminal does
/// not end it. It runs this same program with the hidden `supervise-session` command.
pub fn start_supervisor(layout: &Layout, mode: RunMode, run_id: &str) -> Result<(), String> {
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
        if let Err(e) = cmd.spawn() {
            // A job that does not allow breaking away refuses that flag; start without it.
            if e.raw_os_error() != Some(5) {
                return Err(format!("starting the Bot Mode supervisor: {e}"));
            }
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
            cmd.spawn().map_err(|e| format!("starting the Bot Mode supervisor: {e}"))?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        cmd.spawn().map(|_| ()).map_err(|e| format!("starting the Bot Mode supervisor: {e}"))
    }
}

/// A run id unique enough to tell this start's status from an older one.
pub fn new_run_id() -> String {
    format!("{}-{}", std::process::id(), changes::now_utc().0)
}

/// Follows a supervisor's status file until `until` says to stop, or the supervisor has ended:
/// its status is final, or its lease is free while its status is not (it died). `on_change` gets
/// each new message. Returns the last status seen, or an error if the supervisor never wrote
/// one for `run_id`.
pub fn follow(
    layout: &Layout,
    sys: &dyn System,
    run_id: &str,
    until: &dyn Fn(&SessionStatus) -> bool,
    on_change: &dyn Fn(&SessionStatus),
) -> Result<SessionStatus, String> {
    let started = sys.elapsed();
    let mut last_message = String::new();
    let mut last: Option<SessionStatus> = None;
    loop {
        if let Some(s) = read_status(layout).filter(|s| s.run_id == run_id) {
            if s.message != last_message {
                last_message = s.message.clone();
                on_change(&s);
            }
            let ended = matches!(s.state.as_str(), "done" | "failed");
            if ended || until(&s) {
                return Ok(s);
            }
            if !session_held(&layout.csgo).unwrap_or(true) && s.state != "starting" {
                let mut died = s.clone();
                died.state = "failed".into();
                died.message = "the Bot Mode supervisor stopped unexpectedly; the next Bot Mode command or app start turns Bot Mode off once CS2 has exited".into();
                return Ok(died);
            }
            last = Some(s);
        } else if sys.elapsed().saturating_sub(started) > Duration::from_secs(30) {
            return Err("the Bot Mode supervisor did not start (no status after 30 seconds)".into());
        }
        let _ = &last;
        sys.sleep(Duration::from_millis(500));
    }
}
