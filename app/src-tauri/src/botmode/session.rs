//! Supervised Bot Mode sessions.
//!
//! Bot Mode is on only while a session runs. Launch turns it on (the two `gameinfo.gi` search
//! paths, written through a journaled change) right before Steam is asked to start CS2, then
//! watches CS2 for the whole session (`monitor::supervise`) and turns it off again when the
//! last CS2 of this install has exited, or when CS2 never started. The mod's other files stay
//! on disk; without the search paths CS2 does not load them.
//!
//! A session is marked by `session.json` in the app folder, naming the process that
//! supervises it. Whenever Bot Mode is found on with no live supervisor (the app or the CLI
//! died mid-session), [`cleanup`] turns it off once CS2 is not running, ends an unsafe CS2,
//! and hands a safe one back to be adopted and supervised until it exits.
//!
//! What this cannot cover: the app crashes during a session and the user then starts CS2 from
//! Steam before Bot Mode runs again. Bot Mode is still on in `gameinfo.gi` and nothing is
//! watching. [`UNPROTECTED`] is the notice the app shows about it.

use super::changes::{self, Meta};
use super::gameinfo;
use super::launch::{self, LaunchPlan};
use super::monitor::{self, Checked, Control, Event, Listed, Mode, Outcome, System};
use super::paths::Layout;
use super::process::{OpLock, ProcessProbe};
use super::steam::SteamConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// Shown with Bot Mode in the app and the CLI.
pub const UNPROTECTED: &str =
    "Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.";

/// Whether the `gameinfo.gi` search paths are in place. `Unknown` when the file cannot be read
/// or parsed: callers retry or report, and never treat it as off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotMode {
    On,
    Off,
    Unknown(String),
}

pub fn bot_mode(layout: &Layout) -> BotMode {
    let read = layout
        .confined("gameinfo.gi")
        .and_then(|p| std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display())))
        .and_then(|t| gameinfo::is_bot_mode(&t));
    match read {
        Ok(true) => BotMode::On,
        Ok(false) => BotMode::Off,
        Err(e) => BotMode::Unknown(e),
    }
}

/// `session.json`: the process supervising the current session.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub pid: u32,
    pub created: u64,
    pub csgo: String,
}

fn marker_path(layout: &Layout) -> PathBuf {
    layout.data.join("session.json")
}

fn write_marker(layout: &Layout, sys: &dyn System) -> Result<(), String> {
    let me = sys.this_process();
    let m = Marker { pid: me.pid, created: me.created, csgo: layout.csgo.display().to_string() };
    changes::write_atomic(&marker_path(layout), serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?.as_bytes())
}

fn remove_marker(layout: &Layout) {
    let _ = std::fs::remove_file(marker_path(layout));
}

/// Whether a supervisor recorded in `session.json` is still running.
pub fn supervised(layout: &Layout, sys: &dyn System) -> bool {
    let Ok(text) = std::fs::read_to_string(marker_path(layout)) else { return false };
    serde_json::from_str::<Marker>(&text).is_ok_and(|m| sys.alive(m.pid, m.created) || sys.this_process() == Listed { pid: m.pid, created: m.created })
}

fn set_bot_mode(layout: &Layout, probe: &dyn ProcessProbe, lock: &OpLock, on: bool) -> Result<Option<Meta>, String> {
    let path = layout.confined("gameinfo.gi")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let new = if on { gameinfo::enable(&text)? } else { gameinfo::disable(&text)? };
    if new == text {
        return Ok(None);
    }
    let op = if on { "bot-mode-on" } else { "bot-mode-off" };
    Ok(Some(changes::run_kind(layout, probe, lock, op, changes::Kind::Session, |cs| cs.put_bytes("gameinfo.gi", new.as_bytes()))?.1))
}

/// Takes the operation lock, retrying for a while: turning Bot Mode off after a session must
/// not fail just because another operation is finishing.
fn lock_patiently(layout: &Layout, sys: &dyn System) -> Result<OpLock, String> {
    let mut last = String::new();
    for _ in 0..40 {
        match OpLock::acquire(layout) {
            Ok(l) => return Ok(l),
            Err(e) => last = e,
        }
        sys.sleep(Duration::from_millis(500));
    }
    Err(last)
}

/// A launch that has asked Steam to start CS2, with Bot Mode on.
#[derive(Debug, Clone)]
pub struct Started {
    pub plan: LaunchPlan,
    /// FILETIME taken just before Bot Mode was turned on; only CS2 created from then on is
    /// checked, since an older one never loaded the mod.
    pub since: u64,
    /// This install's cs2.exe.
    pub image: PathBuf,
    /// The change that turned Bot Mode on, unless it was already on.
    pub bot_mode_on: Option<Meta>,
}

