//! Where things live, and which game files Bot Mode may change.
//!
//! Every game path is a relative path under `game\csgo`, written with forward slashes
//! ("addons/metamod.vdf"). [`rel`] is the only way to make one, so a path from a zip, a
//! manifest or a journal cannot climb out of the game folder.

use std::path::{Path, PathBuf};

/// The game folder (`...\Counter-Strike Global Offensive\game\csgo`) and the app's own
/// Bot Mode folder (`%APPDATA%\BotMatchStats\botmode`).
#[derive(Debug, Clone)]
pub struct Layout {
    pub csgo: PathBuf,
    pub data: PathBuf,
}

impl Layout {
    pub fn target(&self, rel: &str) -> PathBuf {
        join_rel(&self.csgo, rel)
    }

    /// A game path to read, resolved through [`confined`] like every write.
    pub fn confined(&self, rel: &str) -> Result<PathBuf, String> {
        confined_read(&self.csgo, rel)
    }
    pub fn backups(&self) -> PathBuf {
        self.data.join("backups")
    }
    /// Downloaded release zips and their file-hash indexes, one folder per tag.
    pub fn releases(&self) -> PathBuf {
        self.data.join("releases")
    }
    /// Downloaded overlay artifacts.
    pub fn artifacts(&self) -> PathBuf {
        self.data.join("artifacts")
    }
    pub fn state_file(&self) -> PathBuf {
        self.data.join("state.json")
    }
    pub fn settings_file(&self) -> PathBuf {
        self.data.join("settings.json")
    }
    pub fn default_manifest(&self) -> PathBuf {
        self.data.join("overlay.json")
    }
}

/// `root` joined with a forward-slash relative path.
pub fn join_rel(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// `%APPDATA%\BotMatchStats\botmode`, next to the match folder the app already reads.
pub fn default_data_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join("botmode"))
}

/// Validates and normalises a path relative to `game\csgo`. Rejects absolute paths, drive
/// prefixes, `..`, empty segments and `:` (which on NTFS would name an alternate data stream).
pub fn rel(raw: &str) -> Result<String, String> {
    let s = raw.replace('\\', "/");
    let ok = !s.is_empty()
        && !s.starts_with('/')
        && !s.contains(':')
        && s.split('/').all(|p| !p.is_empty() && p != "." && p != "..");
    if ok {
        Ok(s)
    } else {
        Err(format!("{raw}: not a relative path inside the game folder"))
    }
}

/// How Bot Mode treats a game path it is about to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protection {
    /// An ordinary mod file: back it up, then replace it.
    None,
    /// `cfg\gamemode_competitive_server.cfg`, which holds the user's own `br_*` convars and runs
    /// after the mod's cfgs. Only known convar lines are merged into it; it is never replaced.
    MergeConvars,
    /// Never written: any `autoexec*` file, and the user's knife skeleton override under
    /// `addons\metamod\animation\`.
    Keep,
}

pub const SERVER_CFG: &str = "cfg/gamemode_competitive_server.cfg";
const ANIMATION_DIR: &str = "addons/metamod/animation/";

pub fn protection(rel: &str) -> Protection {
    let lower = rel.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or("");
    if lower == SERVER_CFG {
        Protection::MergeConvars
    } else if name.starts_with("autoexec") || lower.starts_with(ANIMATION_DIR) {
        Protection::Keep
    } else {
        Protection::None
    }
}

/// Files the game or the plugins write while running. They are never hashed as part of a
/// component, so a new log line does not read as a changed install.
pub fn is_runtime_output(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    lower.ends_with(TMP_SUFFIX)
        || lower.split('/').last() == Some("console.log")
        || lower.split('/').any(|p| matches!(p, "logs" | "recordings" | "_iconcache"))
}

/// Suffix of the temporary file written next to a target before it is renamed into place.
pub const TMP_SUFFIX: &str = ".botmode-tmp";

/// Whether a file or folder is a junction or symbolic link (or another reparse point).
pub fn is_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        std::os::windows::fs::MetadataExt::file_attributes(meta) & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// The path to use for `rel`, checked to stay physically inside the game folder:
/// - No existing part of `rel` under `root`, nor its `.botmode-tmp` sibling, is a junction or
///   symbolic link. `rel()` stops `..` in the text; this stops a link that leads elsewhere.
/// - With `create`, the parent folders are created, then the canonical parent must lie inside
///   `root_canon` (the canonical game folder).
///
/// Callers run this again immediately before each open, rename and remove, which keeps the
/// time between check and use short but not zero. Closing that gap would take handle-relative
/// Windows I/O (opening each folder and working from its handle), and it is not built, on
/// purpose. Bot Mode is a single-user desktop tool. The only thing that could swap a folder for
/// a junction inside that gap is another process running as the same user, and such a process
/// can already write anything it likes into the game folder directly. Full handle confinement
/// would therefore protect nothing that matters. These checks exist to stop accidents (a
/// junction the user made, a hostile path in a zip or manifest), not an attacker who already
/// runs as the user.
///
/// The one gap that does matter, starting the modded game with VAC on, is not left to these
/// pre-checks: Steam adds launch options from memory that no file read can see. `launch::start`
/// therefore checks the command line of the `cs2.exe` it started and ends that process unless
/// `-insecure` is there and nothing turns VAC back on, which closes that gap for good.
pub fn confined(root: &Path, root_canon: &Path, rel: &str, create: bool) -> Result<PathBuf, String> {
    let rel = self::rel(rel)?;
    let link = |p: &Path| format!("{rel}: {} is a junction or symbolic link; Bot Mode only writes real folders inside the game folder", p.display());
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
        match std::fs::symlink_metadata(&p) {
            Ok(m) if is_reparse(&m) => return Err(link(&p)),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(format!("{}: {e}", p.display())),
        }
    }
    let target = join_rel(root, &rel);
    let mut tmp_name = target.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(TMP_SUFFIX);
    let tmp = target.with_file_name(tmp_name);
    if std::fs::symlink_metadata(&tmp).is_ok_and(|m| is_reparse(&m)) {
        return Err(link(&tmp));
    }
    let parent = target.parent().ok_or_else(|| format!("{rel}: no parent folder"))?;
    if create {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    match parent.canonicalize() {
        Ok(canon) if canon.starts_with(root_canon) => Ok(target),
        Ok(canon) => Err(format!("{rel}: resolves to {}, outside the game folder {}", canon.display(), root_canon.display())),
        Err(e) if !create && e.kind() == std::io::ErrorKind::NotFound => Ok(target),
        Err(e) => Err(format!("{}: {e}", parent.display())),
    }
}

