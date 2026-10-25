//! Whether CS2 is running, the lock that keeps two Bot Mode operations apart, and the system
//! calls the post-launch check (`monitor.rs`) uses.
//!
//! Every operation that writes game files checks for `cs2.exe` first and refuses while it
//! is up: the game holds plugin DLLs open, and a half-swapped mod in a live process is exactly
//! what Bot Mode exists to avoid. The check is repeated right before each batch of writes and
//! right before Steam is asked to start the game. CS2 starting in the middle of a write cannot
//! be prevented; the change journal (`changes.rs`) is what recovers from that.

use super::monitor::Listed;
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

/// Whether a command-line token turns VAC back on: after stripping leading `-` and `+`,
/// lowercasing, and cutting at `=` or whitespace, it is `secure`. So `-secure`, `+secure`,
/// `--secure`, `-secure=1` and `-SECURE` all are; `-insecure` is not.
pub fn is_secure_token(token: &str) -> bool {
    let t = token.trim_start_matches(['-', '+']).to_ascii_lowercase();
    t.split(|c: char| c == '=' || c.is_whitespace()).next() == Some("secure")
}

/// Whether a CS2 process may keep running, given its command line (`None` when it could not
/// be read). Anything but a readable command line with `-insecure` and no secure-enabling
/// token means: end it now.
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

/// Every running `cs2.exe` with its creation time, from a complete walk of the process list.
/// A process that exits during the walk is left out.
pub fn cs2_listed() -> Result<Vec<Listed>, String> {
    let mut out = Vec::new();
    for pid in imp::pids("cs2.exe")? {
        if let Some(p) = OpenProcess::open(pid)? {
            out.push(Listed { pid, created: p.creation()? });
        }
    }
    Ok(out)
}

/// The current time as a Windows FILETIME.
pub fn file_time_now() -> u64 {
    imp::file_time_now()
}

/// One process opened once, with query-limited, terminate and synchronize access. Reading its
/// details and ending it all go through this one handle, never a fresh open by id.
pub struct OpenProcess(imp::Handle);

impl OpenProcess {
    /// `None` when no process has that id any more.
    pub fn open(pid: u32) -> Result<Option<OpenProcess>, String> {
        Ok(imp::open(pid)?.map(OpenProcess))
    }

    fn creation(&self) -> Result<u64, String> {
        imp::creation_time(&self.0)
    }
}

impl super::monitor::Cs2Process for OpenProcess {
    fn created(&self) -> Result<u64, String> {
        self.creation()
    }
    fn image(&self) -> Result<std::path::PathBuf, String> {
        imp::image(&self.0)
    }
    fn command_line(&self) -> Result<String, String> {
        imp::command_line(&self.0)
    }
    fn terminate(&self) -> Result<(), String> {
        imp::terminate(&self.0)
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, FILETIME, HANDLE, INVALID_HANDLE_VALUE, UNICODE_STRING};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    pub struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: the handle came from OpenProcess and is closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

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

    pub fn file_time_now() -> u64 {
        let mut ft = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        // SAFETY: writes one FILETIME.
        unsafe { GetSystemTimeAsFileTime(&mut ft) };
        (u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)
    }

    pub fn open(pid: u32) -> Result<Option<Handle>, String> {
        const ERROR_INVALID_PARAMETER: i32 = 87;
        // SAFETY: plain call; the handle is owned by the returned Handle.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
        if h.is_null() {
            let e = std::io::Error::last_os_error();
            // The process exited between the list and the open.
            if e.raw_os_error() == Some(ERROR_INVALID_PARAMETER) {
                return Ok(None);
            }
            return Err(format!("opening process {pid}: {e}"));
        }
        Ok(Some(Handle(h)))
    }

