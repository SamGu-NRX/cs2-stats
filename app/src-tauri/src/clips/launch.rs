//! Launches, how clips operations are kept apart, and what proves a take complete (design/clips.md
//! "When a take counts").
//!
//! Keeping operations apart. Every clips command runs in this one app process, and each takes [`guard`]:
//! a process-wide mutex, so no scan, launch, settlement, finish, reel or part-file sweep interleaves with
//! another. The guard also holds the clips folder's OS lock, an exclusive handle on `clips.lock`, so a
//! second instance of the app cannot work on the same folder. The handle closes when this process ends,
//! however it ends, so no lock outlives its owner and there is nothing stale to clear. After a launch, a
//! watcher thread ([`watch`]) keeps the OS lock, waits on HLAE's process handle and then for no cs2.exe,
//! settles that launch under the guard, and only then lets the lock go.
//!
//! Each launch gets a fresh 128-bit nonce from the OS's random source and a sequence number one above
//! the job's highest, both assigned under the guard. The director script written for that launch logs
//! the nonce in every line, so a line carrying it can only come from that launch: a demo's chat and
//! player names were recorded before the nonce existed. Each launch leaves, in
//! `jobs\<job>\launches\`, files published by a rename that never replaces an existing one:
//! - `<nonce>.json`, before HLAE starts: the sequence number and the takes each clip already had;
//! - `<nonce>.pids.json`, once HLAE has started (in the same guarded step): its process id and creation
//!   time. A launch without it settles as damaged: HLAE may have started without being recorded;
//! - `<nonce>.result.json`, once that launch's processes have exited: the clips the director recorded to
//!   their end tick, read once from console.log and kept, because the next CS2 session replaces the log.
//!
//! A take belongs to the launch with the highest sequence number that started before it existed, and
//! counts only when that launch's result says the director ended its clip at the end tick.
//!
//! The processes: HLAE's custom loader starts cs2.exe, but nothing here can confirm that HLAE is the
//! parent the system records for it, so a launch's processes have exited when HLAE's own process (its id
//! and creation time) has exited and no cs2.exe is running.

use super::{file_inside, folder_in};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// The clips folder's lock file: held open exclusively while this process works on clips.
const LOCK: &str = "clips.lock";
/// A director line longer than this is cut there; END lines are about 100 bytes. Lines are streamed, so
/// memory stays constant however long the log is.
const MAX_LINE: usize = 4096;

/// A process, told apart from a later one that reuses its id by its creation time (FILETIME).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct ProcId {
    pub pid: u32,
    pub created: u64,
}

/// What the launch checks need from the system, so tests can stand in for it.
pub trait Procs {
    /// The process with this id and creation time is still running.
    fn alive(&self, p: &ProcId) -> bool;
    /// Any cs2.exe is running.
    fn cs2_running(&self) -> Result<bool, String>;
}

/// The real system: Windows process handles; elsewhere every check reports nothing running.
pub struct System;

impl Procs for System {
    fn alive(&self, p: &ProcId) -> bool {
        imp::alive(p)
    }
    fn cs2_running(&self) -> Result<bool, String> {
        Ok(!crate::botmode::process::cs2_listed()?.is_empty())
    }
}

/// The running process `pid`, with its creation time; None when it is not running.
pub fn proc_id(pid: u32) -> Option<ProcId> {
    imp::proc_id(pid)
}

#[cfg(windows)]
mod imp {
    use super::ProcId;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};

    /// The process's creation time while it is running (a zero wait times out); None once it has exited.
    pub fn proc_id(pid: u32) -> Option<ProcId> {
        // SAFETY: plain calls on a handle this function owns and closes.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
            if h.is_null() {
                return None;
            }
            let z = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut c, mut e, mut k, mut u) = (z(), z(), z(), z());
            let times = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0;
            let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
            CloseHandle(h);
            (times && running).then(|| ProcId { pid, created: (u64::from(c.dwHighDateTime) << 32) | u64::from(c.dwLowDateTime) })
        }
    }

    pub fn alive(p: &ProcId) -> bool {
        proc_id(p.pid).is_some_and(|q| q.created == p.created)
    }

    pub fn random(buf: &mut [u8]) -> Result<(), String> {
        use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
        let len = u32::try_from(buf.len()).map_err(|_| "random request too large".to_string())?;
        // SAFETY: fills `buf`, which is `len` bytes, from the system's preferred generator.
        let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
        if status != 0 {
            return Err(format!("the system's random source failed (NTSTATUS {status:#x})"));
        }
        Ok(())
    }

    /// The lock file opened with no sharing: a second open, by this or another process, fails until
    /// this handle closes, which the system does when the process ends.
    pub fn exclusive(path: &std::path::Path) -> std::io::Result<std::fs::File> {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).share_mode(0).open(path)
    }

    /// The open failed because another handle holds the file (ERROR_SHARING_VIOLATION).
    pub fn held_elsewhere(e: &std::io::Error) -> bool {
        e.raw_os_error() == Some(32)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::ProcId;
    pub fn proc_id(_pid: u32) -> Option<ProcId> {
        None
    }
    pub fn alive(_p: &ProcId) -> bool {
        false
    }
    pub fn random(buf: &mut [u8]) -> Result<(), String> {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(buf)).map_err(|e| format!("/dev/urandom: {e}"))
    }
    /// The app is Windows-only; elsewhere (CI's test builds) the file is opened without a lock.
    pub fn exclusive(path: &std::path::Path) -> std::io::Result<std::fs::File> {
        std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)
    }
    pub fn held_elsewhere(_e: &std::io::Error) -> bool {
        false
    }
}

