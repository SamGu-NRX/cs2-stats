//! Whether CS2 is running, the lock that keeps two Bot Mode operations apart, and the check
//! on the CS2 process a launch starts.
//!
//! Every operation that writes game files checks for `cs2.exe` first and refuses while it
//! is up: the game holds plugin DLLs open, and a half-swapped mod in a live process is exactly
//! what Bot Mode exists to avoid. The check is repeated right before each batch of writes and
//! right before Steam is asked to start the game. CS2 starting in the middle of a write cannot
//! be prevented; the change journal (`changes.rs`) is what recovers from that.

use super::paths::Layout;
use std::fs::{self, File};

/// Where a CS2 check happens. The real probe ignores it; tests use it to stage CS2 starting,
/// or another program acting, at one exact point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// The start of an install, overlay, setting or rollback.
    Operation,
    /// `ChangeSet::begin`, right before a change's writes.
    ChangeBegin,
    /// An explicit rollback, after its first pass and before it restores anything.
    Rollback,
    /// The automatic rollback of a failed change, before it restores anything.
    AutomaticRollback,
    LaunchPrepare,
    /// Right before Steam is asked to start the game.
    LaunchStart,
    Status,
}

pub trait ProcessProbe: Send + Sync {
    fn cs2_running(&self, phase: Phase) -> Result<bool, String>;
}

/// Reads the live process list.
pub struct SystemProbe;

impl ProcessProbe for SystemProbe {
    fn cs2_running(&self, _phase: Phase) -> Result<bool, String> {
        Ok(!imp::pids("cs2.exe")?.is_empty())
    }
}

/// Fails closed: an error from the process list refuses the change, like a running game.
pub fn ensure_cs2_closed(probe: &dyn ProcessProbe, phase: Phase) -> Result<(), String> {
    match probe.cs2_running(phase) {
        Ok(false) => Ok(()),
        Ok(true) => Err("CS2 is running (cs2.exe). Close the game first: Bot Mode never changes game files while it runs.".into()),
        Err(e) => Err(format!("could not check whether CS2 is running, so nothing was changed: {e}")),
    }
}

/// How a walk of the process list ended, reduced to the answer. Only a walk that saw at least
/// one process and stopped because the list ran out (`ERROR_NO_MORE_FILES`) is a complete
/// list; any other ending is an error, so the caller refuses.
pub fn conclude(seen: usize, end_error: u32) -> Result<(), String> {
    const ERROR_NO_MORE_FILES: u32 = 18;
    if end_error != ERROR_NO_MORE_FILES {
        Err(format!("reading the process list stopped with Windows error {end_error}"))
    } else if seen == 0 {
        Err("the process list was empty".into())
    } else {
        Ok(())
    }
}

/// Process ids of every running `cs2.exe`, from a complete walk of the process list.
pub fn cs2_pids() -> Result<Vec<u32>, String> {
    imp::pids("cs2.exe")
}

/// The CS2 process a launch started: the one `cs2.exe` that was not running before Steam was
/// asked to start the game. More than one new `cs2.exe` is an error, because which one is
/// ours would be a guess.
pub fn new_process(before: &[u32], now: &[u32]) -> Result<Option<u32>, String> {
    let new: Vec<u32> = now.iter().copied().filter(|p| !before.contains(p)).collect();
    match new.as_slice() {
        [] => Ok(None),
        [pid] => Ok(Some(*pid)),
        many => Err(format!("{} new cs2.exe processes appeared ({many:?}); cannot tell which one this launch started", many.len())),
    }
}

/// Whether a command-line token turns VAC back on: after stripping leading `-` and `+`,
/// lowercasing, and cutting at `=` or whitespace, it is `secure`. So `-secure`, `+secure`,
/// `--secure`, `-secure=1` and `-SECURE` all are; `-insecure` is not.
pub fn is_secure_token(token: &str) -> bool {
    let t = token.trim_start_matches(['-', '+']).to_ascii_lowercase();
    t.split(|c: char| c == '=' || c.is_whitespace()).next() == Some("secure")
}

/// What to do with the CS2 process a launch started, given its command line (`None` when it
/// could not be read). Anything but a readable command line with `-insecure` and no
/// secure-enabling token means: end it now.
pub fn judge_command_line(command_line: Option<&str>) -> Result<(), String> {
    let Some(line) = command_line else {
        return Err("its command line could not be read, so -insecure could not be confirmed".into());
    };
    let tokens = super::launch::split(line).map_err(|e| format!("its command line could not be parsed ({e})"))?;
    if let Some(t) = tokens.iter().find(|t| is_secure_token(t)) {
        return Err(format!("its command line contains {t}, which turns VAC on with the mod loaded"));
    }
    if !tokens.iter().any(|t| t.eq_ignore_ascii_case("-insecure")) {
        return Err("its command line lacks -insecure".into());
    }
    Ok(())
}

