//! The check on every CS2 process that starts after Bot Mode asks Steam to launch the game.
//!
//! While the mod's files are installed, a `cs2.exe` running without `-insecure`, or with a
//! token that turns VAC back on, is a VAC risk whoever started it, and Steam runs one CS2 at a
//! time. So the watcher does not try to tell "our" process from another: it checks every
//! `cs2.exe` that
//! - was created after the spawn (a process seen before the spawn, matched by id and creation
//!   time, is never touched, and a reused id with a new creation time counts as new), and
//! - runs from this install's `game\bin\win64\cs2.exe`,
//!
//! and ends only the unsafe ones. Each process is opened once, and that one handle is used to
//! confirm its creation time and image, read its command line and, if needed, end it, so a
//! process id that is reused in between can never send the kill to another program.
//!
//! The watcher has no fail-open timeout. The app keeps watching until a CS2 starts and gets a
//! verdict, or Bot Mode is turned off or rolled back. The CLI waits up to 15 minutes and then
//! fails, saying VAC safety is unverified. A failure to read the process list is retried with
//! backoff, never taken as "no CS2".

use super::process::judge_command_line;
use serde::Serialize;
use std::collections::HashSet;
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

/// What the watcher needs from the system, so tests can drive it.
pub trait System {
    fn cs2_list(&self) -> Result<Vec<Listed>, String>;
    /// Opens a process for reading its details and ending it; `None` when it has exited.
    fn open(&self, pid: u32) -> Result<Option<Box<dyn Cs2Process>>, String>;
    /// The current time as a Windows FILETIME.
    fn file_time(&self) -> u64;
    /// Time elapsed on a steady clock.
    fn elapsed(&self) -> Duration;
    fn sleep(&self, d: Duration);
}

/// What happened to one process the watcher checked.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "verdict")]
pub enum Checked {
    /// `-insecure` confirmed, nothing turning VAC on; left running.
    Safe { pid: u32, command_line: String },
    /// Unsafe; `ended` says whether ending it worked.
    Ended { pid: u32, why: String, ended: Result<(), String> },
    /// Not this install's cs2.exe; left alone.
    OtherInstall { pid: u32, image: String },
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "outcome")]
pub enum Outcome {
    /// A CS2 started and every new one was checked; none was unsafe.
    Safe { checked: Vec<Checked> },
    /// At least one new CS2 was unsafe and was ended (or ending it failed).
    Unsafe { checked: Vec<Checked> },
    /// No CS2 started within the limit; safety is unverified.
    TimedOut { last_error: Option<String> },
    /// Bot Mode was turned off or rolled back while waiting.
    Stopped,
}

/// Shown while no CS2 has started yet.
pub const WAITING: &str = "waiting for CS2 to start (Steam may be updating)";

/// What the watcher compares new processes against.
#[derive(Debug, Clone)]
pub struct Baseline {
    /// Every cs2.exe running just before the spawn.
    pub before: Vec<Listed>,
    /// When Steam was asked to start the game.
    pub spawned_at: u64,
    /// This install's `game\bin\win64\cs2.exe`, canonical.
    pub image: PathBuf,
}

/// This install's game executable, from its `game\csgo` folder.
pub fn cs2_image(csgo: &Path) -> Result<PathBuf, String> {
    let exe = csgo.join("..").join("bin").join("win64").join("cs2.exe");
    exe.canonicalize().map_err(|e| format!("{}: {e}", exe.display()))
}

/// The list of cs2.exe processes and the time, taken right before the spawn.
pub fn baseline(sys: &dyn System, csgo: &Path) -> Result<Baseline, String> {
    let image = cs2_image(csgo)?;
    let before = sys.cs2_list()?;
    Ok(Baseline { before, spawned_at: sys.file_time(), image })
}