/// Prepares the launch, turns Bot Mode on, records the session and asks Steam to start CS2
/// (`spawn`). If Steam cannot be asked, Bot Mode is turned off again.
pub fn begin(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    steam: &SteamConfig,
    sys: &dyn System,
    spawn: &dyn Fn(&LaunchPlan) -> Result<(), String>,
) -> Result<Started, String> {
    let lock = OpLock::acquire(layout)?;
    let plan = launch::prepare(layout, probe, steam, &lock)?;
    launch::check_start(&plan, layout, probe, steam)?;
    let image = monitor::cs2_image(&layout.csgo)?;
    // Taken before Bot Mode is on, so no CS2 that could have loaded the mod is older.
    let since = sys.file_time();
    let bot_mode_on = set_bot_mode(layout, probe, &lock, true)?;
    if let Err(e) = write_marker(layout, sys).and_then(|_| spawn(&plan)) {
        let off = set_bot_mode(layout, probe, &lock, false);
        remove_marker(layout);
        return Err(match off {
            Ok(_) => format!("{e}; Bot Mode was turned off again"),
            Err(e2) => format!("{e}; turning Bot Mode off again also failed ({e2})"),
        });
    }
    Ok(Started { plan, since, image, bot_mode_on })
}

/// How a session ended.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionEnd {
    pub outcome: Outcome,
    /// The change that turned Bot Mode off.
    pub bot_mode_off: Option<Meta>,
    /// Set when Bot Mode could not be turned off, and why; the next start of the app or the
    /// CLI turns it off.
    pub left_on: Option<String>,
    /// Watcher failures that were caught and recovered from.
    pub errors: Vec<String>,
}

const RESTARTS: usize = 3;

fn panic_text(p: Box<dyn std::any::Any + Send>) -> String {
    p.downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

/// Runs the watcher with a panic boundary. After a panic it fails closed: one sweep ends any
/// unsafe CS2 of this install, and if a CS2 is still running, a fresh watcher adopts it.
pub fn supervise_guarded(
    sys: &dyn System,
    image: &std::path::Path,
    mode: Mode,
    start_limit: Option<Duration>,
    control: &dyn Fn() -> Control,
    progress: &dyn Fn(&Event),
) -> (Outcome, Vec<String>) {
    let mut errors = Vec::new();
    let mut mode = mode;
    for _ in 0..RESTARTS {
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| monitor::supervise(sys, image, mode, start_limit, control, progress)));
        match run {
            Ok(outcome) => return (outcome, errors),
            Err(p) => {
                errors.push(format!("the CS2 watcher failed ({}); it was restarted", panic_text(p)));
                let swept = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| monitor::sweep(sys, image)));
                match swept {
                    Ok(Ok((checked, running))) => {
                        for c in &checked {
                            progress(&Event::Checked { message: monitor::sentence(c), checked: c.clone() });
                        }
                        if !running {
                            return (Outcome::Exited { checked }, errors);
                        }
                    }
                    Ok(Err(e)) => errors.push(format!("checking CS2 after the failure: {e}")),
                    Err(p) => errors.push(format!("checking CS2 after the failure also failed ({})", panic_text(p))),
                }
                // Whatever runs now is checked whatever its age.
                mode = Mode::Adopt;
            }
        }
    }
    errors.push("the CS2 watcher kept failing; close CS2 now".into());
    (Outcome::Stopped { cs2_running: true, checked: Vec::new() }, errors)
}

/// Turns Bot Mode off after a session, once no CS2 of this install runs. If one still runs, or
/// whether one runs cannot be told, Bot Mode is left on and the reason returned.
pub fn end(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, image: &std::path::Path) -> (Option<Meta>, Option<String>) {
    let running = match monitor::sweep(sys, image) {
        Ok((_, running)) => running,
        Err(e) => return (None, Some(format!("whether CS2 still runs could not be checked ({e})"))),
    };
    if running {
        return (None, Some("a CS2 of this install is still running".into()));
    }
    let result = lock_patiently(layout, sys).and_then(|lock| set_bot_mode(layout, probe, &lock, false));
    match result {
        Ok(meta) => {
            remove_marker(layout);
            (meta, None)
        }
        Err(e) => (None, Some(e)),
    }
}

/// Watches a started launch until its CS2 exits (or never starts within `start_limit`), then
/// turns Bot Mode off.
pub fn run(
    layout: &Layout,
    probe: &dyn ProcessProbe,
    sys: &dyn System,
    started: &Started,
    start_limit: Option<Duration>,
    control: &dyn Fn() -> Control,
    progress: &dyn Fn(&Event),
) -> SessionEnd {
    let (outcome, errors) = supervise_guarded(sys, &started.image, Mode::Launched { since: started.since }, start_limit, control, progress);
    let (bot_mode_off, left_on) = end(layout, probe, sys, &started.image);
    SessionEnd { outcome, bot_mode_off, left_on, errors }
}

