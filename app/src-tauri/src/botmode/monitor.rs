//! The watch over CS2 during a Bot Mode session.
//!
//! Bot Mode is on only for a supervised session (`session.rs`), and while it is on, a
//! `cs2.exe` of this install running without `-insecure`, or with a token that turns VAC back
//! on, is a VAC risk whoever started it. So [`supervise`] checks every such process and ends
//! the unsafe ones, for the whole session: it returns when the last of them has exited.
//!
//! Which processes are checked:
//! - In a launch, those created at or after the moment just before Bot Mode was turned on
//!   (`since`). A CS2 created earlier read `gameinfo.gi` before the mod's search paths were
//!   there, so it never loaded the mod.
//! - When adopting a session left without a supervisor, all of them.
//! - Only processes whose executable is the same file (volume serial number and file index)
//!   as this install's `game\bin\win64\cs2.exe`.
//!
//! Each process is opened once, and that one handle confirms its creation time and executable,
//! reads its command line and, if needed, ends it, so a reused process id never sends the kill
//! to another program. A process is ended only when its creation time and executable both
//! check out; if either cannot be read, it is reported as unverified ("close CS2 now") and
//! checked again on the next poll. An end that fails keeps the process tracked and is retried.
//! A failure to read the process list is retried with backoff, never taken as "no CS2".

use super::process::judge_command_line;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A `cs2.exe` in the process list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Listed {
    pub pid: u32,
    /// Creation time as a Windows FILETIME (100 ns units since 1601).
    pub created: u64,
}

/// One open process. Every method works on the same handle.
pub trait Cs2Process {
    fn created(&self) -> Result<u64, String>;
    fn image(&self) -> Result<PathBuf, String>;
    fn command_line(&self) -> Result<String, String>;
    fn terminate(&self) -> Result<(), String>;
}

/// What the supervisor needs from the system, so tests can drive it.
pub trait System {
    fn cs2_list(&self) -> Result<Vec<Listed>, String>;
    /// Opens a process for reading its details and ending it; `None` when it has exited.
    fn open(&self, pid: u32) -> Result<Option<Box<dyn Cs2Process>>, String>;
    /// Whether two paths name the same file (same volume serial number and file index).
    fn same_file(&self, a: &Path, b: &Path) -> Result<bool, String>;
    /// The current time as a Windows FILETIME.
    fn file_time(&self) -> u64;
    /// Time elapsed on a steady clock.
    fn elapsed(&self) -> Duration;
    fn sleep(&self, d: Duration);
    /// Whether the process with this id and creation time is still running.
    fn alive(&self, pid: u32, created: u64) -> bool;
    /// This process's id and creation time.
    fn this_process(&self) -> Listed;
}

/// A verdict on one process, as reported to the user.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "verdict")]
pub enum Checked {
    /// `-insecure` confirmed, nothing turning VAC on; left running.
    Safe { pid: u32, command_line: String },
    /// Unsafe and ended.
    Ended { pid: u32, why: String },
    /// Unsafe, and ending it failed; tried again on every poll while it runs.
    EndFailed { pid: u32, why: String, error: String },
    /// Its creation time or executable could not be read, so it was neither trusted nor ended.
    Unverified { pid: u32, why: String },
}

/// Progress for the user while the session runs.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "event")]
pub enum Event {
    /// No CS2 has started yet.
    Waiting { message: String },
    Checked { checked: Checked, message: String },
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "outcome")]
pub enum Outcome {
    /// CS2 ran and every process of this install has exited.
    Exited { checked: Vec<Checked> },
    /// No CS2 started within the limit.
    NoStart { last_error: Option<String> },
    /// The caller asked to stop. `cs2_running` says whether a CS2 of this install was still up.
    Stopped { cs2_running: bool, checked: Vec<Checked> },
}

impl Outcome {
    /// Whether any CS2 had to be ended or could not be ended or verified.
    pub fn had_unsafe(&self) -> bool {
        let list = match self {
            Outcome::Exited { checked } | Outcome::Stopped { checked, .. } => checked,
            Outcome::NoStart { .. } => return false,
        };
        list.iter().any(|c| !matches!(c, Checked::Safe { .. }))
    }
}

/// Shown while no CS2 has started yet.
pub const WAITING: &str = "waiting for CS2 to start (Steam may be updating)";