/// A fresh launch nonce: 128 bits from the OS's random source, as 32 lowercase hex digits.
pub fn new_nonce() -> Result<String, String> {
    let mut b = [0u8; 16];
    imp::random(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

pub fn nonce_ok(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

// ---------------------------------------------------------------- keeping operations apart

/// The process-wide state behind [`guard`]: the clips folder's OS lock while held, and how many
/// launches' processes are still running (their watchers keep the OS lock).
struct State {
    os_lock: Option<(PathBuf, fs::File)>,
    running: usize,
}

static STATE: Mutex<State> = Mutex::new(State { os_lock: None, running: 0 });

/// One clips operation's exclusive hold: the process-wide mutex and the folder's OS lock.
pub struct Guard {
    st: MutexGuard<'static, State>,
}

/// Takes the mutex, waiting for any clips operation running in this process, and the OS lock on
/// `root\clips.lock`, refusing when another process holds it.
pub fn guard(root: &Path) -> Result<Guard, String> {
    let mut st = STATE.lock().unwrap_or_else(|p| p.into_inner());
    match &st.os_lock {
        Some((held, _)) if held == root => {}
        Some((held, _)) if st.running > 0 => {
            return Err(format!("a launch from {} is still running; wait for it to end", held.display()));
        }
        _ => {
            let path = root.join(LOCK);
            let f = imp::exclusive(&path).map_err(|e| {
                if imp::held_elsewhere(&e) {
                    "another instance of the app is working on clips; close it, or wait for its render to end".to_string()
                } else {
                    format!("{}: {e}", path.display())
                }
            })?;
            st.os_lock = Some((root.to_path_buf(), f));
        }
    }
    Ok(Guard { st })
}

impl Guard {
    /// A launch started processes: the OS lock stays after this guard ends, until its watcher settles it.
    pub fn launch_running(&mut self) {
        self.st.running += 1;
    }

    /// A launch's watcher has settled it: when no other launch runs, the OS lock goes with this guard.
    pub fn launch_done(&mut self) {
        self.st.running = self.st.running.saturating_sub(1);
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if self.st.running == 0 {
            self.st.os_lock = None;
        }
    }
}

/// Watches a launch on a thread of its own: waits on HLAE's process through the `Child` handle the
/// launch holds, then for no cs2.exe to run, then takes the guard, settles that launch and only then
/// lets the OS lock go, so no other CS2 session can replace console.log before it is read. `damage` is
/// set when the launch could not record its process ids: it then settles as damaged, whatever the log
/// says. It only waits and reads the process list; it never stops a process.
#[allow(clippy::too_many_arguments)]
pub fn watch(mut child: std::process::Child, hlae: ProcId, root: PathBuf, job_dir: PathBuf, nonce: String, log: PathBuf, procs: Box<dyn Procs + Send>, damage: Option<String>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let _ = child.wait();
        while procs.cs2_running().unwrap_or(true) {
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        let mut g = match guard(&root) {
            Ok(g) => g,
            // cannot happen while this launch keeps the OS lock for `root`; release its hold anyway
            Err(_) => {
                let mut st = STATE.lock().unwrap_or_else(|p| p.into_inner());
                st.running = st.running.saturating_sub(1);
                if st.running == 0 {
                    st.os_lock = None;
                }
                return;
            }
        };
        if let Some(mut l) = launches(&job_dir).into_iter().find(|l| l.record.nonce == nonce) {
            match &damage {
                Some(d) if l.outcome == Outcome::Pending => {
                    if let Ok(dir) = folder_in(&job_dir, &["launches"]) {
                        let _ = record_damaged(&g, &dir, &nonce, d);
                    }
                }
                Some(_) => {}
                None => {
                    let _ = settle(&g, &job_dir, &mut l, &log, &*procs, Some(hlae));
                }
            }
        }
        g.launch_done();
    })
}

/// How many launches' watchers still keep the OS lock, for tests.
#[cfg(test)]
pub(crate) fn running_launches() -> usize {
    STATE.lock().unwrap_or_else(|p| p.into_inner()).running
}

/// Removes FFmpeg's part files (`.*.part.mp4`) that a crashed finish or reel left in the clips folder
/// and in `reels\`; returns how many. Called only under a [`guard`], so no finish is writing one then.
pub fn sweep_parts(_g: &Guard, root: &Path) -> usize {
    let mut n = 0;
    for dir in [root.to_path_buf(), root.join("reels")] {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') && name.ends_with(".part.mp4") && e.file_type().is_ok_and(|t| t.is_file()) && fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

// ---------------------------------------------------------------- launch records

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRecord {
    pub nonce: String,
    pub job: String,
    /// one above the job's highest when it started; launches are ordered by this, never by clock
    pub seq: u64,
    /// ms since the epoch, for people; nothing orders by it
    pub started: u64,
    /// per clip of the job, the take folders it had before this launch
    pub takes_before: BTreeMap<String, Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LaunchPids {
    pub hlae: ProcId,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LaunchResult {
    pub nonce: String,
    /// where the director's lines were read from, or why there were none
    pub evidence: String,
    /// clips the director recorded to their end tick (`END <clip> nonce=<n> why=end_tick`)
    pub ended: Vec<String>,
    /// clips it stopped early, with why
    pub stopped: Vec<(String, String)>,
    /// set when the launch's evidence cannot be trusted (its process ids were never recorded): no take counts
    #[serde(default)]
    pub damaged: Option<String>,
}

/// A launch's result as found: settled, damaged (a result file that does not read), or not yet.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    Pending,
    Settled(LaunchResult),
    Damaged(String),
}

/// One launch of a job, with what is known so far.
pub struct Launch {
    pub record: LaunchRecord,
    pub pids: Option<LaunchPids>,
    pub outcome: Outcome,
}

/// Publishes `v` as `dir\name`: written to a new temporary file first, then renamed to `name` by a
/// rename that fails when `name` exists, so a reader sees a whole file or none, and nothing is replaced.
fn publish<T: Serialize>(dir: &Path, name: &str, v: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    let nonce = new_nonce()?;
    let tmp = dir.join(format!(".{name}.{}.tmp", &nonce[..16]));
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let written = f.write_all(text.as_bytes()).and_then(|_| f.sync_all());
    drop(f);
    let done = written.and_then(|_| crate::botmode::paths::rename_no_replace(&tmp, &dir.join(name)));
    if let Err(e) = done {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {e}", dir.join(name).display()));
    }
    Ok(())
}

/// A JSON file in `dir`: None when absent, Err when present but unreadable.
fn read_json<T: for<'de> Deserialize<'de>>(dir: &Path, name: &str) -> Option<Result<T, String>> {
    if fs::symlink_metadata(dir.join(name)).is_err() {
        return None;
    }
    Some(
        file_inside(dir, &dir.join(name))
            .and_then(|p| fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display())))
            .and_then(|t| serde_json::from_str(&t).map_err(|e| format!("{name}: {e}"))),
    )
}

/// Every launch of the job in `job_dir`, in sequence order. A record that does not read is left out.
pub fn launches(job_dir: &Path) -> Vec<Launch> {
    let dir = job_dir.join("launches");
    let Ok(rd) = fs::read_dir(&dir) else { return vec![] };
    let mut out: Vec<Launch> = rd
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".json").filter(|s| nonce_ok(s)).map(String::from))
        .filter_map(|nonce| {
            let record: LaunchRecord = read_json(&dir, &format!("{nonce}.json"))?.ok()?;
            if record.nonce != nonce {
                return None;
            }
            let outcome = match read_json::<LaunchResult>(&dir, &format!("{nonce}.result.json")) {
                None => Outcome::Pending,
                Some(Ok(r)) if r.nonce == nonce => match &r.damaged {
                    Some(d) => Outcome::Damaged(d.clone()),
                    None => Outcome::Settled(r),
                },
                Some(Ok(_)) => Outcome::Damaged("its result names another launch".into()),
                Some(Err(e)) => Outcome::Damaged(e),
            };
            Some(Launch { pids: read_json(&dir, &format!("{nonce}.pids.json")).and_then(Result::ok), outcome, record })
        })
        .collect();
    out.sort_by(|a, b| (a.record.seq, &a.record.nonce).cmp(&(b.record.seq, &b.record.nonce)));
    out
}

/// The next sequence number for a job: one above its highest.
pub fn next_seq(job_dir: &Path) -> u64 {
    launches(job_dir).iter().map(|l| l.record.seq).max().map_or(1, |m| m + 1)
}

/// Publishes a launch's record into `jobs\<job>\launches\<nonce>.json`; returns the launches folder.
pub fn write_record(_g: &Guard, job_dir: &Path, rec: &LaunchRecord) -> Result<PathBuf, String> {
    let dir = folder_in(job_dir, &["launches"])?;
    publish(&dir, &format!("{}.json", rec.nonce), rec)?;
    Ok(dir)
}

pub fn write_pids(_g: &Guard, launches_dir: &Path, nonce: &str, pids: &LaunchPids) -> Result<(), String> {
    publish(launches_dir, &format!("{nonce}.pids.json"), pids)
}

/// Publishes a launch's result into `launches\<nonce>.result.json`, once.
pub fn write_result(_g: &Guard, launches_dir: &Path, r: &LaunchResult) -> Result<(), String> {
    publish(launches_dir, &format!("{}.result.json", r.nonce), r)
}

/// The director's END lines for `nonce` in console.log. The whole log is streamed from its start, one
/// line at a time in constant memory (a line is cut at MAX_LINE bytes), with no limit on its length:
/// only lines that start with `[cs2stats] END ` and carry this nonce count, so nothing a demo recorded,
/// and nothing from another launch, can be taken for them, wherever in the log they are.
pub fn read_console(log: &Path, nonce: &str) -> LaunchResult {
    let empty = |evidence: &str| LaunchResult { nonce: nonce.into(), evidence: evidence.into(), ended: vec![], stopped: vec![], damaged: None };
    let Ok(f) = fs::File::open(log) else { return empty("missing: CS2 wrote no console.log") };
    let mut r = std::io::BufReader::new(f);
    let tag = format!("nonce={nonce}");
    let (mut ended, mut stopped) = (Vec::new(), Vec::new());
    let mut line: Vec<u8> = Vec::with_capacity(MAX_LINE);
    loop {
        // one line, keeping at most MAX_LINE bytes of it
        line.clear();
        let mut eof = false;
        loop {
            let buf = match r.fill_buf() {
                Ok(b) => b,
                Err(_) => return empty("missing: console.log could not be read"),
            };
            if buf.is_empty() {
                eof = true;
                break;
            }
            let (chunk, newline) = match buf.iter().position(|&c| c == b'\n') {
                Some(i) => (&buf[..i], Some(i + 1)),
                None => (buf, None),
            };
            let room = MAX_LINE.saturating_sub(line.len());
            line.extend_from_slice(&chunk[..chunk.len().min(room)]);
            let used = newline.unwrap_or(buf.len());
            r.consume(used);
            if newline.is_some() {
                break;
            }
        }
        let text = String::from_utf8_lossy(&line);
        if let Some(rest) = text.trim_end_matches('\r').strip_prefix("[cs2stats] END ") {
            // END <clip> nonce=<n> why=<why> tick=<t>
            let t: Vec<&str> = rest.split(' ').collect();
            if t.len() >= 3 && t[1] == tag && super::clip_id_ok(t[0]) {
                match t[2].strip_prefix("why=") {
                    Some("end_tick") => ended.push(t[0].to_string()),
                    Some(why) => stopped.push((t[0].to_string(), why.to_string())),
                    None => {}
                }
            }
        }
        if eof {
            break;
        }
    }
    LaunchResult { nonce: nonce.into(), evidence: "console.log, read whole".into(), ended, stopped, damaged: None }
}

/// Whether a launch's processes may still run: its HLAE (from `known`, else its pids file) or any
/// cs2.exe is alive. A launch without recorded processes is not known to run.
pub fn running(l: &Launch, known: Option<ProcId>, procs: &dyn Procs) -> Result<bool, String> {
    Ok(match known.or(l.pids.as_ref().map(|p| p.hlae)) {
        Some(h) => procs.alive(&h) || procs.cs2_running()?,
        None => false,
    })
}

/// Publishes the result of a launch whose HLAE could not be started: `why` is the start's error.
pub fn record_not_started(g: &Guard, launches_dir: &Path, nonce: &str, why: &str) -> Result<(), String> {
    write_result(g, launches_dir, &LaunchResult { nonce: nonce.into(), evidence: format!("missing: HLAE was not started ({why})"), ended: vec![], stopped: vec![], damaged: None })
}

/// Publishes a launch as damaged: its evidence cannot be trusted, so none of its takes counts.
pub fn record_damaged(g: &Guard, launches_dir: &Path, nonce: &str, why: &str) -> Result<(), String> {
    write_result(g, launches_dir, &LaunchResult { nonce: nonce.into(), evidence: "damaged".into(), ended: vec![], stopped: vec![], damaged: Some(why.into()) })
}

/// Settles one launch once its processes have exited: reads its director lines and publishes them as its
/// result. `known` is HLAE's process when the caller holds it (the watcher). A launch with no recorded
/// HLAE settles as damaged, never as "not started": the app may have stopped between starting HLAE and
/// recording it (a failed start is recorded at once, record_not_started). A result some earlier run
/// already published is kept as it is.
pub fn settle(g: &Guard, job_dir: &Path, l: &mut Launch, log: &Path, procs: &dyn Procs, known: Option<ProcId>) -> Result<(), String> {
    if l.outcome != Outcome::Pending || running(l, known, procs)? {
        return Ok(());
    }
    let result = match known.or(l.pids.as_ref().map(|p| p.hlae)) {
        None => LaunchResult {
            nonce: l.record.nonce.clone(), evidence: "damaged".into(), ended: vec![], stopped: vec![],
            damaged: Some("its HLAE process was never recorded; the app may have stopped while starting it".into()),
        },
        Some(_) => read_console(log, &l.record.nonce),
    };
    let dir = folder_in(job_dir, &["launches"])?;
    match write_result(g, &dir, &result) {
        Ok(()) => {
            l.outcome = match &result.damaged {
                Some(d) => Outcome::Damaged(d.clone()),
                None => Outcome::Settled(result),
            }
        }
        // published by an earlier run after this one listed the launches: read that one instead
        Err(_) => {
            l.outcome = match read_json::<LaunchResult>(&dir, &format!("{}.result.json", l.record.nonce)) {
                Some(Ok(r)) => match &r.damaged {
                    Some(d) => Outcome::Damaged(d.clone()),
                    None => Outcome::Settled(r),
                },
                Some(Err(e)) => Outcome::Damaged(e),
                None => return Err(format!("{}: its result could not be written", l.record.nonce)),
            };
        }
    }
    Ok(())
}

/// The launch that made take `take` of `clip`: the launch of this clip with the highest sequence
/// number whose record does not list the take. Launches are one at a time (the guard, and no launch
/// while an earlier one runs), so that is the one.
pub fn owner<'a>(launches: &'a [Launch], clip: &str, take: &str) -> Option<&'a Launch> {
    launches.iter().filter(|l| l.record.takes_before.get(clip).is_some_and(|b| !b.iter().any(|t| t == take))).max_by_key(|l| l.record.seq)
}