/// Reads a process's command line without changing it.
pub fn command_line(pid: u32) -> Result<String, String> {
    imp::command_line(pid)
}

/// Ends one process, by id. Only ever called with the id [`new_process`] picked for this
/// launch's `cs2.exe`.
pub fn terminate(pid: u32) -> Result<(), String> {
    imp::terminate(pid)
}

#[cfg(windows)]
mod imp {
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE, UNICODE_STRING};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};

    pub fn pids(exe: &str) -> Result<Vec<u32>, String> {
        // SAFETY: plain Win32 calls on a snapshot handle this function owns and closes.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(format!("process snapshot failed: {}", std::io::Error::last_os_error()));
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let (mut found, mut seen) = (Vec::new(), 0usize);
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                seen += 1;
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(exe) {
                    found.push(entry.th32ProcessID);
                }
                ok = Process32NextW(snap, &mut entry);
            }
            let end_error = GetLastError();
            CloseHandle(snap);
            super::conclude(seen, end_error)?;
            Ok(found)
        }
    }

    pub fn command_line(pid: u32) -> Result<String, String> {
        // SAFETY: the handle is closed before returning; the buffer holds the UNICODE_STRING
        // header and the string it points into, and the pointer and length are bounds-checked.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return Err(format!("opening process {pid}: {}", std::io::Error::last_os_error()));
            }
            let mut buf = vec![0u8; 1 << 16];
            let mut ret = 0u32;
            let status = NtQueryInformationProcess(h, ProcessCommandLineInformation, buf.as_mut_ptr().cast(), buf.len() as u32, &mut ret);
            CloseHandle(h);
            if status < 0 {
                return Err(format!("reading the command line of process {pid}: NTSTATUS {status:#x}"));
            }
            let us = &*(buf.as_ptr() as *const UNICODE_STRING);
            let start = us.Buffer as usize;
            let (lo, hi) = (buf.as_ptr() as usize, buf.as_ptr() as usize + buf.len());
            let len = us.Length as usize;
            if us.Buffer.is_null() || start < lo || start + len > hi || len % 2 != 0 {
                return Err(format!("process {pid} returned a malformed command line"));
            }
            let chars = std::slice::from_raw_parts(us.Buffer, len / 2);
            Ok(String::from_utf16_lossy(chars))
        }
    }

    pub fn terminate(pid: u32) -> Result<(), String> {
        // SAFETY: the handle is closed before returning.
        unsafe {
            let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                return Err(format!("opening process {pid} to end it: {}", std::io::Error::last_os_error()));
            }
            let ok = TerminateProcess(h, 1);
            let err = std::io::Error::last_os_error();
            CloseHandle(h);
            if ok == 0 {
                return Err(format!("ending process {pid}: {err}"));
            }
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn pids(_exe: &str) -> Result<Vec<u32>, String> {
        Err("checking for cs2.exe is only implemented on Windows".into())
    }
    pub fn command_line(_pid: u32) -> Result<String, String> {
        Err("reading a command line is only implemented on Windows".into())
    }
    pub fn terminate(_pid: u32) -> Result<(), String> {
        Err("ending a process is only implemented on Windows".into())
    }
}

/// Held for the whole of an operation that writes game files or app data. On Windows the lock
/// file is opened with no sharing, so a second Bot Mode process (or a second operation in this
/// one) cannot open it, and the OS releases it if the process dies.
///
/// The file lock alone would let two app folders (`--data`) work on one game folder at once,
/// so the lock also holds a named mutex derived from the canonical game folder. The mutex
/// exists exactly while a holder keeps its handle open; creating it when it already exists
/// means another operation is working on that game folder.
pub struct OpLock {
    _file: File,
    _game: GameMutex,
}

/// The game folder's mutex. It is created in the `Global\` namespace, so that operations in
/// two Windows sessions (fast user switching, a remote desktop session) also exclude each
/// other. If Windows refuses a `Global\` object to this user, it falls back to `Local\`, which
/// only excludes operations within one session; two sessions could then each run an operation
/// on the same game folder at once.
#[cfg(windows)]
struct GameMutex(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl GameMutex {
    fn acquire(csgo: &std::path::Path) -> Result<GameMutex, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let canon = csgo.canonicalize().map_err(|e| format!("{}: {e}", csgo.display()))?;
        let key = super::hash::bytes(canon.to_string_lossy().to_lowercase().as_bytes());
        for scope in ["Global", "Local"] {
            let name: Vec<u16> = format!("{scope}\\cs2-stats-botmode-{}", &key[..32]).encode_utf16().chain(Some(0)).collect();
            // SAFETY: `name` is NUL-terminated and outlives the call; the handle is closed in Drop.
            unsafe {
                let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
                let err = GetLastError();
                if h.is_null() {
                    if err == ERROR_ACCESS_DENIED && scope == "Global" {
                        continue;
                    }
                    return Err(format!("creating the game folder lock: {}", std::io::Error::from_raw_os_error(err as i32)));
                }
                if err == ERROR_ALREADY_EXISTS {
                    CloseHandle(h);
                    return Err(format!(
                        "another Bot Mode operation is working on {} (possibly with a different app folder); wait for it to finish",
                        canon.display()
                    ));
                }
                return Ok(GameMutex(h));
            }
        }
        Err("creating the game folder lock: Windows refused both the Global and Local namespaces".into())
    }
}

