//! Every file operation on the demos store, and on a recorded demo taken out of `replays\`, through
//! one open handle per file (design/recording.md, "Threat model").
//!
//! A file is opened by a single-component name inside a folder whose canonical path was read once,
//! without following a link at the name itself (`FILE_FLAG_OPEN_REPARSE_POINT`, with
//! `FILE_FLAG_BACKUP_SEMANTICS` so a folder or junction there opens too and can be refused). The
//! handle is then checked: a regular file, not a reparse point, with exactly one link, whose final
//! path is directly inside the folder. Only after that is it read, written, renamed or deleted, and
//! through that same handle, so what was checked is what is changed. A file that fails a check is
//! not touched; the caller logs why.
//!
//! What this guards against is an accidental link: a junction, symlink or hard link at or inside the
//! store, which would make a delete or a write land on a file elsewhere. A local program racing the
//! app to swap files between the checks is out of scope: it could delete those files itself.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// ERROR_NOT_SAME_DEVICE: a rename across volumes.
pub const NOT_SAME_DEVICE: i32 = 17;
/// ERROR_SHARING_VIOLATION: another process has the file open in a way this open excludes.
pub const SHARING_VIOLATION: i32 = 32;

/// A name the store opens: one path component of letters, digits, '_', '.' and '-', not "." or "..".
pub fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && s != "." && s != ".." && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}

/// What an open asks for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Read, sharing reads.
    Read,
    /// Read and write, creating the file when it is missing; shared with no one.
    Write,
    /// Read, and rename or delete through the handle; shared with no one, so a file another program
    /// has open fails to open and is left alone.
    Delete,
}

/// What a check of an open handle read: the file's size, times and link count.
#[derive(Clone, Copy, Debug)]
pub struct Info {
    pub size: u64,
    pub modified: SystemTime,
    pub created: SystemTime,
    pub links: u32,
    attributes: u32,
}

/// A folder the store works in: its canonical path, read once for the operation.
pub struct Dir {
    canon: PathBuf,
}