/// Whether take `take` of `clip` is complete: its launch has settled and its director recorded the clip
/// to the end tick. Otherwise why not.
pub fn take_proven(launches: &[Launch], clip: &str, take: &str) -> Result<(), String> {
    let l = owner(launches, clip, take).ok_or("no launch of this job made this take")?;
    let r = match &l.outcome {
        Outcome::Settled(r) => r,
        Outcome::Pending => return Err("its launch has not ended (CS2 or HLAE still running)".into()),
        Outcome::Damaged(e) => return Err(format!("launch {} is damaged ({e}); render the moment again", l.record.seq)),
    };
    if r.ended.iter().any(|c| c == clip) {
        return Ok(());
    }
    match r.stopped.iter().find(|(c, _)| c == clip) {
        Some((_, why)) => Err(format!("the director stopped this clip early ({why})")),
        None => Err(format!("its launch left no record that this clip was recorded ({})", r.evidence)),
    }
}

/// The clip ids of a job and their take folders now, for a launch record.
pub fn takes_now(job_dir: &Path, clips: &[String]) -> BTreeMap<String, Vec<String>> {
    clips
        .iter()
        .map(|c| {
            let mut t: Vec<String> = fs::read_dir(job_dir.join("raw").join(c))
                .map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| super::take_name_ok(n)).collect())
                .unwrap_or_default();
            t.sort();
            (c.clone(), t)
        })
        .collect()
}

