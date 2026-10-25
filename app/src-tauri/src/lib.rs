//! Commands scoped to `%APPDATA%\BotMatchStats`: `list_matches` lists finished match files,
//! `read_match` returns one file's gzip bytes, `import_match` copies a picked file into
//! `matches\imported\`, and `read_pack` reads the optional packs folder (pro scores, agent art).
//! Decompression and every statistic run in the web view.

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
struct FileEntry {
    /// Path relative to the match folder, with forward slashes.
    file: String,
    size: u64,
    /// Modified time in ms since the Unix epoch.
    mtime: u64,
}

#[derive(Serialize)]
struct Listing {
    folder: String,
    files: Vec<FileEntry>,
}

fn match_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join("matches"))
}

fn entry(root: &Path, path: &Path) -> Option<FileEntry> {
    let name = path.file_name()?.to_str()?;
    if !name.ends_with(".json.gz") {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let rel = path.strip_prefix(root).ok()?.to_str()?.replace('\\', "/");
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some(FileEntry { file: rel, size: meta.len(), mtime })
}

/// Finished matches live in `matches\YYYY\`. The `inprogress` folder holds partial files and is skipped.
#[tauri::command]
async fn list_matches() -> Result<Listing, String> {
    let root = match_dir()?;
    let folder = root.display().to_string();
    let mut files = Vec::new();
    let Ok(top) = fs::read_dir(&root) else {
        return Ok(Listing { folder, files });
    };
    for item in top.flatten() {
        let path = item.path();
        if path.is_dir() {
            if item.file_name() == "inprogress" {
                continue;
            }
            if let Ok(inner) = fs::read_dir(&path) {
                files.extend(inner.flatten().filter_map(|f| entry(&root, &f.path())));
            }
        } else if let Some(e) = entry(&root, &path) {
            files.push(e);
        }
    }
    files.sort_by(|a, b| b.file.cmp(&a.file));
    Ok(Listing { folder, files })
}

/// Returns the raw gzip bytes of one match file. The path must be relative, end in `.json.gz`,
/// and resolve inside the match folder.
#[tauri::command]
async fn read_match(file: String) -> Result<tauri::ipc::Response, String> {
    let rel = Path::new(&file);
    if !file.ends_with(".json.gz") || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("{file}: not a match file path inside the match folder"));
    }
    let root = match_dir()?
        .canonicalize()
        .map_err(|e| format!("match folder unavailable: {e}"))?;
    let path = root
        .join(rel)
        .canonicalize()
        .map_err(|e| format!("{file}: {e}"))?;
    if !path.starts_with(&root) {
        return Err(format!("{file}: outside the match folder"));
    }
    let bytes = fs::read(&path).map_err(|e| format!("{file}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Largest file `import_match` accepts. The biggest recorded match so far is 74 KB; this leaves room
/// for long matches with full position data while refusing anything that is clearly not a match.
const IMPORT_MAX_BYTES: usize = 64 * 1024 * 1024;

/// Copies one match file into `matches\imported\`. The name must be a bare file name ending in
/// `.json.gz`, the bytes must start with the gzip magic number, and an existing file is never
/// overwritten. Returns the stored path relative to the match folder.
#[tauri::command]
async fn import_match(name: String, data: Vec<u8>) -> Result<String, String> {
    let file_name = Path::new(&name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| *n == name && n.ends_with(".json.gz") && !n.starts_with('.'))
        .ok_or_else(|| format!("{name}: not a .json.gz file name"))?;
    if data.len() < 2 || data[0] != 0x1f || data[1] != 0x8b {
        return Err(format!("{name}: not gzip data"));
    }
    if data.len() > IMPORT_MAX_BYTES {
        return Err(format!("{name}: larger than {} MB", IMPORT_MAX_BYTES / (1024 * 1024)));
    }
    let dir = match_dir()?.join("imported");
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let path = dir.join(file_name);
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => format!("{name}: already imported"),
            _ => format!("{name}: {e}"),
        })?;
    std::io::Write::write_all(&mut out, &data).map_err(|e| format!("{name}: {e}"))?;
    Ok(format!("imported/{file_name}"))
}

/// Returns a file from the optional packs folder `%APPDATA%\BotMatchStats\packs` (pro scores, agent
/// art), which stays out of the repository. The name must be relative, end in `.json` or `.png` and
/// resolve inside the folder. A missing file returns an empty response, which the UI reads as "no
/// pack".
#[tauri::command]
async fn read_pack(name: String) -> Result<tauri::ipc::Response, String> {
    let rel = Path::new(&name);
    let ok_ext = name.ends_with(".json") || name.ends_with(".png");
    if !ok_ext || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("{name}: not a pack file path"));
    }
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    let root = PathBuf::from(appdata).join("BotMatchStats").join("packs");
    let path = root.join(rel);
    if !path.is_file() {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }
    let (root, path) = (
        root.canonicalize().map_err(|e| format!("packs folder: {e}"))?,
        path.canonicalize().map_err(|e| format!("{name}: {e}"))?,
    );
    if !path.starts_with(&root) {
        return Err(format!("{name}: outside the packs folder"));
    }
    fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| format!("{name}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_matches, read_match, import_match, read_pack])
        .run(tauri::generate_context!())
        .expect("error while running CS2 Stats");
}
