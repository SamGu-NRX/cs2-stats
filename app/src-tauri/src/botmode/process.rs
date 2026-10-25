//! Whether CS2 is running. Every operation that writes game files checks this first and
//! refuses while `cs2.exe` is up: the game holds plugin DLLs open, and a half-swapped mod
//! in a live process is exactly what Bot Mode exists to avoid.

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

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
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
            let mut found = false;
            let mut ok = Process32FirstW(snap, &mut entry);
            while ok != 0 {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case(exe) {
                    found = true;
                    break;
                }
                ok = Process32NextW(snap, &mut entry);
            }
            CloseHandle(snap);
            Ok(found)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn is_running(_exe: &str) -> Result<bool, String> {
        Err("checking for cs2.exe is only implemented on Windows".into())
    }
}

#[cfg(test)]
pub mod fake {
    use super::ProcessProbe;

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
}