impl Dir {
    /// `path` as a folder to work in. Refused when it is itself a junction or link, or not a folder.
    /// The folders above it may be junctions: some users move AppData with one.
    pub fn open(path: &Path) -> Result<Dir, String> {
        let m = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if crate::botmode::paths::is_reparse(&m) {
            return Err(format!("{} is a junction or link; demos are not kept or taken through one", path.display()));
        }
        if !m.is_dir() {
            return Err(format!("{} is not a folder", path.display()));
        }
        let canon = fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Dir { canon })
    }

    pub fn path(&self) -> &Path {
        &self.canon
    }

    fn at(&self, name: &str) -> Result<PathBuf, String> {
        if !name_ok(name) {
            return Err(format!("{name:?} is not a file name the store opens"));
        }
        Ok(self.canon.join(name))
    }

    /// The names in the folder. Nothing is opened.
    pub fn names(&self) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        for item in fs::read_dir(&self.canon).map_err(|e| format!("{}: {e}", self.canon.display()))? {
            let item = item.map_err(|e| format!("{}: {e}", self.canon.display()))?;
            if let Some(n) = item.file_name().to_str() {
                out.push(n.to_string());
            }
        }
        Ok(out)
    }

    /// Whether anything is at `name`, a link included. Nothing is opened.
    pub fn exists(&self, name: &str) -> bool {
        self.at(name).is_ok_and(|p| fs::symlink_metadata(p).is_ok())
    }

    /// `name` opened and checked; None when nothing is there (and `mode` does not create). An error
    /// says why a file that is there was refused, or could not be opened.
    pub fn open_file(&self, name: &str, mode: Mode) -> Result<Option<(File, Info)>, String> {
        let p = self.at(name)?;
        let f = match options(mode).open(&p) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) if e.raw_os_error() == Some(SHARING_VIOLATION) => return Err(format!("{name} is open in another program")),
            Err(e) => return Err(format!("{name}: {e}")),
        };
        let info = self.check(&f).map_err(|why| format!("{name} {why}"))?;
        Ok(Some((f, info)))
    }

    /// Checks an open handle: a regular file with one link, directly inside this folder.
    pub fn check(&self, f: &File) -> Result<Info, String> {
        let info = info(f).map_err(|e| format!("could not be read ({e})"))?;
        regular(&info)?;
        let at = final_path(f).map_err(|e| format!("could not be located ({e})"))?;
        if !same_path(at.parent(), &self.canon) {
            return Err(format!("resolves outside {}", self.canon.display()));
        }
        Ok(info)
    }

    /// The whole file, None when it is not there.
    pub fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let Some((mut f, _)) = self.open_file(name, Mode::Read)? else { return Ok(None) };
        let mut out = Vec::new();
        f.read_to_end(&mut out).map_err(|e| format!("{name}: {e}"))?;
        Ok(Some(out))
    }

    /// A new file at `name`, failing when anything is there.
    pub fn create_new(&self, name: &str) -> Result<File, String> {
        let p = self.at(name)?;
        let f = options(Mode::Delete).create_new(true).write(true).open(&p).map_err(|e| format!("{name}: {e}"))?;
        self.check(&f).map_err(|why| format!("{name} {why}"))?;
        Ok(f)
    }

    /// Replaces `name` with `data`: a new temporary file, written and flushed, renamed over it through
    /// its handle. An existing `name` that fails a check is refused and left as it is.
    pub fn write_atomic(&self, name: &str, data: &[u8]) -> Result<(), String> {
        if self.exists(name) {
            // only opened to be checked: what replaces it is a new file, and the old one's data is not written
            self.open_file(name, Mode::Read)?;
        }
        let tmp = temp_name(name);
        let mut f = self.create_new(&tmp)?;
        let written = f.write_all(data).and_then(|_| f.sync_all()).map_err(|e| format!("{tmp}: {e}"));
        let renamed = written.and_then(|_| rename(&f, &self.at(name)?, true).map_err(|e| format!("{name}: {e}")));
        if renamed.is_err() {
            let _ = delete(&f);
        }
        renamed
    }

    /// Deletes `name` through a checked handle; false when nothing is there.
    pub fn delete(&self, name: &str) -> Result<bool, String> {
        let Some((f, _)) = self.open_file(name, Mode::Delete)? else { return Ok(false) };
        delete(&f).map_err(|e| format!("{name}: {e}"))?;
        Ok(true)
    }

    /// Renames the open `f` to `name` in this folder, never over a file that is there.
    pub fn rename_into(&self, f: &File, name: &str) -> io::Result<()> {
        let to = self.at(name).map_err(io::Error::other)?;
        rename(f, &to, false)
    }
}

/// A temporary name beside `name`, different for every call in this process and across processes.
fn temp_name(name: &str) -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    format!("{name}.{}-{n}.tmp", std::process::id())
}

/// Opens `path` shared with no one, for reading and then renaming or deleting, without following a
/// link at `path`. While the handle is held nothing else can write, rename or delete the file; an
/// open that another program's handle excludes fails with [`SHARING_VIOLATION`].
pub fn open_exclusive(path: &Path) -> io::Result<File> {
    options(Mode::Delete).open(path)
}

/// Copies `from` (from its start) into `to`, flushes `to`, and returns the copy's hash and length.
pub fn copy(from: &mut File, to: &mut File) -> io::Result<(String, u64)> {
    from.seek(SeekFrom::Start(0))?;
    let (sha, n) = crate::botmode::hash::copy(&mut *from, &mut *to)?;
    to.sync_all()?;
    Ok((sha, n))
}

/// The SHA-256 of `f` from its start.
pub fn hash(f: &mut File) -> io::Result<String> {
    f.seek(SeekFrom::Start(0))?;
    crate::botmode::hash::reader(&mut *f)
}

/// Refuses what is not a regular file with one link.
pub fn regular(i: &Info) -> Result<(), String> {
    const DIRECTORY: u32 = 0x10;
    const REPARSE: u32 = 0x400;
    if i.attributes & REPARSE != 0 {
        return Err("is a junction or link".into());
    }
    if i.attributes & DIRECTORY != 0 {
        return Err("is a folder".into());
    }
    if i.links != 1 {
        return Err(format!("has {} hard links, so changing it would change a file elsewhere", i.links));
    }
    Ok(())
}