/// Which processes the supervisor checks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Those created at or after `since` (FILETIME).
    Launched { since: u64 },
    /// Every one, for a session left without a supervisor.
    Adopt,
}

/// The caller's answer on each poll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    Go,
    Stop,
}

/// This install's game executable, from its `game\csgo` folder.
pub fn cs2_image(csgo: &Path) -> Result<PathBuf, String> {
    let exe = csgo.join("..").join("bin").join("win64").join("cs2.exe");
    exe.canonicalize().map_err(|e| format!("{}: {e}", exe.display()))
}

const POLL: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

enum Track {
    Safe,
    OtherInstall,
    /// Unsafe; ended or the end failed. Checked (and ended) again while it runs.
    Unsafe,
    Unverified(String),
}

enum Verdict {
    Gone,
    OtherInstall,
    Unverified(String),
    Safe(String),
    Ended(String),
    EndFailed(String, String),
}

/// Checks one process through a single handle.
fn check(sys: &dyn System, image: &Path, p: Listed) -> Verdict {
    let h = match sys.open(p.pid) {
        Ok(Some(h)) => h,
        Ok(None) => return Verdict::Gone,
        Err(e) => return Verdict::Unverified(format!("it could not be opened ({e})")),
    };
    match h.created() {
        Ok(t) if t == p.created => {}
        // The id now belongs to a process created at another time than the one listed.
        Ok(_) => return Verdict::Gone,
        Err(e) => return Verdict::Unverified(format!("its creation time could not be read ({e})")),
    }
    let img = match h.image() {
        Ok(img) => img,
        Err(e) => return Verdict::Unverified(format!("its executable could not be read ({e})")),
    };
    match sys.same_file(&img, image) {
        Ok(true) => {}
        Ok(false) => return Verdict::OtherInstall,
        Err(e) => return Verdict::Unverified(format!("its executable could not be compared with this install's ({e})")),
    }
    let line = h.command_line().ok();
    match judge_command_line(line.as_deref()) {
        Ok(()) => Verdict::Safe(line.unwrap_or_default()),
        Err(why) => match h.terminate() {
            Ok(()) => Verdict::Ended(why),
            Err(e) => Verdict::EndFailed(why, e),
        },
    }
}

/// A sentence about one verdict.
pub fn sentence(c: &Checked) -> String {
    match c {
        Checked::Safe { pid, .. } => format!("CS2 process {pid} has -insecure and nothing turning VAC on"),
        Checked::Ended { pid, why } => format!("CS2 process {pid} was ended at once: {why}"),
        Checked::EndFailed { pid, why, error } => {
            format!("CS2 process {pid} is unsafe ({why}) and ending it failed ({error}); close CS2 now. Bot Mode keeps trying")
        }
        Checked::Unverified { pid, why } => {
            format!("cs2.exe process {pid} could not be verified ({why}), so it was not ended; close CS2 now if it is running. Bot Mode keeps checking")
        }
    }
}