    pub fn creation_time(h: &Handle) -> Result<u64, String> {
        let z = || FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut c, mut e, mut k, mut u) = (z(), z(), z(), z());
        // SAFETY: writes four FILETIMEs for a handle this module owns.
        if unsafe { GetProcessTimes(h.0, &mut c, &mut e, &mut k, &mut u) } == 0 {
            return Err(format!("reading its creation time: {}", std::io::Error::last_os_error()));
        }
        Ok((u64::from(c.dwHighDateTime) << 32) | u64::from(c.dwLowDateTime))
    }

    pub fn image(h: &Handle) -> Result<std::path::PathBuf, String> {
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        // SAFETY: `len` holds the buffer's size in characters and is updated to the length written.
        if unsafe { QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) } == 0 {
            return Err(format!("reading its executable path: {}", std::io::Error::last_os_error()));
        }
        let len = (len as usize).min(buf.len());
        Ok(std::path::PathBuf::from(String::from_utf16_lossy(&buf[..len])))
    }

    /// `ProcessCommandLineInformation` (class 60), in two calls: the first asks for the size,
    /// the second fills a buffer of that size, aligned for the `UNICODE_STRING` header. Every
    /// length and the string's pointer are checked against the bytes actually returned.
    pub fn command_line(h: &Handle) -> Result<String, String> {
        const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
        const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
        const MAX: u32 = 1 << 20;
        let header = std::mem::size_of::<UNICODE_STRING>() as u32;
        let mut needed = 0u32;
        // SAFETY: a zero-length query only writes `needed`.
        let status = unsafe { NtQueryInformationProcess(h.0, ProcessCommandLineInformation, std::ptr::null_mut(), 0, &mut needed) };
        if status != STATUS_INFO_LENGTH_MISMATCH && status != STATUS_BUFFER_TOO_SMALL {
            return Err(format!("asking for its command line size: NTSTATUS {status:#x}"));
        }
        if needed < header || needed > MAX {
            return Err(format!("its command line size {needed} is out of range"));
        }
        // u64 elements keep the buffer aligned for the header's pointer field.
        let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
        let cap = (buf.len() * 8) as u32;
        let mut ret = 0u32;
        // SAFETY: the buffer has `cap` writable bytes.
        let status = unsafe { NtQueryInformationProcess(h.0, ProcessCommandLineInformation, buf.as_mut_ptr().cast(), cap, &mut ret) };
        if status < 0 {
            return Err(format!("reading its command line: NTSTATUS {status:#x}"));
        }
        if ret < header || ret > cap {
            return Err(format!("its command line came back with an invalid length {ret}"));
        }
        // SAFETY: the buffer is aligned and holds at least a header, checked above.
        let us = unsafe { &*(buf.as_ptr() as *const UNICODE_STRING) };
        let (len, max) = (us.Length as usize, us.MaximumLength as usize);
        if len % 2 != 0 || len > max {
            return Err("its command line has invalid lengths".into());
        }
        if len == 0 {
            return Ok(String::new());
        }
        let base = buf.as_ptr() as usize;
        let start = us.Buffer as usize;
        let end = start.checked_add(len).ok_or("its command line points out of range")?;
        if us.Buffer.is_null() || start < base + header as usize || end > base + ret as usize || start % 2 != 0 {
            return Err("its command line points outside what Windows returned".into());
        }
        // SAFETY: [start, end) lies inside the returned bytes of `buf`, checked above.
        let chars = unsafe { std::slice::from_raw_parts(us.Buffer, len / 2) };
        Ok(String::from_utf16_lossy(chars))
    }

    pub fn terminate(h: &Handle) -> Result<(), String> {
        // SAFETY: plain call on a handle this module owns.
        if unsafe { TerminateProcess(h.0, 1) } == 0 {
            return Err(format!("ending it: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Handle;
    fn unsupported<T>() -> Result<T, String> {
        Err("only implemented on Windows".into())
    }
    pub fn pids(_exe: &str) -> Result<Vec<u32>, String> {
        unsupported()
    }
    pub fn file_time_now() -> u64 {
        0
    }
    pub fn open(_pid: u32) -> Result<Option<Handle>, String> {
        unsupported()
    }
    pub fn creation_time(_h: &Handle) -> Result<u64, String> {
        unsupported()
    }
    pub fn image(_h: &Handle) -> Result<std::path::PathBuf, String> {
        unsupported()
    }
    pub fn command_line(_h: &Handle) -> Result<String, String> {
        unsupported()
    }
    pub fn terminate(_h: &Handle) -> Result<(), String> {
        unsupported()
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

/// The game folder's mutex, in the `Global\` namespace, so operations in two Windows sessions
/// (fast user switching, a remote desktop session) exclude each other too. A standard user can
/// create it (checked on the user's machine without administrator rights). If Windows refuses
/// it, the operation is refused rather than fall back to a per-session lock.
#[cfg(windows)]
struct GameMutex(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl GameMutex {
    fn acquire(csgo: &std::path::Path) -> Result<GameMutex, String> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let canon = csgo.canonicalize().map_err(|e| format!("{}: {e}", csgo.display()))?;
        let key = super::hash::bytes(canon.to_string_lossy().to_lowercase().as_bytes());
        let name: Vec<u16> = format!("Global\\cs2-stats-botmode-{}", &key[..32]).encode_utf16().chain(Some(0)).collect();
        // SAFETY: `name` is NUL-terminated and outlives the call; the handle is closed in Drop.
        unsafe {
            let h = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            let err = GetLastError();
            if h.is_null() {
                return Err(format!(
                    "Windows refused the machine-wide lock for {} ({}), so Bot Mode cannot make sure no other session is changing it; nothing was changed",
                    canon.display(),
                    std::io::Error::from_raw_os_error(err as i32)
                ));
            }
            if err == ERROR_ALREADY_EXISTS {
                CloseHandle(h);
                return Err(format!(
                    "another Bot Mode operation is working on {} (possibly with a different app folder); wait for it to finish",
                    canon.display()
                ));
            }
            Ok(GameMutex(h))
        }
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
    fn a_process_is_kept_only_with_insecure_and_nothing_secure() {
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
    fn a_running_process_is_read_through_one_handle() {
        use super::super::monitor::Cs2Process;
        // This test's own process: opened read-only here (it is never ended).
        let me = OpenProcess::open(std::process::id()).unwrap().expect("this process exists");
        let exe = std::env::current_exe().unwrap();
        let line = me.command_line().unwrap();
        assert!(line.contains(&*exe.file_stem().unwrap().to_string_lossy()), "{line}");
        assert_eq!(me.image().unwrap().canonicalize().unwrap(), exe.canonicalize().unwrap());
        assert!(me.created().unwrap() > 0 && me.created().unwrap() <= file_time_now());
        assert!(OpenProcess::open(u32::MAX - 3).unwrap().is_none(), "an id with no process");
    }
}
