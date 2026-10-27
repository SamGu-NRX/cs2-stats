//! Launches, the lock that serialises them, and what proves a take complete (design/clips.md "When a
//! take counts").
//!
//! Each launch gets a fresh 128-bit nonce from the OS's random source. The director script written for
//! that launch logs it in every line, so a line carrying it can only come from that launch: a demo's chat
//! and player names were recorded before the nonce existed. Each launch leaves three files in
//! `jobs\<job>\launches\`, each created exclusively and never rewritten:
//! - `<nonce>.json`, written before HLAE starts: the takes each clip already had, and CS2's console.log
//!   identity and length then;
//! - `<nonce>.pids.json`, once HLAE has started: its process id and creation time;
//! - `<nonce>.result.json`, once that launch's processes have exited: the clips the director recorded to
//!   their end tick, read once from console.log and kept, because the next CS2 session replaces the log.
//!
//! A take belongs to the newest launch that started before it existed, and counts only when that
//! launch's result says the director ended its clip at the end tick.
//!
//! The processes: HLAE's custom loader starts cs2.exe, but nothing here can confirm that HLAE is the
//! parent the system records for it, so a launch's processes have exited when HLAE's own process (its id
//! and creation time) has exited and no cs2.exe is running.

use super::{file_inside, folder_in};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// The most of console.log read for one launch. A render's director lines are a few kilobytes; the rest
/// of the log is the game's own. Ours, not measured: large enough for an hour of console output.
const MAX_LOG_READ: u64 = 64 << 20;
/// The lock file in the clips folder that a launch holds until its processes exit, and a finish while it runs.
const LOCK: &str = "clips.lock";

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
    /// This app's own process.
    fn me(&self) -> ProcId;
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
    fn me(&self) -> ProcId {
        imp::proc_id(std::process::id()).unwrap_or(ProcId { pid: std::process::id(), created: 0 })
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

// ---------------------------------------------------------------- the lock

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LockFile {
    /// "launch" or "finish"
    kind: String,
    /// the app process that took it
    owner: ProcId,
    /// a launch's HLAE, once started
    hlae: Option<ProcId>,
    nonce: Option<String>,
}

/// Whether a lock still guards something: a finish while its app runs; a launch while its app is still
/// starting HLAE, or while HLAE or any cs2.exe runs after that. Otherwise it is stale.
fn lock_live(l: &LockFile, procs: &dyn Procs) -> bool {
    match (l.kind.as_str(), &l.hlae) {
        ("launch", Some(h)) => procs.alive(h) || procs.cs2_running().unwrap_or(true),
        _ => procs.alive(&l.owner),
    }
}

/// The lock file, created with `create_new`: one launch or finish at a time.
#[derive(Debug)]
pub struct Lock {
    path: PathBuf,
    file: LockFile,
    release: bool,
}

impl Lock {
    /// Takes the lock for `kind`, clearing a stale one first; refuses, naming what holds it, while it is live.
    pub fn acquire(root: &Path, kind: &str, nonce: Option<&str>, procs: &dyn Procs) -> Result<Lock, String> {
        let path = root.join(LOCK);
        let file = LockFile { kind: kind.into(), owner: procs.me(), hlae: None, nonce: nonce.map(String::from) };
        for _ in 0..2 {
            match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    use std::io::Write;
                    let text = serde_json::to_string(&file).map_err(|e| e.to_string())?;
                    f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| {
                        let _ = fs::remove_file(&path);
                        format!("{}: {e}", path.display())
                    })?;
                    return Ok(Lock { path, file, release: true });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if let Some(held) = read_lock(&path).filter(|l| lock_live(l, procs)) {
                        return Err(format!("another {} is running; wait for it to end (CS2 and HLAE closed), then try again", held.kind));
                    }
                    // stale, or unreadable: its process is gone
                    let _ = fs::remove_file(&path);
                }
                Err(e) => return Err(format!("{}: {e}", path.display())),
            }
        }
        Err(format!("{} could not be taken", path.display()))
    }

    /// Records the HLAE process this launch started; the lock then stays until it and CS2 have exited.
    pub fn started(&mut self, hlae: ProcId) -> Result<(), String> {
        self.file.hlae = Some(hlae);
        let text = serde_json::to_string(&self.file).map_err(|e| e.to_string())?;
        fs::write(&self.path, text).map_err(|e| format!("{}: {e}", self.path.display()))?;
        self.release = false;
        Ok(())
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if self.release {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn read_lock(path: &Path) -> Option<LockFile> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// The nonce of the launch holding the lock while it is live, and whether any lock is live; a stale lock is removed.
pub fn lock_state(root: &Path, procs: &dyn Procs) -> (bool, Option<String>) {
    let path = root.join(LOCK);
    match read_lock(&path) {
        Some(l) if lock_live(&l, procs) => (true, l.nonce),
        Some(_) => {
            let _ = fs::remove_file(&path);
            (false, None)
        }
        None if path.exists() => {
            let _ = fs::remove_file(&path);
            (false, None)
        }
        None => (false, None),
    }
}

/// Removes FFmpeg's part files (`.*.part.mp4`) a crashed finish or reel left in the clips folder and in
/// `reels\`, while no lock is live; returns how many. Runs at app start and with every scan.
pub fn sweep_parts(root: &Path, procs: &dyn Procs) -> usize {
    if lock_state(root, procs).0 {
        return 0;
    }
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

/// CS2's console.log as it was when a launch started: its file identity (volume serial and file index)
/// and length; None when there was no log.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ConsoleMark {
    pub identity: Option<(u32, u64)>,
    pub len: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRecord {
    pub nonce: String,
    pub job: String,
    /// ms since the epoch
    pub started: u64,
    /// per clip of the job, the take folders it had before this launch
    pub takes_before: BTreeMap<String, Vec<String>>,
    pub console: ConsoleMark,
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
}

/// One launch of a job, with what is known so far.
pub struct Launch {
    pub record: LaunchRecord,
    pub pids: Option<LaunchPids>,
    pub result: Option<LaunchResult>,
}

/// `create_new` a JSON file: a launch's files are written once and never replaced.
fn write_new<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
    use std::io::Write;
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_json<T: for<'de> Deserialize<'de>>(dir: &Path, name: &str) -> Option<T> {
    let p = file_inside(dir, &dir.join(name)).ok()?;
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// The console log's identity and length now.
pub fn console_mark(log: &Path) -> ConsoleMark {
    match fs::metadata(log) {
        Ok(m) => ConsoleMark { identity: crate::botmode::process::file_id(log).ok(), len: m.len() },
        Err(_) => ConsoleMark { identity: None, len: 0 },
    }
}

/// Writes a launch's record into `jobs\<job>\launches\<nonce>.json`.
pub fn write_record(job_dir: &Path, rec: &LaunchRecord) -> Result<PathBuf, String> {
    let dir = folder_in(job_dir, &["launches"])?;
    write_new(&dir.join(format!("{}.json", rec.nonce)), rec)?;
    Ok(dir)
}

/// Writes a launch's result into `launches\<nonce>.result.json`, once.
pub fn write_result(launches_dir: &Path, r: &LaunchResult) -> Result<(), String> {
    write_new(&launches_dir.join(format!("{}.result.json", r.nonce)), r)
}

pub fn write_pids(launches_dir: &Path, nonce: &str, pids: &LaunchPids) -> Result<(), String> {
    write_new(&launches_dir.join(format!("{nonce}.pids.json")), pids)
}

/// Every launch of the job in `job_dir`, oldest first.
pub fn launches(job_dir: &Path) -> Vec<Launch> {
    let dir = job_dir.join("launches");
    let Ok(rd) = fs::read_dir(&dir) else { return vec![] };
    let mut out: Vec<Launch> = rd
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|n| n.strip_suffix(".json").filter(|s| nonce_ok(s)).map(String::from))
        .filter_map(|nonce| {
            let record: LaunchRecord = read_json(&dir, &format!("{nonce}.json"))?;
            (record.nonce == nonce).then(|| Launch {
                pids: read_json(&dir, &format!("{nonce}.pids.json")),
                result: read_json(&dir, &format!("{nonce}.result.json")).filter(|r: &LaunchResult| r.nonce == nonce),
                record,
            })
        })
        .collect();
    out.sort_by(|a, b| (a.record.started, &a.record.nonce).cmp(&(b.record.started, &b.record.nonce)));
    out
}

/// The director's lines for `nonce` in console.log, read once a launch has ended: from the length it
/// had at launch when it is the same file and has only grown, else from its start, because CS2 replaces
/// the log each session (povforge hlae.py keeps a copy per session for that reason). Either way at most
/// MAX_LOG_READ bytes, and only lines that start with `[cs2stats] END ` and carry this nonce count, so
/// nothing a demo recorded, and nothing from another launch, can be taken for them.
pub fn read_console(log: &Path, mark: &ConsoleMark, nonce: &str) -> LaunchResult {
    let empty = |evidence: String| LaunchResult { nonce: nonce.into(), evidence, ended: vec![], stopped: vec![] };
    let Ok(mut f) = fs::File::open(log) else { return empty("missing: CS2 wrote no console.log".into()) };
    let now = console_mark(log);
    let appended = mark.identity.is_some() && now.identity == mark.identity && now.len >= mark.len;
    let start = if appended { mark.len } else { 0 };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return empty("missing: console.log could not be read".into());
    }
    let mut ended = Vec::new();
    let mut stopped = Vec::new();
    let tag = format!("nonce={nonce}");
    for line in std::io::BufReader::new(f.take(MAX_LOG_READ)).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(rest) = line.strip_prefix("[cs2stats] END ") else { continue };
        let t: Vec<&str> = rest.split(' ').collect();
        // END <clip> nonce=<n> why=<why> tick=<t>
        if t.len() < 3 || t[1] != tag || !super::clip_id_ok(t[0]) {
            continue;
        }
        match t[2].strip_prefix("why=") {
            Some("end_tick") => ended.push(t[0].to_string()),
            Some(why) => stopped.push((t[0].to_string(), why.to_string())),
            None => {}
        }
    }
    let evidence = if appended { format!("console.log from byte {start}") } else { "console.log from its start (CS2 replaced it)".into() };
    LaunchResult { nonce: nonce.into(), evidence, ended, stopped }
}

/// Settles one launch once its processes have exited: reads its director lines and keeps them in its
/// result file. A launch that never recorded HLAE's process (the start failed) settles with none. Does
/// nothing while the launch holds the live lock or its processes run.
pub fn settle(job_dir: &Path, l: &mut Launch, log: &Path, held: Option<&str>, procs: &dyn Procs) -> Result<(), String> {
    if l.result.is_some() || held == Some(l.record.nonce.as_str()) {
        return Ok(());
    }
    let result = match &l.pids {
        None => LaunchResult { nonce: l.record.nonce.clone(), evidence: "missing: HLAE was not started".into(), ended: vec![], stopped: vec![] },
        Some(p) if procs.alive(&p.hlae) || procs.cs2_running()? => return Ok(()),
        Some(_) => read_console(log, &l.record.console, &l.record.nonce),
    };
    write_result(&folder_in(job_dir, &["launches"])?, &result)?;
    l.result = Some(result);
    Ok(())
}

/// The launch that made take `take` of `clip`: the newest launch of this clip that started before the
/// take existed (its record does not list it). Launches are one at a time (the lock), so that is the one.
pub fn owner<'a>(launches: &'a [Launch], clip: &str, take: &str) -> Option<&'a Launch> {
    launches.iter().rev().find(|l| l.record.takes_before.get(clip).is_some_and(|before| !before.iter().any(|t| t == take)))
}