fn same_path(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| p.to_string_lossy().trim_start_matches(r"\\?\").to_lowercase();
    norm(a) == norm(b)
}

const POLL: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

/// Watches until every new CS2 has a verdict, `stop()` says Bot Mode is gone, or `limit`
/// passes (none: no limit). `progress` gets [`WAITING`] once, when no CS2 has started yet.
pub fn watch(sys: &dyn System, base: &Baseline, limit: Option<Duration>, stop: &dyn Fn() -> bool, progress: &dyn Fn(&str)) -> Outcome {
    let start = sys.elapsed();
    let mut seen: HashSet<Listed> = base.before.iter().copied().collect();
    let mut backoff = POLL;
    let mut last_error = None;
    let mut told = false;
    loop {
        if stop() {
            return Outcome::Stopped;
        }
        let mut wait = POLL;
        match sys.cs2_list() {
            Err(e) => {
                last_error = Some(e);
                wait = backoff;
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
            Ok(list) => {
                backoff = POLL;
                let mut checked = Vec::new();
                for p in list {
                    if p.created < base.spawned_at || !seen.insert(p) {
                        continue;
                    }
                    if let Some(c) = check(sys, base, p) {
                        checked.push(c);
                    }
                }
                if checked.iter().any(|c| matches!(c, Checked::Ended { .. })) {
                    return Outcome::Unsafe { checked };
                }
                if checked.iter().any(|c| matches!(c, Checked::Safe { .. })) {
                    return Outcome::Safe { checked };
                }
            }
        }
        if !told {
            progress(WAITING);
            told = true;
        }
        if limit.is_some_and(|l| sys.elapsed().saturating_sub(start) >= l) {
            return Outcome::TimedOut { last_error };
        }
        sys.sleep(wait);
    }
}

/// Checks one new process through a single handle. `None` when it is not a process to judge:
/// it exited before it could be opened, or its id was reused by a process created at another
/// time than the one listed.
fn check(sys: &dyn System, base: &Baseline, p: Listed) -> Option<Checked> {
    let h = match sys.open(p.pid) {
        Ok(Some(h)) => h,
        Ok(None) => return None,
        // Without a handle it can be neither read nor ended. It is reported as unsafe so the
        // user closes it; the watcher never reopens it by id.
        Err(e) => {
            return Some(Checked::Ended { pid: p.pid, why: format!("it could not be opened ({e})"), ended: Err("no handle to end it with".into()) })
        }
    };
    match h.created() {
        Ok(t) if t == p.created => {}
        Ok(_) => return None,
        Err(e) => {
            let ended = h.terminate();
            return Some(Checked::Ended { pid: p.pid, why: format!("its creation time could not be read ({e})"), ended });
        }
    }
    match h.image() {
        Ok(img) if same_path(&img, &base.image) => {}
        Ok(img) => return Some(Checked::OtherInstall { pid: p.pid, image: img.display().to_string() }),
        Err(e) => {
            let ended = h.terminate();
            return Some(Checked::Ended { pid: p.pid, why: format!("its executable could not be read ({e})"), ended });
        }
    }
    let line = h.command_line().ok();
    match judge_command_line(line.as_deref()) {
        Ok(()) => Some(Checked::Safe { pid: p.pid, command_line: line.unwrap_or_default() }),
        Err(why) => {
            let ended = h.terminate();
            Some(Checked::Ended { pid: p.pid, why, ended })
        }
    }
}

/// A sentence for the user about an outcome.
pub fn describe(o: &Outcome) -> String {
    let list = |checked: &[Checked]| {
        checked
            .iter()
            .map(|c| match c {
                Checked::Safe { pid, .. } => format!("CS2 process {pid} has -insecure and nothing turning VAC on"),
                Checked::Ended { pid, why, ended: Ok(()) } => format!("CS2 process {pid} was ended at once: {why}"),
                Checked::Ended { pid, why, ended: Err(e) } => format!("CS2 process {pid} is unsafe ({why}) and ending it failed ({e}); close CS2 now"),
                Checked::OtherInstall { pid, image } => format!("cs2.exe process {pid} runs from another install ({image}) and was left alone"),
            })
            .collect::<Vec<_>>()
            .join("; ")
    };
    match o {
        Outcome::Safe { checked } => format!("{}.", list(checked)),
        Outcome::Unsafe { checked } => format!("CS2 started without VAC safely off. {}.", list(checked)),
        Outcome::TimedOut { last_error } => format!(
            "CS2 has not started, so its VAC safety is unverified{}. If it starts later, close it and launch again from Bot Mode.",
            last_error.as_deref().map(|e| format!(" (reading the process list last failed: {e})")).unwrap_or_default()
        ),
        Outcome::Stopped => "Bot Mode was turned off or rolled back before CS2 started; the check stopped.".into(),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::{HashMap, VecDeque};
    use std::rc::Rc;

    const IMAGE: &str = r"C:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe";
    const SAFE: &str = r#""C:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe" -insecure -novid"#;

    #[derive(Clone)]
    struct Proc {
        created: u64,
        image: String,
        line: Option<String>,
        ended: Rc<Cell<bool>>,
    }

    impl Cs2Process for Proc {
        fn created(&self) -> Result<u64, String> {
            Ok(self.created)
        }
        fn image(&self) -> Result<PathBuf, String> {
            Ok(PathBuf::from(&self.image))
        }
        fn command_line(&self) -> Result<String, String> {
            self.line.clone().ok_or_else(|| "access denied".into())
        }
        fn terminate(&self) -> Result<(), String> {
            self.ended.set(true);
            Ok(())
        }
    }

    /// Process lists returned one per poll (the last repeats), processes by id, and a clock
    /// that only moves when the watcher sleeps.
    struct Fake {
        lists: RefCell<VecDeque<Result<Vec<Listed>, String>>>,
        procs: RefCell<HashMap<u32, Proc>>,
        clock: Cell<Duration>,
        sleeps: RefCell<Vec<Duration>>,
    }

    impl Fake {
        fn new(lists: Vec<Result<Vec<Listed>, String>>) -> Fake {
            Fake { lists: RefCell::new(lists.into()), procs: RefCell::new(HashMap::new()), clock: Cell::new(Duration::ZERO), sleeps: RefCell::new(Vec::new()) }
        }
        fn proc(&self, pid: u32, created: u64, line: Option<&str>) -> Rc<Cell<bool>> {
            self.proc_at(pid, created, IMAGE, line)
        }
        fn proc_at(&self, pid: u32, created: u64, image: &str, line: Option<&str>) -> Rc<Cell<bool>> {
            let ended = Rc::new(Cell::new(false));
            self.procs.borrow_mut().insert(pid, Proc { created, image: image.into(), line: line.map(String::from), ended: ended.clone() });
            ended
        }
    }

    impl System for Fake {
        fn cs2_list(&self) -> Result<Vec<Listed>, String> {
            let mut l = self.lists.borrow_mut();
            if l.len() > 1 {
                l.pop_front().unwrap()
            } else {
                l.front().cloned().unwrap_or(Ok(Vec::new()))
            }
        }
        fn open(&self, pid: u32) -> Result<Option<Box<dyn Cs2Process>>, String> {
            Ok(self.procs.borrow().get(&pid).cloned().map(|p| Box::new(p) as Box<dyn Cs2Process>))
        }
        fn file_time(&self) -> u64 {
            1000
        }
        fn elapsed(&self) -> Duration {
            self.clock.get()
        }
        fn sleep(&self, d: Duration) {
            self.sleeps.borrow_mut().push(d);
            self.clock.set(self.clock.get() + d);
        }
    }

    fn base(before: Vec<Listed>) -> Baseline {
        Baseline { before, spawned_at: 1000, image: PathBuf::from(IMAGE) }
    }

    fn run(sys: &Fake, b: &Baseline, limit: Option<Duration>) -> (Outcome, Vec<String>) {
        let said = RefCell::new(Vec::new());
        let out = watch(sys, b, limit, &|| false, &|m| said.borrow_mut().push(m.to_string()));
        (out, said.into_inner())
    }

    fn l(pid: u32, created: u64) -> Listed {
        Listed { pid, created }
    }

    #[test]
    fn a_safe_cs2_that_starts_at_once_is_left_running() {
        let sys = Fake::new(vec![Ok(vec![l(10, 2000)])]);
        let ended = sys.proc(10, 2000, Some(SAFE));
        let (out, said) = run(&sys, &base(vec![]), Some(Duration::from_secs(900)));
        assert!(matches!(out, Outcome::Safe { .. }), "{out:?}");
        assert!(!ended.get());
        assert!(said.is_empty(), "no waiting message when CS2 is already there");
    }

    #[test]
    fn a_late_start_is_waited_for_and_says_so() {
        let mut lists = vec![Ok(vec![]); 40];
        lists.push(Ok(vec![l(10, 2000)]));
        let sys = Fake::new(lists);
        sys.proc(10, 2000, Some(SAFE));
        let (out, said) = run(&sys, &base(vec![]), None);
        assert!(matches!(out, Outcome::Safe { .. }), "{out:?}");
        assert_eq!(said, [WAITING]);
        assert!(sys.clock.get() >= Duration::from_secs(10));
    }

    #[test]
    fn an_unsafe_cs2_is_ended_and_an_unreadable_one_too() {
        for line in [Some(SAFE.replace("-insecure", "-secure")), Some(SAFE.replace(" -insecure", "")), None] {
            let sys = Fake::new(vec![Ok(vec![l(10, 2000)])]);
            let ended = sys.proc(10, 2000, line.as_deref());
            let (out, _) = run(&sys, &base(vec![]), None);
            assert!(matches!(out, Outcome::Unsafe { .. }), "{line:?}: {out:?}");
            assert!(ended.get(), "{line:?}: ended");
        }
    }

    #[test]
    fn several_new_processes_are_each_judged_and_only_unsafe_ones_ended() {
        let sys = Fake::new(vec![Ok(vec![l(10, 2000), l(11, 2001), l(12, 2002)])]);
        let safe = sys.proc(10, 2000, Some(SAFE));
        let bad = sys.proc(11, 2001, Some("cs2.exe -novid"));
        let other = sys.proc_at(12, 2002, r"D:\Other\game\bin\win64\cs2.exe", Some("cs2.exe -novid"));
        let (out, _) = run(&sys, &base(vec![]), None);
        let Outcome::Unsafe { checked } = out else { panic!("{out:?}") };
        assert_eq!(checked.len(), 3);
        assert!(!safe.get() && bad.get() && !other.get(), "only the unsafe one of this install is ended");
    }

    #[test]
    fn a_process_list_error_is_retried_with_backoff() {
        let sys = Fake::new(vec![Err("snapshot failed".into()), Err("snapshot failed".into()), Ok(vec![l(10, 2000)])]);
        sys.proc(10, 2000, Some(SAFE));
        let (out, _) = run(&sys, &base(vec![]), None);
        assert!(matches!(out, Outcome::Safe { .. }), "{out:?}");
        assert_eq!(sys.sleeps.borrow().as_slice(), [Duration::from_millis(250), Duration::from_millis(500)]);
    }

    #[test]
    fn older_processes_are_never_touched_and_a_reused_id_counts_as_new() {
        // pid 10 ran before the spawn; pid 10 again, created later, is a new process.
        let older = l(10, 500);
        let sys = Fake::new(vec![Ok(vec![older]), Ok(vec![l(10, 3000)])]);
        let ended = sys.proc(10, 3000, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, &base(vec![older]), None);
        assert!(matches!(out, Outcome::Unsafe { .. }), "{out:?}");
        assert!(ended.get());

        // Listed as created at 3000, but the opened handle belongs to a process created at
        // 4000: the id was reused in between, so that process is not judged or ended.
        let sys = Fake::new(vec![Ok(vec![l(10, 3000)]), Ok(vec![])]);
        let ended = sys.proc(10, 4000, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, &base(vec![]), Some(Duration::from_secs(5)));
        assert!(matches!(out, Outcome::TimedOut { .. }), "{out:?}");
        assert!(!ended.get());
    }

    #[test]
    fn a_process_created_before_the_spawn_is_never_touched_even_if_the_baseline_missed_it() {
        // Started between the baseline snapshot and the spawn: not in `before`, but older.
        let sys = Fake::new(vec![Ok(vec![l(11, 900)])]);
        let ended = sys.proc(11, 900, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, &base(vec![]), Some(Duration::from_secs(5)));
        assert!(matches!(out, Outcome::TimedOut { .. }), "{out:?}");
        assert!(!ended.get());
    }

    #[test]
    fn a_process_in_the_baseline_is_never_touched_even_if_the_clock_moved_back() {
        // The system clock was set back, so a process that ran before the spawn has a
        // creation time after it. Being in `before` still keeps it safe from the watcher.
        let older = l(12, 1500);
        let sys = Fake::new(vec![Ok(vec![older])]);
        let ended = sys.proc(12, 1500, Some("cs2.exe -novid"));
        let (out, _) = run(&sys, &base(vec![older]), Some(Duration::from_secs(5)));
        assert!(matches!(out, Outcome::TimedOut { .. }), "{out:?}");
        assert!(!ended.get());
    }

    #[test]
    fn with_a_limit_and_no_cs2_the_check_ends_unverified() {
        let sys = Fake::new(vec![Err("snapshot failed".into()), Ok(vec![])]);
        let (out, said) = run(&sys, &base(vec![]), Some(Duration::from_secs(900)));
        assert_eq!(out, Outcome::TimedOut { last_error: Some("snapshot failed".into()) });
        assert_eq!(said, [WAITING]);
        assert!(describe(&out).contains("unverified"));
        let waited = sys.clock.get();
        assert!(waited >= Duration::from_secs(900) && waited < Duration::from_secs(901), "ends at the limit, not later: {waited:?}");
    }

    #[test]
    fn turning_bot_mode_off_stops_the_wait() {
        let sys = Fake::new(vec![Ok(vec![])]);
        let polls = Cell::new(0);
        // The limit only bounds the test if stopping were broken.
        let out = watch(&sys, &base(vec![]), Some(Duration::from_secs(60)), &|| {
            polls.set(polls.get() + 1);
            polls.get() > 3
        }, &|_| {});
        assert_eq!(out, Outcome::Stopped);
        assert_eq!(polls.get(), 4);
    }
}

#[cfg(test)]
mod json {
    use super::*;

    /// The app's TypeScript types (`app/src/botmode/commands.ts`) read these exact shapes.
    #[test]
    fn outcomes_serialize_as_the_app_expects() {
        let o = Outcome::Unsafe {
            checked: vec![
                Checked::Safe { pid: 1, command_line: "cs2.exe -insecure".into() },
                Checked::Ended { pid: 2, why: "w".into(), ended: Err("e".into()) },
            ],
        };
        assert_eq!(
            serde_json::to_value(&o).unwrap(),
            serde_json::json!({"outcome": "unsafe", "checked": [
                {"verdict": "safe", "pid": 1, "commandLine": "cs2.exe -insecure"},
                {"verdict": "ended", "pid": 2, "why": "w", "ended": {"Err": "e"}}
            ]})
        );
        assert_eq!(serde_json::to_value(Outcome::TimedOut { last_error: None }).unwrap(), serde_json::json!({"outcome": "timedOut", "lastError": null}));
    }
}