#[cfg(windows)]
impl Drop for GameMutex {
    fn drop(&mut self) {
        // SAFETY: the handle came from CreateMutexW and is closed once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(not(windows))]
struct GameMutex;

#[cfg(not(windows))]
impl GameMutex {
    fn acquire(_csgo: &std::path::Path) -> Result<GameMutex, String> {
        Ok(GameMutex)
    }
}

impl OpLock {
    pub fn acquire(layout: &Layout) -> Result<OpLock, String> {
        fs::create_dir_all(&layout.data).map_err(|e| format!("{}: {e}", layout.data.display()))?;
        let path = layout.data.join("botmode.lock");
        let mut opts = fs::OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::share_mode(&mut opts, 0);
        let file = match opts.open(&path) {
            Ok(file) => file,
            // ERROR_SHARING_VIOLATION: another holder has it open.
            Err(e) if e.raw_os_error() == Some(32) => {
                return Err(format!("another Bot Mode operation is running (it holds {}); wait for it to finish", path.display()))
            }
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        Ok(OpLock { _file: file, _game: GameMutex::acquire(&layout.csgo)? })
    }
}

#[cfg(test)]
pub mod fake {
    use super::{Phase, ProcessProbe};

    pub struct Running(pub bool);
    impl ProcessProbe for Running {
        fn cs2_running(&self, _phase: Phase) -> Result<bool, String> {
            Ok(self.0)
        }
    }

    pub struct Broken;
    impl ProcessProbe for Broken {
        fn cs2_running(&self, _phase: Phase) -> Result<bool, String> {
            Err("snapshot denied".into())
        }
    }

    /// Answers each check with `script(phase)`, to stage CS2 starting, or another program
    /// acting, at one named point.
    pub struct Scripted<F: Fn(Phase) -> bool + Send + Sync>(pub F);
    impl<F: Fn(Phase) -> bool + Send + Sync> ProcessProbe for Scripted<F> {
        fn cs2_running(&self, phase: Phase) -> Result<bool, String> {
            Ok((self.0)(phase))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_complete_walk_of_the_process_list_counts() {
        assert_eq!(conclude(120, 18), Ok(()));
        // Process32FirstW failing (access denied) or the walk stopping early must refuse.
        assert!(conclude(0, 5).is_err());
        assert!(conclude(40, 24).is_err());
        assert!(conclude(0, 18).is_err());
    }

    #[test]
    fn every_spelling_of_secure_is_caught_and_insecure_is_not() {
        for t in ["-secure", "+secure", "--secure", "-secure=1", "-SECURE", "secure", "-secure 1"] {
            assert!(is_secure_token(t), "{t}");
        }
        for t in ["-insecure", "-securex", "+exec", "-novid", "-secure_mode_off"] {
            assert!(!is_secure_token(t), "{t}");
        }
    }

    #[test]
    fn the_launched_process_is_kept_only_with_insecure_and_nothing_secure() {
        let exe = r#""C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe""#;
        assert_eq!(judge_command_line(Some(&format!("{exe} -insecure -novid +exec autoexec"))), Ok(()));
        assert_eq!(judge_command_line(Some(&format!("{exe} -INSECURE"))), Ok(()));
        for bad in [
            format!("{exe} -novid"),
            format!("{exe} -insecure +secure"),
            format!("{exe} -insecure --secure"),
            format!("{exe} -insecure -secure=1"),
            format!("{exe} -insecure \"-secure\""),
            format!("{exe} -insecure \"unbalanced"),
        ] {
            assert!(judge_command_line(Some(&bad)).is_err(), "{bad}");
        }
        assert!(judge_command_line(None).unwrap_err().contains("could not be read"));
    }

    #[cfg(windows)]
    #[test]
    fn the_command_line_of_a_running_process_can_be_read() {
        // This test's own process: read-only, and its executable name is known.
        let line = command_line(std::process::id()).unwrap();
        let exe = std::env::current_exe().unwrap();
        let stem = exe.file_stem().unwrap().to_string_lossy().to_string();
        assert!(line.contains(&stem), "{line}");
    }

    #[test]
    fn only_the_cs2_process_this_launch_started_is_ever_picked() {
        assert_eq!(new_process(&[], &[4120]), Ok(Some(4120)));
        assert_eq!(new_process(&[900], &[900]), Ok(None), "an older cs2.exe is never ours");
        assert_eq!(new_process(&[900], &[900, 4120]), Ok(Some(4120)));
        assert!(new_process(&[], &[4120, 4121]).is_err(), "two candidates: refuse to guess");
    }
}