/// Whether take `take` of `clip` is complete: its launch has ended and its director recorded the clip to
/// the end tick. Otherwise why not.
pub fn take_proven(launches: &[Launch], clip: &str, take: &str) -> Result<(), String> {
    let l = owner(launches, clip, take).ok_or("no launch of this job made this take")?;
    let r = l.result.as_ref().ok_or("its launch has not ended (CS2 or HLAE still running)")?;
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
        pub me: ProcId,
    }
    impl Fake {
        pub fn new() -> Fake {
            let me = ProcId { pid: 10, created: 1 };
            Fake { alive: RefCell::new(vec![me]), cs2: RefCell::new(false), me }
        }
    }
    impl Procs for Fake {
        fn alive(&self, p: &ProcId) -> bool {
            self.alive.borrow().contains(p)
        }
        fn cs2_running(&self) -> Result<bool, String> {
            Ok(*self.cs2.borrow())
        }
        fn me(&self) -> ProcId {
            self.me
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOB: &str = "job-20261026T180405123Z-a1b2c3";
    const CLIP: &str = "c-0123456789abcdef-r3";

    use super::fake::Fake;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cs2stats-launch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        super::super::plain(&d.canonicalize().unwrap())
    }

    #[test]
    fn nonces_are_fresh_128_bit_hex() {
        let (a, b) = (new_nonce().unwrap(), new_nonce().unwrap());
        assert!(nonce_ok(&a) && nonce_ok(&b) && a != b);
    }

    #[test]
    fn one_launch_or_finish_at_a_time_and_a_stale_lock_clears() {
        let root = scratch("lock");
        let procs = Fake::new();
        let mut first = Lock::acquire(&root, "launch", Some("n1"), &procs).unwrap();
        // a second launch, and a finish, while the first is starting HLAE
        assert!(Lock::acquire(&root, "launch", Some("n2"), &procs).unwrap_err().contains("another launch is running"));
        assert!(Lock::acquire(&root, "finish", None, &procs).unwrap_err().contains("another launch"));
        // HLAE started: the lock outlives the call while HLAE or CS2 runs
        let hlae = ProcId { pid: 20, created: 2 };
        procs.alive.borrow_mut().push(hlae);
        first.started(hlae).unwrap();
        drop(first);
        assert!(root.join(LOCK).exists());
        assert_eq!(lock_state(&root, &procs), (true, Some("n1".into())));
        procs.alive.borrow_mut().retain(|p| *p != hlae);
        *procs.cs2.borrow_mut() = true;
        assert!(lock_state(&root, &procs).0, "CS2 still running holds it");
        *procs.cs2.borrow_mut() = false;
        // both gone: stale, cleared, and the next one gets it
        let next = Lock::acquire(&root, "finish", None, &procs).unwrap();
        drop(next);
        assert!(!root.join(LOCK).exists(), "a finish releases its lock");
        // a lock left by an app that died while starting HLAE is stale too
        let dead = Fake { me: ProcId { pid: 11, created: 9 }, ..Fake::new() };
        let l = Lock::acquire(&root, "launch", None, &dead).unwrap();
        std::mem::forget(l);
        procs.alive.borrow_mut().retain(|p| p.pid != 11);
        Lock::acquire(&root, "launch", None, &procs).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn part_files_are_swept_only_while_no_lock_is_live() {
        let root = scratch("parts");
        fs::create_dir_all(root.join("reels")).unwrap();
        for p in [root.join(".c-0123456789abcdef-r3.0011223344556677.part.mp4"), root.join("reels").join(".reel-1.0011223344556677.part.mp4")] {
            fs::write(p, b"half").unwrap();
        }
        fs::write(root.join("c-0123456789abcdef-r3.mp4"), b"keep").unwrap();
        let procs = Fake::new();
        let lock = Lock::acquire(&root, "finish", None, &procs).unwrap();
        assert_eq!(sweep_parts(&root, &procs), 0, "a finish may be writing one");
        drop(lock);
        assert_eq!(sweep_parts(&root, &procs), 2);
        assert!(root.join("c-0123456789abcdef-r3.mp4").exists());
        let _ = fs::remove_dir_all(&root);
    }

    fn record(job_dir: &Path, nonce: &str, started: u64, before: &[&str], console: ConsoleMark) {
        let rec = LaunchRecord {
            nonce: nonce.into(), job: JOB.into(), started,
            takes_before: BTreeMap::from([(CLIP.to_string(), before.iter().map(|s| s.to_string()).collect())]),
            console,
        };
        let dir = write_record(job_dir, &rec).unwrap();
        write_pids(&dir, nonce, &LaunchPids { hlae: ProcId { pid: 30, created: started } }).unwrap();
    }
    fn n(i: u8) -> String {
        format!("{i:02x}").repeat(16)
    }

    #[test]
    fn a_relaunch_after_a_failed_run_keeps_the_older_complete_take_and_the_old_line_proves_nothing_new() {
        let root = scratch("relaunch");
        let job = root.join("jobs").join(JOB);
        fs::create_dir_all(&job).unwrap();
        let log = root.join("console.log");
        let procs = Fake::new();
        // launch 1 records take0000 to its end tick
        record(&job, &n(1), 1000, &[], console_mark(&log));
        fs::write(&log, format!("[cs2stats] director loaded job={JOB}: 1 demos nonce={}\n[cs2stats] END {CLIP} nonce={} why=end_tick tick=2000\n", n(1), n(1))).unwrap();
        let mut ls = launches(&job);
        settle(&job, &mut ls[0], &log, None, &procs).unwrap();
        // launch 2 of the same job loses the camera on take0001; CS2 replaced the log, but launch 1's old
        // line (its nonce) is still in front of a stale copy here too
        // CS2 replaced the log for this session: no identity to continue from
        record(&job, &n(2), 2000, &["take0000"], ConsoleMark { identity: None, len: 0 });
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=2000\n[cs2stats] END {CLIP} nonce={} why=camera_lost tick=1500\n", n(1), n(2))).unwrap();
        let mut ls = launches(&job);
        for l in ls.iter_mut() {
            settle(&job, l, &log, None, &procs).unwrap();
        }
        assert_eq!(take_proven(&ls, CLIP, "take0000"), Ok(()));
        assert_eq!(take_proven(&ls, CLIP, "take0001").unwrap_err(), "the director stopped this clip early (camera_lost)");
        // launch 1's result was kept, not read again from the replaced log
        assert_eq!(ls[0].result.as_ref().unwrap().evidence, "console.log from its start (CS2 replaced it)");
        // a take no launch made does not count
        assert!(take_proven(&ls, "c-0123456789abcdef-r4", "take0000").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_forged_or_old_line_does_not_count() {
        let root = scratch("forged");
        let log = root.join("console.log");
        let mark = ConsoleMark { identity: None, len: 0 };
        // chat and player names: the marker not at the line's start; an old launch's nonce; a guessed one
        fs::write(&log, format!(
            "Player [cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n  [cs2stats] END {CLIP} nonce={} why=end_tick\n[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n[cs2stats] END {CLIP} why=end_tick nonce={}\n",
            n(5), n(5), n(4), "0".repeat(32), n(5),
        )).unwrap();
        let r = read_console(&log, &mark, &n(5));
        assert_eq!((r.ended, r.stopped), (vec![], vec![]));
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\r\n", n(5))).unwrap();
        assert_eq!(read_console(&log, &mark, &n(5)).ended, [CLIP]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_log_is_read_from_the_launch_offset_only_while_it_is_the_same_grown_file() {
        let root = scratch("rotate");
        let log = root.join("console.log");
        fs::write(&log, "x".repeat(100) + "\n").unwrap();
        let mark = console_mark(&log);
        assert_eq!(mark.len, 101);
        // appended: read from byte 101, so a line before it does not count even with the nonce
        let mut f = fs::OpenOptions::new().append(true).open(&log).unwrap();
        std::io::Write::write_all(&mut f, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n", n(7)).as_bytes()).unwrap();
        drop(f);
        let r = read_console(&log, &mark, &n(7));
        assert_eq!((r.ended.as_slice(), r.evidence.as_str()), (&[CLIP.to_string()][..], "console.log from byte 101"));
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n", n(7))).unwrap();
        // truncated below the launch length, or replaced by another file: read from the start, where only
        // this nonce's lines count
        let shorter = ConsoleMark { identity: mark.identity, len: 10_000 };
        assert_eq!(read_console(&log, &shorter, &n(7)).evidence, "console.log from its start (CS2 replaced it)");
        let other = ConsoleMark { identity: Some((1, 2)), len: 0 };
        assert_eq!(read_console(&log, &other, &n(7)).ended, [CLIP]);
        // no log at all: the evidence is missing
        fs::remove_file(&log).unwrap();
        let r = read_console(&log, &mark, &n(7));
        assert!(r.ended.is_empty() && r.evidence.starts_with("missing"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_launch_settles_only_after_its_processes_exit_and_once() {
        let root = scratch("settle");
        let job = root.join("jobs").join(JOB);
        fs::create_dir_all(&job).unwrap();
        let log = root.join("console.log");
        let procs = Fake::new();
        record(&job, &n(3), 1000, &[], console_mark(&log));
        let hlae = ProcId { pid: 30, created: 1000 };
        procs.alive.borrow_mut().push(hlae);
        fs::write(&log, format!("[cs2stats] END {CLIP} nonce={} why=end_tick tick=1\n", n(3))).unwrap();
        let mut ls = launches(&job);
        settle(&job, &mut ls[0], &log, None, &procs).unwrap();
        assert!(ls[0].result.is_none(), "HLAE still running");
        procs.alive.borrow_mut().clear();
        *procs.cs2.borrow_mut() = true;
        settle(&job, &mut ls[0], &log, None, &procs).unwrap();
        assert!(ls[0].result.is_none(), "CS2 still running");
        *procs.cs2.borrow_mut() = false;
        settle(&job, &mut ls[0], &log, Some(&n(3)), &procs).unwrap();
        assert!(ls[0].result.is_none(), "its lock still held");
        settle(&job, &mut ls[0], &log, None, &procs).unwrap();
        assert_eq!(ls[0].result.as_ref().unwrap().ended, [CLIP]);
        // settled once: a later log does not change it
        fs::write(&log, "").unwrap();
        let mut ls = launches(&job);
        settle(&job, &mut ls[0], &log, None, &procs).unwrap();
        assert_eq!(ls[0].result.as_ref().unwrap().ended, [CLIP]);
        // a launch whose HLAE never started settles with nothing
        let rec = LaunchRecord { nonce: n(4), job: JOB.into(), started: 3000, takes_before: BTreeMap::new(), console: console_mark(&log) };
        write_record(&job, &rec).unwrap();
        let mut ls = launches(&job);
        settle(&job, &mut ls[1], &log, None, &procs).unwrap();
        assert_eq!(ls[1].result.as_ref().unwrap().evidence, "missing: HLAE was not started");
        let _ = fs::remove_dir_all(&root);
    }
}
