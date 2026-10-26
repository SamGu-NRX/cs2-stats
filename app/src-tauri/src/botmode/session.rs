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
//! What this cannot cover, by its nature:
//! - The supervisor is killed (a crash, a reboot, Task Manager) between the write that turns
//!   Bot Mode on and the one that turns it off. Bot Mode stays on with nothing watching until
//!   the app or a Bot Mode command runs again; a CS2 started from Steam before then is
//!   unprotected. [`UNPROTECTED`] is the notice the app shows about it.
//! - A Steam launch of CS2 that was already queued (say, from the Steam client) when the
//!   supervisor turned Bot Mode on. It is watched like any other CS2 of this install, but it
//!   was not started by Bot Mode, so its options are whatever Steam had.
//! - A CS2 that starts between the supervisor's last process-list poll and its write that
//!   turns Bot Mode off. It may load the mod with nothing left watching it.
//! - Another tool (the mod's Panel, a copy made by hand) turning Bot Mode on later. The next app
//!   start or Bot Mode command turns it off again and says so.
//! - Valve's updater rewriting `gameinfo.gi` at the same instant as a toggle: the toggle compares
//!   the file's hash before writing and again just before renaming its new content into place
//!   (`ChangeSet::put_bytes_if_unchanged`), which narrows the window but cannot close it.

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
        let result = changes::run_kind(layout, probe, lock, op, Kind::Session, |cs| cs.put_bytes_if_unchanged("gameinfo.gi", new.as_bytes(), &read_hash));
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
/// launch mode). Returns the final status, also left in the status file. It returns only once
/// Bot Mode is confirmed off, or when it could not start at all (with nothing turned on).
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
    let watch_mode = match mode {
        RunMode::Launch => {
            let Some(steam) = steam else { return fail("no Steam configuration to launch with".into()) };
            match start_cs2(layout, probe, sys, steam, spawn) {
                Ok((since, meta)) => {
                    r.update(|s| s.bot_mode_on = meta);
                    Some(Mode::Launched { since })
                }
                // Nothing was turned on: nothing to undo.
                Err(StartError::BeforeOn(e)) => return fail(e),
                // Bot Mode may be on: go through the same turn-off loop as a finished session.
                Err(StartError::AfterOn(e)) => {
                    r.update(|s| s.errors.push(e.clone()));
                    launch_error = Some(e);
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
    // 6. Turn Bot Mode off, and leave only once it is confirmed off: a CS2 that started again
    // is watched until it exits, and a failure is retried, with the lease kept throughout.
    loop {
        match end(layout, probe, sys, &image) {
            End::Off(meta) => {
                r.update(|s| s.bot_mode_off = meta);
                break;
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
    }
    let outcome = match outcome {
        // CS2 never started and nothing appeared after: say so.
        None if checked.is_empty() && mode == RunMode::Launch => Outcome::NoStart { last_error: None },
        _ => Outcome::Exited { checked },
    };
    r.update(|s| {
        match &launch_error {
            Some(e) => {
                s.state = "failed".into();
                s.message = format!("{e}; Bot Mode was turned off again");
            }
            None => {
                s.state = "done".into();
                s.message = monitor::describe(&outcome);
            }
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
    /// The supervisor turns Bot Mode off with the loop it uses after every session.
    AfterOn(String),
}

/// Steps 2 to 4: under the operation lock, prepare, record the start time, turn Bot Mode on,
/// and ask Steam to start CS2. Any failure from the "on" write onward is `AfterOn`: the caller
/// keeps the lease and retries turning Bot Mode off until it is confirmed off.
fn start_cs2(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    sys: &dyn System,
    steam: &SteamConfig,
    spawn: &dyn Fn(&LaunchPlan) -> Result<(), String>,
) -> Result<(u64, Option<Meta>), StartError> {
    let lock = OpLock::acquire(layout).map_err(StartError::BeforeOn)?;
    let plan = launch::prepare(layout, probe, steam, &lock).map_err(StartError::BeforeOn)?;
    launch::check_start(&plan, layout, probe, steam).map_err(StartError::BeforeOn)?;
    // Taken before Bot Mode is on, so no CS2 that could have loaded the mod is older.
    let since = sys.file_time();
    changes::supersede_unfinished_sessions(layout).map_err(StartError::BeforeOn)?;
    let meta = set_bot_mode(layout, probe, &lock, true).map_err(StartError::AfterOn)?;
    spawn(&plan).map_err(StartError::AfterOn)?;
    Ok((since, meta))
}

enum End {
    /// Bot Mode is confirmed off (the change that turned it off, unless it already was).
    Off(Option<Meta>),
    /// A CS2 of this install runs, so Bot Mode cannot be turned off yet.
    StillRunning,
    /// Turning it off failed this time (CS2 could not be seen, the lock was busy, the write
    /// failed); the reason.
    Failed(String),
}

/// One attempt to turn Bot Mode off once no CS2 of this install runs, confirmed by reading
/// `gameinfo.gi` back.
fn end(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, image: &std::path::Path) -> End {
    match monitor::sweep(sys, image) {
        Ok((_, false)) => {}
        Ok((_, true)) => return End::StillRunning,
        Err(e) => return End::Failed(format!("whether CS2 still runs could not be checked ({e})")),
    }
    let lock = match OpLock::acquire(layout) {
        Ok(l) => l,
        Err(e) => return End::Failed(e),
    };
    match turn_off(layout, probe, &lock) {
        Ok(meta) if bot_mode(layout) == BotMode::Off => End::Off(meta),
        Ok(_) => End::Failed("gameinfo.gi does not read back as off".into()),
        Err(e) => End::Failed(e),
    }
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
    // Again under the operation lock: a supervisor may have taken the lease since.
    match session_held(&layout.csgo) {
        Ok(true) => return Cleanup::Supervised,
        Ok(false) => {}
        Err(e) => return Cleanup::Problem { why: e },
    }
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
/// have turned Bot Mode on before dying, so cleanup runs at once and its message is added.
pub fn start_launch(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    sys: &dyn System,
    start: &dyn Fn() -> Result<String, String>,
    start_adopter: &dyn Fn() -> Result<(), String>,
) -> Result<String, String> {
    start().map_err(|e| match cleanup_message(&cleanup(layout, probe, sys, start_adopter)) {
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
                died.message = "the Bot Mode supervisor stopped unexpectedly; the next Bot Mode command or app start turns Bot Mode off once CS2 has exited".into();
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