/// [`confined`] for a read: computes the canonical game folder and creates nothing.
pub fn confined_read(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root_canon = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
    confined(root, &root_canon, rel, false)
}

/// Flushes a folder's entries to disk, so a file created, renamed or removed in it survives a
/// power cut. On Windows this opens the folder with `FILE_FLAG_BACKUP_SEMANTICS` and calls
/// `FlushFileBuffers` (what `sync_all` does). Returns `Ok(false)` when Windows refuses the
/// flush with access denied, which it can for folders the user may write files in but not
/// open for writing as a whole; the caller reports that rather than failing the change.
pub fn flush_dir(dir: &Path) -> Result<bool, String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        let opened = std::fs::OpenOptions::new().write(true).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(dir);
        let result = opened.and_then(|f| f.sync_all());
        match result {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
            Err(e) => Err(format!("flushing {}: {e}", dir.display())),
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::File::open(dir).and_then(|f| f.sync_all()).map(|_| true).map_err(|e| format!("flushing {}: {e}", dir.display()))
    }
}

/// Renames `src` to `dst` atomically, failing with `AlreadyExists` instead of replacing an
/// existing `dst`. On Windows this is `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`, which
/// works on FAT and exFAT drives too, unlike a hard link.
pub fn rename_no_replace(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
        let (s, d) = (wide(src), wide(dst));
        // SAFETY: both paths are NUL-terminated and outlive the call.
        if unsafe { MoveFileExW(s.as_ptr(), d.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::hard_link(src, dst)?;
        std::fs::remove_file(src)
    }
}

/// Expands `%NAME%` environment references, as Windows does in paths.
pub fn expand_env(raw: &str) -> Result<PathBuf, String> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%').ok_or_else(|| format!("{raw}: unmatched %"))?;
        let name = &after[..end];
        let value = std::env::var(name).map_err(|_| format!("{raw}: environment variable {name} is not set"))?;
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(PathBuf::from(out))
}

/// The folders between `dir` and its nearest existing ancestor that do not exist yet, deepest
/// first. After they are created, flushing the parent of each in this order puts the whole new
/// chain on disk from the bottom up.
pub fn missing_ancestors(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut cur = Some(dir);
    while let Some(d) = cur {
        if d.as_os_str().is_empty() || std::fs::symlink_metadata(d).is_ok() {
            break;
        }
        out.push(d.to_path_buf());
        cur = d.parent();
    }
    out
}

/// Lists every file under `dir` as a path relative to `root`, skipping runtime output. A
/// junction or symbolic link is never followed: its path goes to `links` instead, for the
/// caller to report.
pub fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>, links: &mut Vec<String>) -> Result<(), String> {
    let items = match std::fs::read_dir(dir) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    for item in items {
        let item = item.map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = item.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let rel_path = path
            .strip_prefix(root)
            .map_err(|_| format!("{}: outside {}", path.display(), root.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        if is_runtime_output(&rel_path) {
            continue;
        }
        if is_reparse(&meta) {
            links.push(rel_path);
        } else if meta.is_dir() {
            walk_files(root, &path, out, links)?;
        } else if meta.is_file() {
            out.push(rel_path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_that_leave_the_game_folder_are_rejected() {
        for bad in ["../gameinfo.gi", "cfg/../../x", "/abs", r"C:\x", "a//b", "cfg/x.cfg:ads", ""] {
            assert!(rel(bad).is_err(), "{bad}");
        }
        assert_eq!(rel(r"addons\metamod.vdf").unwrap(), "addons/metamod.vdf");
    }

    #[test]
    fn user_files_are_protected_whatever_their_case() {
        assert_eq!(protection("cfg/Gamemode_Competitive_Server.cfg"), Protection::MergeConvars);
        assert_eq!(protection("cfg/autoexec.cfg"), Protection::Keep);
        assert_eq!(protection("cfg/autoexec_practice.cfg"), Protection::Keep);
        assert_eq!(
            protection("addons/metamod/animation/graphs/viewmodel/viewmodel_knife.vnmgraph+skeleton.vnmgraph_c"),
            Protection::Keep
        );
        assert_eq!(protection("cfg/my_bot_normal_config.cfg"), Protection::None);
        assert_eq!(protection("addons/metamod/metaplugins.ini"), Protection::None);
    }
}
