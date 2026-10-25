//! Whether CS2 is running, and the lock that keeps two Bot Mode operations apart.
//!
//! Every operation that writes game files checks for `cs2.exe` first and refuses while it
//! is up: the game holds plugin DLLs open, and a half-swapped mod in a live process is exactly
//! what Bot Mode exists to avoid. The check is repeated right before each batch of writes and
//! right before Steam is asked to start the game. CS2 starting in the middle of a write cannot
//! be prevented; the change journal (`changes.rs`) is what recovers from that.

use super::paths::Layout;
use std::fs::{self, File};

pub trait ProcessProbe: Send + Sync {
    fn cs2_running(&self) -> Result<bool, String>;
}

/// Reads the live process list.
pub struct SystemProbe;

impl ProcessProbe for SystemProbe {
    fn cs2_running(&self) -> Result<bool, String> {
        imp::is_running("cs2.exe")
    }
}

/// Fails closed: an error from the process list refuses the change, like a running game.
pub fn ensure_cs2_closed(probe: &dyn ProcessProbe) -> Result<(), String> {
    match probe.cs2_running() {
        Ok(false) => Ok(()),
        Ok(true) => Err("CS2 is running (cs2.exe). Close the game first: Bot Mode never changes game files while it runs.".into()),
        Err(e) => Err(format!("could not check whether CS2 is running, so nothing was changed: {e}")),
    }
}

/// How a walk of the process list ended, reduced to the answer. Only a walk that saw at least
/// one process and stopped because the list ran out (`ERROR_NO_MORE_FILES`) can say "not
/// running"; any other ending is an error, so the caller refuses.
pub fn conclude(found: bool, seen: usize, end_error: u32) -> Result<bool, String> {
    const ERROR_NO_MORE_FILES: u32 = 18;
    if found {
        Ok(true)
    } else if end_error != ERROR_NO_MORE_FILES {
        Err(format!("reading the process list stopped with Windows error {end_error}"))
    } else if seen == 0 {
        Err("the process list was empty".into())
    } else {
        Ok(false)
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    pub fn is_running(exe: &str) -> Result<bool, String> {
        // SAFETY: plain Win32 calls on a snapshot handle this function owns and closes.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return Err(format!("process snapshot failed: {}", std::io::Error::last_os_error()));
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let (mut found, mut seen) = (false, 0usize);
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                seen += 1;
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(exe) {
                    found = true;
                    break;
                }
                ok = Process32NextW(snap, &mut entry);
            }
            let end_error = if found { 0 } else { GetLastError() };
            CloseHandle(snap);
            super::conclude(found, seen, end_error)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn is_running(_exe: &str) -> Result<bool, String> {
        Err("checking for cs2.exe is only implemented on Windows".into())
    }
}

/// Held for the whole of an operation that writes game files or app data. On Windows the lock
/// file is opened with no sharing, so a second Bot Mode process (or a second operation in this
/// one) cannot open it, and the OS releases it if the process dies.
pub struct OpLock {
    _file: File,
}

impl OpLock {
    pub fn acquire(layout: &Layout) -> Result<OpLock, String> {
        fs::create_dir_all(&layout.data).map_err(|e| format!("{}: {e}", layout.data.display()))?;
        let path = layout.data.join("botmode.lock");
        let mut opts = fs::OpenOptions::new();
        opts.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        std::os::windows::fs::OpenOptionsExt::share_mode(&mut opts, 0);
        match opts.open(&path) {
            Ok(file) => Ok(OpLock { _file: file }),
            // ERROR_SHARING_VIOLATION: another holder has it open.
            Err(e) if e.raw_os_error() == Some(32) => Err(format!(
                "another Bot Mode operation is running (it holds {}); wait for it to finish",
                path.display()
            )),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }
}

#[cfg(test)]
pub mod fake {
    use super::ProcessProbe;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub struct Running(pub bool);
    impl ProcessProbe for Running {
        fn cs2_running(&self) -> Result<bool, String> {
            Ok(self.0)
        }
    }

    pub struct Broken;
    impl ProcessProbe for Broken {
        fn cs2_running(&self) -> Result<bool, String> {
            Err("snapshot denied".into())
        }
    }

    /// Answers call `n` (from 1) with `script(n)`, to stage CS2 starting, or another writer
    /// acting, between two checks.
    pub struct Scripted<F: Fn(usize) -> bool + Send + Sync> {
        calls: AtomicUsize,
        script: F,
    }
    impl<F: Fn(usize) -> bool + Send + Sync> Scripted<F> {
        pub fn new(script: F) -> Self {
            Scripted { calls: AtomicUsize::new(0), script }
        }
    }
    impl<F: Fn(usize) -> bool + Send + Sync> ProcessProbe for Scripted<F> {
        fn cs2_running(&self) -> Result<bool, String> {
            Ok((self.script)(self.calls.fetch_add(1, Ordering::SeqCst) + 1))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_complete_walk_of_the_process_list_means_not_running() {
        assert_eq!(conclude(false, 120, 18), Ok(false));
        assert_eq!(conclude(true, 3, 0), Ok(true));
        // Process32FirstW failing (access denied) or the walk stopping early must refuse.
        assert!(conclude(false, 0, 5).is_err());
        assert!(conclude(false, 40, 24).is_err());
        assert!(conclude(false, 0, 18).is_err());
    }
}