/// Watches CS2 for a whole session; see the module notes. `start_limit` bounds only the wait
/// for the first CS2 (none: no limit). `control` is asked on every poll; `progress` gets
/// [`Event::Waiting`] once while no CS2 has started, and each new verdict.
pub fn supervise(
    sys: &dyn System,
    image: &Path,
    mode: Mode,
    start_limit: Option<Duration>,
    control: &dyn Fn() -> Control,
    progress: &dyn Fn(&Event),
) -> Outcome {
    let start = sys.elapsed();
    let mut tracked: HashMap<Listed, Track> = HashMap::new();
    let mut checked: Vec<Checked> = Vec::new();
    let mut backoff = POLL;
    let mut last_error = None;
    let (mut started, mut told) = (false, false);
    let report = |c: Checked, checked: &mut Vec<Checked>| {
        progress(&Event::Checked { message: sentence(&c), checked: c.clone() });
        checked.push(c);
    };
    loop {
        let mut wait = POLL;
        match sys.cs2_list() {
            Err(e) => {
                last_error = Some(e);
                wait = backoff;
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
            Ok(list) => {
                backoff = POLL;
                let mine: Vec<Listed> = list
                    .into_iter()
                    .filter(|p| match mode {
                        Mode::Launched { since } => p.created >= since,
                        Mode::Adopt => true,
                    })
                    .collect();
                tracked.retain(|p, _| mine.contains(p));
                for p in mine {
                    if matches!(tracked.get(&p), Some(Track::Safe | Track::OtherInstall)) {
                        continue;
                    }
                    let was_unsafe = matches!(tracked.get(&p), Some(Track::Unsafe));
                    let was_unverified = match tracked.get(&p) {
                        Some(Track::Unverified(w)) => Some(w.clone()),
                        _ => None,
                    };
                    match check(sys, image, p) {
                        Verdict::Gone => {
                            tracked.remove(&p);
                        }
                        Verdict::OtherInstall => {
                            tracked.insert(p, Track::OtherInstall);
                        }
                        Verdict::Unverified(why) => {
                            started = true;
                            if was_unverified.as_deref() != Some(why.as_str()) {
                                report(Checked::Unverified { pid: p.pid, why: why.clone() }, &mut checked);
                            }
                            tracked.insert(p, Track::Unverified(why));
                        }
                        Verdict::Safe(line) => {
                            started = true;
                            report(Checked::Safe { pid: p.pid, command_line: line }, &mut checked);
                            tracked.insert(p, Track::Safe);
                        }
                        Verdict::Ended(why) => {
                            started = true;
                            if !was_unsafe {
                                report(Checked::Ended { pid: p.pid, why }, &mut checked);
                            }
                            tracked.insert(p, Track::Unsafe);
                        }
                        Verdict::EndFailed(why, error) => {
                            started = true;
                            if !was_unsafe {
                                report(Checked::EndFailed { pid: p.pid, why, error }, &mut checked);
                            }
                            tracked.insert(p, Track::Unsafe);
                        }
                    }
                }
                let running = tracked.values().any(|t| !matches!(t, Track::OtherInstall));
                if started && !running {
                    return Outcome::Exited { checked };
                }
            }
        }
        if control() == Control::Stop {
            let cs2_running = tracked.values().any(|t| !matches!(t, Track::OtherInstall));
            return Outcome::Stopped { cs2_running, checked };
        }
        if !started {
            if !told {
                progress(&Event::Waiting { message: WAITING.into() });
                told = true;
            }
            if start_limit.is_some_and(|l| sys.elapsed().saturating_sub(start) >= l) {
                return Outcome::NoStart { last_error };
            }
        }
        sys.sleep(wait);
    }
}

/// One pass over the running cs2.exe processes of this install: ends the unsafe ones and
/// reports whether any is still running (or could not be verified). Used when there is no
/// session to watch with: leftover cleanup, and the fail-closed path after a watcher panic.
pub fn sweep(sys: &dyn System, image: &Path) -> Result<(Vec<Checked>, bool), String> {
    let mut out = Vec::new();
    let mut running = false;
    for p in sys.cs2_list()? {
        match check(sys, image, p) {
            Verdict::Gone | Verdict::OtherInstall => {}
            Verdict::Safe(line) => {
                running = true;
                out.push(Checked::Safe { pid: p.pid, command_line: line });
            }
            Verdict::Ended(why) => out.push(Checked::Ended { pid: p.pid, why }),
            Verdict::EndFailed(why, error) => {
                running = true;
                out.push(Checked::EndFailed { pid: p.pid, why, error });
            }
            Verdict::Unverified(why) => {
                running = true;
                out.push(Checked::Unverified { pid: p.pid, why });
            }
        }
    }
    Ok((out, running))
}

/// A sentence for the user about an outcome.
pub fn describe(o: &Outcome) -> String {
    let list = |checked: &[Checked]| checked.iter().map(sentence).collect::<Vec<_>>().join("; ");
    match o {
        Outcome::Exited { checked } if o.had_unsafe() => format!("CS2 ran without VAC safely off at some point: {}.", list(checked)),
        Outcome::Exited { checked } => format!("{}. CS2 has exited.", list(checked)),
        Outcome::NoStart { last_error } => format!(
            "CS2 did not start{}.",
            last_error.as_deref().map(|e| format!(" (reading the process list last failed: {e})")).unwrap_or_default()
        ),
        Outcome::Stopped { cs2_running: true, .. } => "The watch stopped while CS2 was still running.".into(),
        Outcome::Stopped { .. } => "The watch stopped before CS2 started.".into(),
    }
}

/// The real system, on Windows.
pub struct Windows;

impl System for Windows {
    fn cs2_list(&self) -> Result<Vec<Listed>, String> {
        super::process::cs2_listed()
    }
    fn open(&self, pid: u32) -> Result<Option<Box<dyn Cs2Process>>, String> {
        Ok(super::process::OpenProcess::open(pid)?.map(|p| Box::new(p) as Box<dyn Cs2Process>))
    }
    fn same_file(&self, a: &Path, b: &Path) -> Result<bool, String> {
        Ok(super::process::file_id(a)? == super::process::file_id(b)?)
    }
    fn file_time(&self) -> u64 {
        super::process::file_time_now()
    }
    fn elapsed(&self) -> Duration {
        static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d)
    }
    fn alive(&self, pid: u32, created: u64) -> bool {
        super::process::alive(pid, created)
    }
    fn this_process(&self) -> Listed {
        super::process::this_process()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::botmode::testutil::{FakeSystem, IMAGE, SAFE_LINE};

    fn run(sys: &FakeSystem, mode: Mode, limit: Option<Duration>) -> (Outcome, Vec<Event>) {
        let said = std::cell::RefCell::new(Vec::new());
        let out = supervise(sys, Path::new(IMAGE), mode, limit, &|| Control::Go, &|e| said.borrow_mut().push(e.clone()));
        (out, said.into_inner())
    }

    const LAUNCH: Mode = Mode::Launched { since: 1000 };

    #[test]
    fn the_session_lasts_until_cs2_exits() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![], vec![], vec![(10, 2000)], vec![(10, 2000)], vec![(10, 2000)], vec![]]);
        sys.proc(10, 2000, Some(SAFE_LINE));
        let (out, said) = run(&sys, LAUNCH, Some(Duration::from_secs(900)));
        assert!(matches!(out, Outcome::Exited { .. }) && !out.had_unsafe(), "{out:?}");
        assert_eq!(sys.polls(), 6, "watched until the last poll, when CS2 had exited");
        assert!(matches!(said[0], Event::Waiting { .. }));
    }

    #[test]
    fn a_second_unsafe_cs2_during_the_session_is_ended_and_the_safe_one_kept() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![(10, 2000)], vec![(10, 2000), (11, 3000)], vec![(10, 2000)], vec![]]);
        sys.proc(10, 2000, Some(SAFE_LINE));
        sys.proc(11, 3000, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, LAUNCH, None);
        assert!(out.had_unsafe(), "{out:?}");
        assert!(!sys.ended(10) && sys.ended(11));
    }

    #[test]
    fn a_process_whose_identity_cannot_be_verified_is_never_ended() {
        for broken in ["created", "image", "same_file"] {
            let sys = FakeSystem::new();
            sys.script(vec![vec![(10, 2000)], vec![(10, 2000)], vec![]]);
            sys.proc(10, 2000, Some("cs2.exe -novid"));
            sys.break_identity(10, broken);
            let (out, said) = run(&sys, LAUNCH, None);
            assert!(!sys.ended(10), "{broken}: not ended without a verified identity");
            assert!(matches!(out, Outcome::Exited { .. }), "{broken}: the session waited for it to exit: {out:?}");
            let unverified: Vec<_> = said.iter().filter(|e| matches!(e, Event::Checked { checked: Checked::Unverified { .. }, .. })).collect();
            assert_eq!(unverified.len(), 1, "{broken}: reported once, rechecked quietly: {said:?}");
            assert!(sentence(&Checked::Unverified { pid: 10, why: String::new() }).contains("close CS2 now"));
        }
    }

    #[test]
    fn an_end_that_fails_is_tried_again_until_the_process_is_gone() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![(10, 2000)], vec![(10, 2000)], vec![(10, 2000)], vec![]]);
        sys.proc(10, 2000, Some("cs2.exe -novid"));
        sys.fail_ends(10, 2);
        let (out, said) = run(&sys, LAUNCH, None);
        assert_eq!(sys.end_attempts(10), 3, "tried on every poll while it ran");
        assert!(matches!(out, Outcome::Exited { .. }));
        assert!(said.iter().any(|e| matches!(e, Event::Checked { checked: Checked::EndFailed { .. }, .. })), "the failure is shown");
    }

    #[test]
    fn a_cs2_created_before_bot_mode_was_turned_on_is_never_touched() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![(9, 999)]]);
        sys.proc(9, 999, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, LAUNCH, Some(Duration::from_secs(5)));
        assert!(matches!(out, Outcome::NoStart { .. }), "{out:?}");
        assert!(!sys.ended(9));
        // Adopting a session left without a supervisor checks it whatever its age.
        let sys = FakeSystem::new();
        sys.script(vec![vec![(9, 999)], vec![]]);
        sys.proc(9, 999, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, Mode::Adopt, None);
        assert!(sys.ended(9) && out.had_unsafe());
    }

    #[test]
    fn another_installs_cs2_is_left_alone_and_does_not_hold_the_session() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![(10, 2000), (12, 2000)], vec![(12, 2000)]]);
        sys.proc(10, 2000, Some(SAFE_LINE));
        sys.proc_at(12, 2000, r"D:\Other\game\bin\win64\cs2.exe", Some("cs2.exe -novid"));
        let (out, _) = run(&sys, LAUNCH, None);
        assert!(matches!(out, Outcome::Exited { .. }), "{out:?}");
        assert!(!sys.ended(12));
    }

    #[test]
    fn a_reused_id_with_another_creation_time_is_not_judged() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![(10, 3000)], vec![]]);
        sys.proc(10, 4000, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, LAUNCH, Some(Duration::from_secs(5)));
        assert!(matches!(out, Outcome::NoStart { .. }), "{out:?}");
        assert!(!sys.ended(10));
    }

    #[test]
    fn a_process_list_error_is_retried_with_backoff() {
        let sys = FakeSystem::new();
        sys.script_results(vec![Err("snapshot failed".into()), Err("snapshot failed".into()), Ok(vec![(10, 2000)]), Ok(vec![])]);
        sys.proc(10, 2000, Some(SAFE_LINE));
        let (out, _) = run(&sys, LAUNCH, None);
        assert!(matches!(out, Outcome::Exited { .. }), "{out:?}");
        assert_eq!(&sys.sleeps()[..2], [Duration::from_millis(250), Duration::from_millis(500)]);
    }

    #[test]
    fn no_cs2_within_the_limit_ends_the_wait_at_the_limit() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![]]);
        let (out, said) = run(&sys, LAUNCH, Some(Duration::from_secs(900)));
        assert_eq!(out, Outcome::NoStart { last_error: None });
        assert_eq!(said, [Event::Waiting { message: WAITING.into() }]);
        let waited = sys.clock();
        assert!(waited >= Duration::from_secs(900) && waited < Duration::from_secs(901), "{waited:?}");
    }

    #[test]
    fn stopping_reports_whether_cs2_was_still_running() {
        let sys = FakeSystem::new();
        sys.script(vec![vec![(10, 2000)]]);
        sys.proc(10, 2000, Some(SAFE_LINE));
        let polls = std::cell::Cell::new(0);
        let out = supervise(&sys, Path::new(IMAGE), LAUNCH, Some(Duration::from_secs(60)), &|| {
            polls.set(polls.get() + 1);
            if polls.get() > 2 { Control::Stop } else { Control::Go }
        }, &|_| {});
        assert!(matches!(out, Outcome::Stopped { cs2_running: true, .. }), "{out:?}");
    }

    #[test]
    fn outcomes_serialize_as_the_app_expects() {
        let o = Outcome::Exited {
            checked: vec![
                Checked::Safe { pid: 1, command_line: "cs2.exe -insecure".into() },
                Checked::EndFailed { pid: 2, why: "w".into(), error: "e".into() },
            ],
        };
        assert_eq!(
            serde_json::to_value(&o).unwrap(),
            serde_json::json!({"outcome": "exited", "checked": [
                {"verdict": "safe", "pid": 1, "commandLine": "cs2.exe -insecure"},
                {"verdict": "endFailed", "pid": 2, "why": "w", "error": "e"}
            ]})
        );
        assert_eq!(serde_json::to_value(Outcome::NoStart { last_error: None }).unwrap(), serde_json::json!({"outcome": "noStart", "lastError": null}));
        assert_eq!(serde_json::to_value(Event::Waiting { message: "m".into() }).unwrap(), serde_json::json!({"event": "waiting", "message": "m"}));
    }
}