fn same_path(a: Option<&Path>, b: &Path) -> bool {
    a.is_some_and(|a| a.as_os_str().to_string_lossy().to_lowercase() == b.as_os_str().to_string_lossy().to_lowercase())
}

#[cfg(windows)]
fn options(mode: Mode) -> OpenOptions {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
    };
    let mut o = OpenOptions::new();
    o.read(true).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
    match mode {
        Mode::Read => o.access_mode(FILE_GENERIC_READ).share_mode(FILE_SHARE_READ),
        Mode::Write => o.write(true).create(true).access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE).share_mode(0),
        Mode::Delete => o.access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE).share_mode(0),
    };
    o
}

#[cfg(windows)]
fn filetime(t: windows_sys::Win32::Foundation::FILETIME) -> SystemTime {
    // 100 ns ticks since 1601-01-01
    let ticks = (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
    let unix = ticks.saturating_sub(116_444_736_000_000_000);
    UNIX_EPOCH + Duration::from_nanos(unix.saturating_mul(100))
}

#[cfg(windows)]
pub fn info(f: &File) -> io::Result<Info> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    // SAFETY: the handle is open for the call; the struct is plain data the call fills.
    unsafe {
        let mut i: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(f.as_raw_handle(), &mut i) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Info {
            size: (u64::from(i.nFileSizeHigh) << 32) | u64::from(i.nFileSizeLow),
            modified: filetime(i.ftLastWriteTime),
            created: filetime(i.ftCreationTime),
            links: i.nNumberOfLinks,
            attributes: i.dwFileAttributes,
        })
    }
}

/// Where the open handle's file is, every link on the way resolved: `\\?\C:\...`, as
/// `fs::canonicalize` writes a folder.
#[cfg(windows)]
pub fn final_path(f: &File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS};
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: `buf` holds `buf.len()` u16s for the call to fill.
        let n = unsafe { GetFinalPathNameByHandleW(f.as_raw_handle(), buf.as_mut_ptr(), buf.len() as u32, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) } as usize;
        if n == 0 {
            return Err(io::Error::last_os_error());
        }
        if n < buf.len() {
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])));
        }
        buf.resize(n + 1, 0);
    }
}

/// Renames the open `f` to the full path `to`, replacing a file there only when `replace` is set.
#[cfg(windows)]
pub fn rename(f: &File, to: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO};
    let wide: Vec<u16> = to.as_os_str().encode_wide().collect();
    let size = std::mem::size_of::<FILE_RENAME_INFO>() + wide.len() * 2;
    // u64s, so the struct's handle field is aligned
    let mut buf = vec![0u64; size.div_ceil(8)];
    let info = buf.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: `buf` is zeroed, aligned and large enough for the struct and the name after it; the
    // handle is open for the call.
    unsafe {
        (*info).Anonymous.ReplaceIfExists = u8::from(replace);
        (*info).RootDirectory = std::ptr::null_mut();
        (*info).FileNameLength = (wide.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(), wide.len());
        if SetFileInformationByHandle(f.as_raw_handle(), FileRenameInfo, info.cast(), size as u32) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Deletes the open `f`'s file once the handle closes, through the handle.
#[cfg(windows)]
pub fn delete(f: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO};
    let d = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    // SAFETY: the handle is open for the call, with DELETE access; `d` outlives it.
    let ok = unsafe { SetFileInformationByHandle(f.as_raw_handle(), FileDispositionInfo, std::ptr::addr_of!(d).cast(), std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn options(_mode: Mode) -> OpenOptions {
    OpenOptions::new()
}
#[cfg(not(windows))]
pub fn info(_f: &File) -> io::Result<Info> {
    Err(io::Error::other("the demos store is only kept on Windows"))
}
#[cfg(not(windows))]
pub fn final_path(_f: &File) -> io::Result<PathBuf> {
    Err(io::Error::other("the demos store is only kept on Windows"))
}
#[cfg(not(windows))]
pub fn rename(_f: &File, _to: &Path, _replace: bool) -> io::Result<()> {
    Err(io::Error::other("the demos store is only kept on Windows"))
}
#[cfg(not(windows))]
pub fn delete(_f: &File) -> io::Result<()> {
    Err(io::Error::other("the demos store is only kept on Windows"))
}