/// A stand-in for the system's processes, for tests.
#[cfg(test)]
pub(crate) mod fake {
    use super::{ProcId, Procs};
    use std::cell::RefCell;

    pub(crate) struct Fake {
        pub alive: RefCell<Vec<ProcId>>,
        pub cs2: RefCell<bool>,
    }
    impl Fake {
        pub fn new() -> Fake {
            Fake { alive: RefCell::new(vec![]), cs2: RefCell::new(false) }
        }
    }
    impl Procs for Fake {
        fn alive(&self, p: &ProcId) -> bool {
            self.alive.borrow().contains(p)
        }
        fn cs2_running(&self) -> Result<bool, String> {
            Ok(*self.cs2.borrow())
        }
    }

    /// A process standing in for HLAE: this test binary, running only short_child_exits_soon.
    pub(crate) fn short_child() -> std::process::Child {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "clips::launch::tests::short_child_exits_soon", "--test-threads=1"])
            .env("CS2STATS_TEST_SHORT_CHILD", "1")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }
}

/// The tests that take [`guard`] share one process-wide state; they run one at a time through this.
#[cfg(test)]
pub(crate) static SERIAL: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::fake::Fake;
    use super::*;
    use std::sync::mpsc;

    const JOB: &str = "job-20261026T180405123Z-a1b2c3";
    const CLIP: &str = "c-0123456789abcdef-r3";

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cs2stats-launch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        super::super::plain(&d.canonicalize().unwrap())
    }
    fn serial() -> MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn n(i: u8) -> String {
        format!("{i:02x}").repeat(16)
    }
    /// A launch of JOB with sequence number `seq`, started at `started` ms, before which CLIP had `before`.
    fn record(g: &Guard, job: &Path, i: u8, seq: u64, started: u64, before: &[&str]) {
        let rec = LaunchRecord { nonce: n(i), job: JOB.into(), seq, started, takes_before: BTreeMap::from([(CLIP.to_string(), before.iter().map(|s| s.to_string()).collect())]) };
        let dir = write_record(g, job, &rec).unwrap();
        write_pids(g, &dir, &n(i), &LaunchPids { hlae: ProcId { pid: 30, created: u64::from(i) } }).unwrap();
    }

    #[test]
    fn nonces_are_fresh_128_bit_hex() {
        let (a, b) = (new_nonce().unwrap(), new_nonce().unwrap());
        assert!(nonce_ok(&a) && nonce_ok(&b) && a != b);
    }

    #[test]
    fn clips_operations_never_interleave_and_the_sweep_waits_for_a_finish() {
        let _s = serial();
        let root = scratch("mutex");
        let part = root.join(".c-0123456789abcdef-r3.0011223344556677.part.mp4");
        let (inside_tx, inside_rx) = mpsc::channel();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let order = std::sync::Arc::new(Mutex::new(Vec::<&str>::new()));
        // a finish: holds the guard while FFmpeg writes its part file, then renames it into place
        let (r1, o1) = (root.clone(), order.clone());
        let finish = std::thread::spawn(move || {
            let _g = guard(&r1).unwrap();
            o1.lock().unwrap().push("finish starts");
            fs::write(r1.join(".c-0123456789abcdef-r3.0011223344556677.part.mp4"), b"clip").unwrap();
            inside_tx.send(()).unwrap();
            go_rx.recv().unwrap();
            fs::rename(r1.join(".c-0123456789abcdef-r3.0011223344556677.part.mp4"), r1.join("c-0123456789abcdef-r3.mp4")).unwrap();
            o1.lock().unwrap().push("finish ends");
        });
        inside_rx.recv().unwrap();
        // a scan's sweep, started while the finish writes: it must wait, and find nothing to remove after
        let (r2, o2) = (root.clone(), order.clone());
        let sweep = std::thread::spawn(move || {
            let g = guard(&r2).unwrap();
            o2.lock().unwrap().push("sweep starts");
            sweep_parts(&g, &r2)
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(part.exists(), "the sweep removed the finish's part file");
        assert_eq!(*order.lock().unwrap(), ["finish starts"]);
        go_tx.send(()).unwrap();
        finish.join().unwrap();
        assert_eq!(sweep.join().unwrap(), 0);
        assert_eq!(*order.lock().unwrap(), ["finish starts", "finish ends", "sweep starts"]);
        assert_eq!(fs::read(root.join("c-0123456789abcdef-r3.mp4")).unwrap(), b"clip");
        // a part file left by a crashed finish is swept
        fs::write(&part, b"half").unwrap();
        assert_eq!(sweep_parts(&guard(&root).unwrap(), &root), 1);
        let _ = fs::remove_dir_all(&root);
    }

    /// Run only as a child of the watcher tests: a stand-in for HLAE that exits by itself.
    #[test]
    fn short_child_exits_soon() {
        if std::env::var("CS2STATS_TEST_SHORT_CHILD").is_err() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }

    #[test]
    fn the_watcher_settles_its_launch_before_letting_the_lock_go() {
        let _s = serial();
        let root = scratch("watch");
        let job = root.join("jobs").join(JOB);
        fs::create_dir_all(&job).unwrap();
        let log = root.join("console.log");
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=900\n", n(7))).unwrap();
        let mut g = guard(&root).unwrap();
        record(&g, &job, 7, 1, 1, &[]);
        let child = fake::short_child();
        let hlae = ProcId { pid: child.id(), created: 1 };
        g.launch_running();
        drop(g);
        let w = watch(child, hlae, root.clone(), job.clone(), n(7), log.clone(), Box::new(Fake::new()), None);
        assert_eq!(running_launches(), 1, "the launch let go of the lock while HLAE ran");
        #[cfg(windows)]
        assert!(imp::exclusive(&root.join(LOCK)).is_err(), "another app could take the lock while HLAE ran");
        w.join().unwrap();
        // by the time the lock went, the launch had settled from the log
        assert_eq!(running_launches(), 0);
        assert!(matches!(&launches(&job)[0].outcome, Outcome::Settled(r) if r.ended == [CLIP]));
        drop(imp::exclusive(&root.join(LOCK)).expect("the lock went with the watcher"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_damaged_launch_stays_damaged_whatever_its_log_says() {
        let _s = serial();
        let root = scratch("watchdmg");
        let job = root.join("jobs").join(JOB);
        fs::create_dir_all(&job).unwrap();
        let log = root.join("console.log");
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=900\n", n(8))).unwrap();
        let mut g = guard(&root).unwrap();
        // the record, without its process ids (their write failed), and the damaged result not yet written
        let rec = LaunchRecord { nonce: n(8), job: JOB.into(), seq: 1, started: 1, takes_before: BTreeMap::from([(CLIP.to_string(), vec![])]) };
        write_record(&g, &job, &rec).unwrap();
        let child = fake::short_child();
        let hlae = ProcId { pid: child.id(), created: 1 };
        g.launch_running();
        drop(g);
        watch(child, hlae, root.clone(), job.clone(), n(8), log, Box::new(Fake::new()), Some("its process ids could not be recorded".into())).join().unwrap();
        let ls = launches(&job);
        assert!(matches!(&ls[0].outcome, Outcome::Damaged(d) if d.contains("could not be recorded")));
        assert!(take_proven(&ls, CLIP, "take0000").unwrap_err().contains("is damaged"));
        assert_eq!(running_launches(), 0);
        let _ = fs::remove_dir_all(&root);
    }


    /// Run only as the child of the next test: holds the lock until killed.
    #[test]
    fn lock_child_holds_the_lock() {
        let Ok(root) = std::env::var("CS2STATS_TEST_CLIPS_LOCK") else { return };
        let _f = imp::exclusive(&Path::new(&root).join(LOCK)).unwrap();
        println!("HELD");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(120));
    }

    #[cfg(windows)]
    #[test]
    fn another_process_holding_the_lock_blocks_and_its_death_frees_it() {
        let _s = serial();
        let root = scratch("oslock");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "clips::launch::tests::lock_child_holds_the_lock", "--nocapture", "--test-threads=1"])
            .env("CS2STATS_TEST_CLIPS_LOCK", &root)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let out = std::io::BufReader::new(child.stdout.take().unwrap());
        let held = out.lines().map_while(Result::ok).any(|l| l.contains("HELD"));
        assert!(held, "the child did not take the lock");
        let e = guard(&root).err().expect("the lock is held elsewhere");
        assert!(e.contains("another instance of the app"), "{e}");
        // the child is the process this test started: ending it by its own handle closes its lock with it
        child.kill().unwrap();
        child.wait().unwrap();
        drop(guard(&root).unwrap());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn launches_order_by_sequence_number_even_when_the_clock_went_back() {
        let _s = serial();
        let root = scratch("clock");
        let job = root.join("jobs").join(JOB);
        fs::create_dir_all(&job).unwrap();
        let g = guard(&root).unwrap();
        // launch 1 succeeded at 5000 ms; the clock then went back, and launch 2 (at 1000 ms) failed
        record(&g, &job, 1, 1, 5000, &[]);
        record(&g, &job, 2, 2, 1000, &["take0000"]);
        assert_eq!(next_seq(&job), 3);
        let dir = job.join("launches");
        write_result(&g, &dir, &LaunchResult { nonce: n(1), evidence: "t".into(), ended: vec![CLIP.into()], stopped: vec![], damaged: None }).unwrap();
        write_result(&g, &dir, &LaunchResult { nonce: n(2), evidence: "t".into(), ended: vec![], stopped: vec![(CLIP.into(), "camera_lost".into())], damaged: None }).unwrap();
        let ls = launches(&job);
        assert_eq!(ls.iter().map(|l| l.record.seq).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(owner(&ls, CLIP, "take0001").unwrap().record.seq, 2);
        assert_eq!(take_proven(&ls, CLIP, "take0001").unwrap_err(), "the director stopped this clip early (camera_lost)");
        assert_eq!(take_proven(&ls, CLIP, "take0000"), Ok(()));
        drop(g);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_settles_only_after_its_processes_exit_and_keeps_its_first_result() {
        let _s = serial();
        let root = scratch("settle");
        let job = root.join("jobs").join(JOB);
        fs::create_dir_all(&job).unwrap();
        let log = root.join("console.log");
        let procs = Fake::new();
        let g = guard(&root).unwrap();
        record(&g, &job, 3, 1, 1, &[]);
        let hlae = ProcId { pid: 30, created: 3 };
        procs.alive.borrow_mut().push(hlae);
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n", n(3))).unwrap();
        let mut ls = launches(&job);
        settle(&g, &job, &mut ls[0], &log, &procs, None).unwrap();
        assert_eq!(ls[0].outcome, Outcome::Pending, "HLAE still running");
        procs.alive.borrow_mut().clear();
        *procs.cs2.borrow_mut() = true;
        settle(&g, &job, &mut ls[0], &log, &procs, None).unwrap();
        assert_eq!(ls[0].outcome, Outcome::Pending, "CS2 still running");
        *procs.cs2.borrow_mut() = false;
        settle(&g, &job, &mut ls[0], &log, &procs, None).unwrap();
        assert!(matches!(&ls[0].outcome, Outcome::Settled(r) if r.ended == [CLIP]));
        // settled once: a later log changes nothing
        fs::write(&log, "").unwrap();
        let mut ls = launches(&job);
        settle(&g, &job, &mut ls[0], &log, &procs, None).unwrap();
        assert!(matches!(&ls[0].outcome, Outcome::Settled(r) if r.ended == [CLIP]));
        // a launch whose HLAE was never recorded settles as damaged, never as "not started"
        let rec = LaunchRecord { nonce: n(4), job: JOB.into(), seq: 2, started: 2, takes_before: BTreeMap::new() };
        write_record(&g, &job, &rec).unwrap();
        let mut ls = launches(&job);
        settle(&g, &job, &mut ls[1], &log, &procs, None).unwrap();
        assert!(matches!(&ls[1].outcome, Outcome::Damaged(d) if d.contains("never recorded")));
        drop(g);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_partial_result_marks_its_launch_damaged_and_fails_nothing_else() {
        let _s = serial();
        let root = scratch("partial");
        let job = root.join("jobs").join(JOB);
        fs::create_dir_all(&job).unwrap();
        let g = guard(&root).unwrap();
        record(&g, &job, 5, 1, 1, &[]);
        record(&g, &job, 6, 2, 2, &["take0000"]);
        let dir = job.join("launches");
        // launch 1's result was cut off mid-write by something other than this app; launch 2's is whole
        fs::write(dir.join(format!("{}.result.json", n(5))), b"{\"nonce\": \"").unwrap();
        write_result(&g, &dir, &LaunchResult { nonce: n(6), evidence: "t".into(), ended: vec![CLIP.into()], stopped: vec![], damaged: None }).unwrap();
        let mut ls = launches(&job);
        assert!(matches!(&ls[0].outcome, Outcome::Damaged(_)));
        let e = take_proven(&ls, CLIP, "take0000").unwrap_err();
        assert!(e.starts_with("launch 1 is damaged"), "{e}");
        assert_eq!(take_proven(&ls, CLIP, "take0001"), Ok(()));
        // settling leaves a damaged result as it is; publishing over it is refused, never a replace
        settle(&g, &job, &mut ls[0], &root.join("console.log"), &Fake::new(), None).unwrap();
        assert!(matches!(&ls[0].outcome, Outcome::Damaged(_)));
        assert!(write_result(&g, &dir, &LaunchResult { nonce: n(5), evidence: "x".into(), ended: vec![], stopped: vec![], damaged: None }).is_err());
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        drop(g);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_forged_or_old_line_does_not_count() {
        let root = scratch("forged");
        let log = root.join("console.log");
        // chat and player names: the marker not at the line's start; an old launch's nonce; a guessed one
        fs::write(&log, format!(
            "Player [cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n  [cs2stats] END {CLIP} nonce={} why=end_tick\n[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n[cs2stats] END {CLIP} why=end_tick nonce={}\n",
            n(5), n(5), n(4), "0".repeat(32), n(5),
        )).unwrap();
        let r = read_console(&log, &n(5));
        assert_eq!((r.ended, r.stopped), (vec![], vec![]));
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\r\n", n(5))).unwrap();
        assert_eq!(read_console(&log, &n(5)).ended, [CLIP]);
        fs::remove_file(&log).unwrap();
        assert!(read_console(&log, &n(5)).evidence.starts_with("missing"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_whole_log_is_read_however_it_was_truncated_regrown_or_how_long_it_is() {
        let root = scratch("whole");
        let log = root.join("console.log");
        // truncated in place and regrown, with this launch's END early: read from the start, it is found
        fs::write(&log, "x".repeat(10_000)).unwrap();
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n{}\n", n(7), "y".repeat(20_000))).unwrap();
        assert_eq!(read_console(&log, &n(7)).ended, [CLIP]);
        // an END line past 64 MiB of other lines, and past a single line longer than MAX_LINE
        let mut f = fs::File::create(&log).unwrap();
        let filler = format!("{}\n", "z".repeat(1023));
        for _ in 0..(65 * 1024) {
            f.write_all(filler.as_bytes()).unwrap();
        }
        f.write_all(&vec![b'w'; 3 * MAX_LINE]).unwrap();
        f.write_all(format!("\n[cs2stats] END {CLIP} nonce={} why=end_tick tick=1", n(7)).as_bytes()).unwrap();
        drop(f);
        assert!(fs::metadata(&log).unwrap().len() > 64 << 20);
        assert_eq!(read_console(&log, &n(7)).ended, [CLIP]);
        let _ = fs::remove_dir_all(&root);
    }
}
