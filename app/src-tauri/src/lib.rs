//! Two commands, both scoped to the match folder `%APPDATA%\BotMatchStats\matches`:
//! `list_matches` lists finished match files, `read_match` returns one file's gzip bytes.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![list_matches, read_match])
        .run(tauri::generate_context!())
        .expect("error while running CS2 Stats");
}