/// For a launch whose watcher could not be started: ends any CS2 the launch started and turns
/// Bot Mode off, so nothing runs with the mod unwatched. Returns a message for the user.
pub fn abort(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, started: &Started, why: &str) -> String {
    let mut notes = Vec::new();
    // Steam may still be starting CS2: give it a moment, then end what appeared.
    for _ in 0..20 {
        match sys.cs2_list() {
            Ok(list) => {
                for p in list.into_iter().filter(|p| p.created >= started.since) {
                    if let Ok(Some(h)) = sys.open(p.pid) {
                        let same = h.created().is_ok_and(|t| t == p.created)
                            && h.image().ok().is_some_and(|img| sys.same_file(&img, &started.image).unwrap_or(false));
                        if same {
                            match h.terminate() {
                                Ok(()) => notes.push(format!("CS2 process {} was ended", p.pid)),
                                Err(e) => notes.push(format!("ending CS2 process {} failed ({e}); close CS2 now", p.pid)),
                            }
                        }
                    }
                }
            }
            Err(e) => notes.push(format!("reading the process list failed ({e})")),
        }
        sys.sleep(Duration::from_millis(250));
    }
    let (_, left_on) = end(layout, probe, sys, &started.image);
    match left_on {
        None => notes.push("Bot Mode was turned off".into()),
        Some(e) => notes.push(format!("Bot Mode could not be turned off ({e})")),
    }
    format!("{why}, so the launch was undone: {}.", notes.join("; "))
}

/// What [`cleanup`] did.
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "result")]
pub enum Cleanup {
    /// Bot Mode is off; nothing to do.
    Off,
    /// A live supervisor owns the session.
    Supervised,
    /// Bot Mode was on with no supervisor and no CS2 running, and was turned off.
    TurnedOff { change: Option<Meta>, checked: Vec<Checked> },
    /// A safe CS2 of this install runs with Bot Mode on and no supervisor: adopt it.
    Adopt { checked: Vec<Checked> },
    /// Bot Mode could not be turned off (or its state read); the reason.
    LeftOn { why: String, checked: Vec<Checked> },
}

/// Deals with Bot Mode left on without a supervisor. Run when the app starts and before Bot
/// Mode CLI commands that change anything.
pub fn cleanup(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System) -> Cleanup {
    match bot_mode(layout) {
        BotMode::Off => return Cleanup::Off,
        BotMode::Unknown(why) => return Cleanup::LeftOn { why: format!("Bot Mode's state could not be read: {why}"), checked: Vec::new() },
        BotMode::On => {}
    }
    if supervised(layout, sys) {
        return Cleanup::Supervised;
    }
    let image = match monitor::cs2_image(&layout.csgo) {
        Ok(i) => i,
        Err(e) => return Cleanup::LeftOn { why: e, checked: Vec::new() },
    };
    let (checked, running) = match monitor::sweep(sys, &image) {
        Ok(r) => r,
        Err(e) => return Cleanup::LeftOn { why: format!("whether CS2 runs could not be checked ({e})"), checked: Vec::new() },
    };
    if running {
        return Cleanup::Adopt { checked };
    }
    // An unsafe CS2 that was just ended may take a moment to go.
    let mut tries = 0;
    loop {
        let (meta, left_on) = end(layout, probe, sys, &image);
        match left_on {
            None => return Cleanup::TurnedOff { change: meta, checked },
            Some(why) if tries >= 8 => return Cleanup::LeftOn { why, checked },
            Some(_) => {
                tries += 1;
                sys.sleep(Duration::from_millis(250));
            }
        }
    }
}

/// Supervises a CS2 that runs with Bot Mode on and no supervisor, until it exits, then turns
/// Bot Mode off.
pub fn adopt(layout: &Layout, probe: &dyn ProcessProbe, sys: &dyn System, control: &dyn Fn() -> Control, progress: &dyn Fn(&Event)) -> Result<SessionEnd, String> {
    let image = monitor::cs2_image(&layout.csgo)?;
    write_marker(layout, sys)?;
    let (outcome, errors) = supervise_guarded(sys, &image, Mode::Adopt, None, control, progress);
    let (bot_mode_off, left_on) = end(layout, probe, sys, &image);
    Ok(SessionEnd { outcome, bot_mode_off, left_on, errors })
}

/// The app's and CLI's watch control: stop only on a confirmed "off" or a request, and report
/// a state that cannot be read instead of stopping on it.
pub fn control_until_off<'a>(layout: &'a Layout, cancel: &'a dyn Fn() -> bool, report: &'a dyn Fn(&str)) -> impl Fn() -> Control + 'a {
    move || {
        if cancel() {
            return Control::Stop;
        }
        match bot_mode(layout) {
            BotMode::Off => Control::Stop,
            BotMode::On => Control::Go,
            BotMode::Unknown(e) => {
                report(&format!("Bot Mode's state could not be read ({e}); still watching CS2"));
                Control::Go
            }
        }
    }
}
