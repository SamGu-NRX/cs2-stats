//! Commands scoped to `%APPDATA%\BotMatchStats`: `list_matches` lists finished match files,
//! `read_match` returns one file's gzip bytes, `import_match` copies a picked file into
//! `matches\imported\`, and `read_pack` reads the optional packs folder (pro scores, agent art).
//! `list_valve` and `read_valve` serve the user's imported Valve matches from `valve\`, and
//! `import_valve` runs the importer that writes them.
//! Decompression and every statistic run in the web view. The Bot Mode installer and
//! launcher is in `botmode`; the optional Leetify import is in `leetify`. `open_external` opens the app's
//! outside links in the system browser.

pub mod botmode;
mod leetify;

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
    let files = list_files(&root)?;
    Ok(Listing { folder: root.display().to_string(), files })
}

/// A missing match folder means nothing has been recorded yet and lists no files. Any other
/// failure to read a folder is an error naming the folder and the cause, so the app reports it
/// instead of showing an empty list.
fn list_files(root: &Path) -> Result<Vec<FileEntry>, String> {
    let fail = |dir: &Path, e: std::io::Error| format!("{}: {e}", dir.display());
    let top = match fs::read_dir(root) {
        Ok(top) => top,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(fail(root, e)),
    };
    let mut files = Vec::new();
    for item in top {
        let item = item.map_err(|e| fail(root, e))?;
        let path = item.path();
        if path.is_dir() {
            if item.file_name() == "inprogress" {
                continue;
            }
            for f in fs::read_dir(&path).map_err(|e| fail(&path, e))? {
                let f = f.map_err(|e| fail(&path, e))?;
                files.extend(entry(root, &f.path()));
            }
        } else if let Some(e) = entry(root, &path) {
            files.push(e);
        }
    }
    files.sort_by(|a, b| b.file.cmp(&a.file));
    Ok(files)
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
/// art, the CS2 icon pack), which stays out of the repository. The name must be relative, end in
/// `.json`, `.png` or `.svg` and
/// resolve inside the folder. A missing file returns an empty response, which the UI reads as "no
/// pack".
#[tauri::command]
async fn read_pack(name: String) -> Result<tauri::ipc::Response, String> {
    // the name first, so a bad one says so whatever the environment
    check_pack_name(&name)?;
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    let root = PathBuf::from(appdata).join("BotMatchStats").join("packs");
    read_pack_in(&root, &name).map(tauri::ipc::Response::new)
}

/// A pack file name: relative, plain path segments only, ending in .json, .png or .svg.
fn check_pack_name(name: &str) -> Result<(), String> {
    let ok_ext = name.ends_with(".json") || name.ends_with(".png") || name.ends_with(".svg");
    if !ok_ext || Path::new(name).components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("{name}: not a pack file path"));
    }
    Ok(())
}

/// One file from the packs folder `root`: empty when it does not exist, an error when the name is not
/// a pack file path or the file resolves outside the folder (links and junctions included).
fn read_pack_in(root: &Path, name: &str) -> Result<Vec<u8>, String> {
    check_pack_name(name)?;
    let path = root.join(name);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let (root, path) = (
        root.canonicalize().map_err(|e| format!("packs folder: {e}"))?,
        path.canonicalize().map_err(|e| format!("{name}: {e}"))?,
    );
    if !path.starts_with(&root) {
        return Err(format!("{name}: outside the packs folder"));
    }
    // The file can change between these checks and the read (a time-of-check race). That is
    // accepted: swapping it needs a process already running as the user with write access to the packs
    // folder, which can read anything this route could reach, so no privilege boundary is crossed.
    fs::read(&path).map_err(|e| format!("{name}: {e}"))
}

// ---------------------------------------------------------------- the user's Valve matches
//
// %APPDATA%\BotMatchStats\valve (CS2_VALVE_MATCHES overrides it) holds extractor/valve_import.py's output:
// one map folder per demo in the extractor's versioned layout, and valve-user.local.json with the user's
// SteamID64. app/tools/valve-folder.ts implements the same rules for the dev server. A match is listed
// as "valve/<demo>/<version folder>", so one match's tables never mix two extractions.

const VALVE_USER_FILE: &str = "valve-user.local.json";
/// SteamID64 of account 0 in the public universe; every real SteamID64 is above it.
const STEAMID64_MIN: u64 = 76561197960265728;

/// A path from the environment made absolute against the current folder: the importer runs in the
/// extractor folder, so a relative --out or script path would mean something else there (review of #29).
fn absolute(p: PathBuf) -> Result<PathBuf, String> {
    std::path::absolute(&p).map_err(|e| format!("{}: {e}", p.display()))
}

/// An environment variable naming a path, made absolute; None when unset.
fn env_path(name: &str) -> Result<Option<PathBuf>, String> {
    std::env::var_os(name).map(|v| absolute(PathBuf::from(v))).transpose()
}

fn valve_dir() -> Result<PathBuf, String> {
    if let Some(d) = env_path("CS2_VALVE_MATCHES")? {
        return Ok(d);
    }
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join("valve"))
}

/// A demo or version folder name: letters, digits, '_', '.', '-' only.
fn plain_name(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// v-<version>-<8 hex>, the extractor's version folder name.
fn version_dir(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("v-") else { return false };
    let Some((ver, hex)) = rest.rsplit_once('-') else { return false };
    !ver.is_empty()
        && ver.chars().all(|c| c.is_ascii_alphanumeric() || "._+".contains(c))
        && hex.len() == 8
        && hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// The user's SteamID64 from valve-user.local.json; None when the file is absent.
fn valve_user(root: &Path) -> Result<Option<String>, String> {
    let f = root.join(VALVE_USER_FILE);
    let text = match fs::read_to_string(&f) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", f.display())),
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", f.display()))?;
    match v.get("steamid").and_then(|s| s.as_u64()) {
        Some(id) if id > STEAMID64_MIN => Ok(Some(id.to_string())),
        _ => Err(format!("{} names no SteamID64 (\"steamid\": <integer>)", f.display())),
    }
}

/// Whether `p`, with every junction and symbolic link resolved, lies inside `root`'s own resolved path. A
/// version folder or table that is a link to elsewhere is refused (review of #29: a junction read outside).
///
/// A link swapped between this check and the open that follows is not defended against, and does not
/// need to be: the Valve folder is in the user's own %APPDATA%, so anything that can swap a link there
/// already runs as the user and can read the files directly. The checks keep the folder's own contents, a
/// stray junction or a crafted COMPLETE list, from pointing the app elsewhere. The launcher works under the
/// same threat model.
fn inside(root: &Path, p: &Path) -> bool {
    match (root.canonicalize(), p.canonicalize()) {
        (Ok(r), Ok(q)) => q != r && q.starts_with(&r),
        _ => false,
    }
}

/// A plain table file name: lowercase letters, digits and '_', then ".parquet". Nothing that can name a
/// folder or step out of one.
fn table_name(t: &str) -> bool {
    t.len() > 8 && t.ends_with(".parquet") && t[..t.len() - 8].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The version folder's COMPLETE list (file name to bytes), when it lies inside `root`, every name it lists
/// is a plain table name, and every table resolves inside `root` at its listed size. Each check comes
/// before the open it guards, so nothing outside `root` is read.
fn complete_tables(root: &Path, dir: &Path) -> Result<std::collections::BTreeMap<String, u64>, String> {
    let complete = dir.join("COMPLETE");
    if !complete.exists() {
        return Err("no COMPLETE file yet".into());
    }
    if !inside(root, &complete) {
        return Err("its version folder resolves outside the Valve folder".into());
    }
    let text = fs::read_to_string(&complete).map_err(|e| format!("COMPLETE: {e}"))?;
    let sizes: std::collections::BTreeMap<String, u64> =
        serde_json::from_str(&text).map_err(|e| format!("COMPLETE: {e}"))?;
    for (f, n) in &sizes {
        if !table_name(f) {
            return Err(format!("COMPLETE lists \"{f}\", which is not a table file name"));
        }
        let p = dir.join(f);
        if !p.exists() {
            return Err(format!("{f} is missing"));
        }
        if !inside(root, &p) {
            return Err(format!("{f} resolves outside the Valve folder"));
        }
        if fs::metadata(&p).map(|m| m.len()).ok() != Some(*n) {
            return Err(format!("{f} is not at its listed {n} bytes"));
        }
    }
    Ok(sizes)
}

#[derive(Serialize)]
struct Skipped {
    file: String,
    why: String,
}

#[derive(Serialize)]
struct ValveListing {
    folder: String,
    user: Option<String>,
    /// Why valve-user.local.json could not be read; the matches are still listed, without a user.
    #[serde(rename = "userError")]
    user_error: Option<String>,
    files: Vec<FileEntry>,
    skipped: Vec<Skipped>,
}

/// Every Valve match whose CURRENT version is complete, newest folder name first; folders without one are
/// listed in `skipped` with the reason. A missing folder lists nothing.
fn list_valve_in(root: &Path) -> Result<ValveListing, String> {
    let mut out = ValveListing { folder: root.display().to_string(), user: None, user_error: None, files: Vec::new(), skipped: Vec::new() };
    let top = match fs::read_dir(root) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("{}: {e}", root.display())),
    };
    // Read a second time 50 ms after a failure, as something else may be writing the file. Still unreadable,
    // it is reported rather than returned as an error, so one bad file does not hide every match.
    match valve_user(root).or_else(|_| {
        std::thread::sleep(std::time::Duration::from_millis(50));
        valve_user(root)
    }) {
        Ok(u) => out.user = u,
        Err(e) => out.user_error = Some(e),
    }
    for item in top {
        let item = item.map_err(|e| format!("{}: {e}", root.display()))?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else { continue };
        let map = item.path();
        if !map.is_dir() || !plain_name(&name) || !map.join("CURRENT").exists() {
            continue;
        }
        let skip = |why: String| Skipped { file: format!("valve/{name}"), why };
        if map.join("RETIRED").exists() {
            out.skipped.push(skip("retired".into()));
            continue;
        }
        if !inside(root, &map.join("CURRENT")) {
            out.skipped.push(skip("CURRENT resolves outside the Valve folder".into()));
            continue;
        }
        let current = fs::read_to_string(map.join("CURRENT")).unwrap_or_default().trim().to_string();
        if !version_dir(&current) {
            out.skipped.push(skip(format!("CURRENT names \"{current}\", which is not a version folder")));
            continue;
        }
        let dir = map.join(&current);
        match complete_tables(root, &dir) {
            Ok(sizes) => {
                let mtime = fs::metadata(dir.join("COMPLETE"))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                out.files.push(FileEntry { file: format!("valve/{name}/{current}"), size: sizes.values().sum(), mtime });
            }
            Err(why) => out.skipped.push(skip(format!("{current}: {why}"))),
        }
    }
    out.files.sort_by(|a, b| b.file.cmp(&a.file));
    Ok(out)
}

#[tauri::command]
async fn list_valve() -> Result<ValveListing, String> {
    list_valve_in(&valve_dir()?)
}

/// "<demo>/<version>" returns the version's table file names as JSON; "<demo>/<version>/<table>.parquet"
/// returns that table, only if the version's COMPLETE list names it at its size.
fn read_valve_in(root: &Path, path: &str) -> Result<Vec<u8>, String> {
    let parts: Vec<&str> = path.split('/').collect();
    let ok = matches!(parts.len(), 2 | 3) && plain_name(parts[0]) && version_dir(parts[1]) && parts.get(2).is_none_or(|t| table_name(t));
    if !ok {
        return Err(format!("{path}: not a Valve match path (<demo>/<version folder>[/<table>.parquet])"));
    }
    let dir = root.join(parts[0]).join(parts[1]);
    let outside = || format!("{path}: resolves outside the Valve folder");
    if !dir.join("COMPLETE").exists() {
        return Err(format!("{path}: this version is gone; rescan"));
    }
    if !inside(root, &dir.join("COMPLETE")) {
        return Err(outside());
    }
    let text = fs::read_to_string(dir.join("COMPLETE")).map_err(|_| format!("{path}: this version is gone; rescan"))?;
    let sizes: std::collections::BTreeMap<String, u64> = serde_json::from_str(&text).map_err(|e| format!("{path}: COMPLETE: {e}"))?;
    if let Some(bad) = sizes.keys().find(|f| !table_name(f)) {
        return Err(format!("{path}: COMPLETE lists \"{bad}\", which is not a table file name"));
    }
    let Some(table) = parts.get(2) else {
        let names: Vec<&String> = sizes.keys().collect();
        return serde_json::to_vec(&names).map_err(|e| e.to_string());
    };
    let want = *sizes.get(*table).ok_or_else(|| format!("{path}: not one of this version's tables"))?;
    if !inside(root, &dir.join(table)) {
        return Err(outside());
    }
    let bytes = fs::read(dir.join(table)).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() as u64 != want {
        return Err(format!("{path}: {} bytes, not the {want} COMPLETE lists; rescan", bytes.len()));
    }
    Ok(bytes)
}

#[tauri::command]
async fn read_valve(path: String) -> Result<tauri::ipc::Response, String> {
    read_valve_in(&valve_dir()?, &path).map(tauri::ipc::Response::new)
}

#[derive(Serialize, Clone)]
struct ValveImport {
    code: Option<i32>,
    summary: Option<serde_json::Value>,
    error: Option<String>,
}

/// The importer's state, for `valve_import_state`: a page that did not start the running import (one
/// opened or reloaded since) shows it from this.
#[derive(Serialize, Clone, Default)]
struct ImportState {
    running: bool,
    /// the running (or last) import's latest progress line
    at: Option<serde_json::Value>,
    /// the last import's end
    last: Option<ValveImport>,
}

/// Admits one import at a time (review of #29: a second press started a second importer over the same
/// folder) and keeps its state.
struct ImportGate(std::sync::Mutex<ImportState>);

impl ImportGate {
    const fn new() -> Self {
        ImportGate(std::sync::Mutex::new(ImportState { running: false, at: None, last: None }))
    }
    fn state(&self) -> std::sync::MutexGuard<'_, ImportState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Marks an import as running; refuses while one is.
    fn begin(&self) -> Result<(), String> {
        let mut s = self.state();
        if s.running {
            return Err("an import is already running".into());
        }
        s.running = true;
        s.at = None;
        Ok(())
    }
    fn progress(&self, ev: serde_json::Value) {
        self.state().at = Some(ev);
    }
    /// Ends the running import with `last` (None when it could not report one).
    fn end(&self, last: Option<ValveImport>) {
        let mut s = self.state();
        s.running = false;
        if last.is_some() {
            s.last = last;
        }
    }
}

static IMPORT: ImportGate = ImportGate::new();

#[tauri::command]
fn valve_import_state() -> ImportState {
    IMPORT.state().clone()
}

/// Runs extractor/valve_import.py over the CS2 replays folder into the Valve folder. Until the extractor is
/// packaged as a sidecar binary, it runs from CS2_EXTRACTOR_DIR (the extractor folder) with that folder's
/// .venv Python (CS2_EXTRACTOR_PYTHON overrides); CS2_MAPDATA, when set, adds mesh visibility. Each JSON line
/// the importer writes to stderr is sent as a "valve-import-progress" event.
#[tauri::command]
async fn import_valve(app: tauri::AppHandle) -> Result<ValveImport, String> {
    use std::io::BufRead;
    use tauri::Emitter;
    let dir = env_path("CS2_EXTRACTOR_DIR")?
        .ok_or("The importer is not installed: set CS2_EXTRACTOR_DIR to the extractor folder (extractor/README.md)")?;
    let script = dir.join("valve_import.py");
    if !script.is_file() {
        return Err(format!("no importer at {}", script.display()));
    }
    let python = env_path("CS2_EXTRACTOR_PYTHON")?
        .unwrap_or_else(|| dir.join(".venv").join(if cfg!(windows) { "Scripts\\python.exe" } else { "bin/python" }));
    let mapdata = env_path("CS2_MAPDATA")?;
    if !python.is_file() {
        return Err(format!("no Python at {}; create the extractor's .venv or set CS2_EXTRACTOR_PYTHON", python.display()));
    }
    let out = valve_dir()?;
    IMPORT.begin()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&python);
        cmd.arg("-I").arg(&script).arg("--progress").arg("--out").arg(&out).current_dir(&dir);
        if let Some(m) = &mapdata {
            cmd.arg("--mapdata").arg(m);
        }
        let mut child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("{}: {e}", python.display()))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let reader = std::thread::spawn(move || std::io::read_to_string(stdout).unwrap_or_default());
        let mut tail = String::new();
        for line in std::io::BufReader::new(child.stderr.take().expect("piped stderr")).lines() {
            let line = line.map_err(|e| e.to_string())?;
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(ev) if ev.get("event").is_some() => {
                    IMPORT.progress(ev.clone());
                    let _ = app.emit("valve-import-progress", ev);
                }
                _ if !line.trim().is_empty() => {
                    tail.push_str(&line);
                    tail.push('\n');
                }
                _ => {}
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let summary = serde_json::from_str(&reader.join().unwrap_or_default()).ok();
        let code = status.code();
        // the last 2000 characters of what the importer wrote besides progress, for a failed run
        let tail: Vec<char> = tail.trim().chars().collect();
        let error = (code != Some(0) && !tail.is_empty()).then(|| tail[tail.len().saturating_sub(2000)..].iter().collect());
        Ok(ValveImport { code, summary, error })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    IMPORT.end(result.as_ref().ok().cloned());
    result
}

// ---------------------------------------------------------------- outside links
//
// The web view opens no window for a target="_blank" link: with no new-window handler set (this app sets
// none), wry marks WebView2's NewWindowRequested event handled and does nothing (wry 0.55
// src/webview2/mod.rs, the `else { args.SetHandled(true) }` branch). So every outside link in the page
// calls `open_external` (app/src/host/external.ts), which hands the URL to the system's default browser
// with ShellExecuteW, the shell's own "open" verb. No other program starts: the `open` crate, which this
// replaced, runs powershell.exe to do the same on Windows (review of #52).

/// The hosts the app links to: Leetify's pages (views/leetify) and HLTV's player pages (the Plays like banner).
const OUTSIDE_HOSTS: [&str; 3] = ["leetify.com", "www.leetify.com", "www.hltv.org"];

/// The URL when the page may open it: https, no user name, password or port, and a host in OUTSIDE_HOSTS.
/// Anything else is refused, so the page cannot use this to start a program or open a file.
fn outside_url(url: &str) -> Result<tauri::Url, String> {
    let u = tauri::Url::parse(url).map_err(|e| format!("{url}: not a URL ({e})"))?;
    let host_ok = u.host_str().is_some_and(|h| OUTSIDE_HOSTS.contains(&h));
    if u.scheme() != "https" || !host_ok || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return Err(format!("{url}: not a page this app links to"));
    }
    Ok(u)
}

/// What `open_external` asks the shell for: ShellExecuteW's verb, file and show command, and its return.
/// A seam, so a test can stand in for the shell and see exactly what would be launched.
type ShellLaunch = fn(verb: &str, file: &str, show: i32) -> isize;

/// The show command ShellExecuteW gets: a normal window.
#[cfg(windows)]
const SHOW_NORMAL: i32 = windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
#[cfg(not(windows))]
const SHOW_NORMAL: i32 = 1;

/// Opens an outside link in the system's default browser; an error says why it did not open.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    open_with(&url, shell_execute)
}

/// The URL through outside_url, then to the shell as one file argument with the "open" verb; nothing is
/// launched for a refused URL, and a failed launch says why.
fn open_with(url: &str, launch: ShellLaunch) -> Result<(), String> {
    let u = outside_url(url)?;
    shell_result(launch("open", u.as_str(), SHOW_NORMAL)).map_err(|e| format!("could not open the browser: {e}"))
}

/// What ShellExecuteW's return means: above 32 it opened, at or below 32 an error code.
fn shell_result(code: isize) -> Result<(), String> {
    match code {
        c if c > 32 => Ok(()),
        0 | 8 => Err("Windows is out of memory or resources".into()),
        2 | 3 => Err("Windows found no program for the link".into()),
        5 => Err("Windows denied access to the browser".into()),
        31 => Err("Windows has no browser set for web links (SE_ERR_NOASSOC)".into()),
        c => Err(format!("ShellExecuteW returned {c}")),
    }
}

#[cfg(windows)]
fn shell_execute(verb: &str, file: &str, show: i32) -> isize {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide(verb), wide(file));
    // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call; the window, parameters and
    // folder are null, which ShellExecuteW accepts
    unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), show) as isize }
}

/// Elsewhere nothing is launched: ERROR_FILE_NOT_FOUND, which shell_result reports.
#[cfg(not(windows))]
fn shell_execute(_: &str, _: &str, _: i32) -> isize {
    2
}

/// Turns off WebView2's status bar in every window. Like a browser, WebView2 shows a link's target in
/// a bubble at the lower left while the pointer is over it. A desktop app has no use for that, and a
/// match link names the match's file, which the user may have named after a person; with "Hide
/// personal info" on, the page hides it (src/ui/data/privacy.ts), and the bubble must not show it.
/// It runs from the page load hook, so it reaches every webview, and again on each navigation, which
/// changes nothing.
#[cfg(windows)]
fn hide_status_bar(webview: &tauri::Webview) {
    let label = webview.label().to_string();
    let done = webview.with_webview(|webview| {
        // SAFETY: COM calls on the webview's own WebView2 controller, which with_webview runs on the
        // thread that owns it
        let result = unsafe { webview.controller().CoreWebView2().and_then(|core| core.Settings()).and_then(|settings| settings.SetIsStatusBarEnabled(false)) };
        if let Err(e) = result {
            eprintln!("could not turn off the WebView2 status bar: {e}");
        }
    });
    if let Err(e) = done {
        eprintln!("could not reach webview {label}: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Bot Mode left on by a session that lost its supervisor is dealt with at once.
        .setup(|_app| {
            botmode::commands::on_app_start();
            Ok(())
        })
        // every webview, the first window's and any opened later, as its page starts loading
        .on_page_load(|webview, payload| {
            #[cfg(windows)]
            {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    hide_status_bar(webview);
                }
            }
            #[cfg(not(windows))]
            let _ = (webview, payload);
        })
        .invoke_handler(tauri::generate_handler![
            list_matches,
            read_match,
            import_match,
            read_pack,
            list_valve,
            read_valve,
            import_valve,
            valve_import_state,
            open_external,
            leetify::leetify_status,
            leetify::leetify_save_key,
            leetify::leetify_clear_key,
            leetify::leetify_connect,
            leetify::leetify_disconnect,
            leetify::leetify_discard,
            leetify::leetify_badge,
            leetify::leetify_load,
            botmode::commands::botmode_status,
            botmode::commands::botmode_releases,
            botmode::commands::botmode_download,
            botmode::commands::botmode_install,
            botmode::commands::botmode_overlay,
            botmode::commands::botmode_rollback,
            botmode::commands::botmode_backups,
            botmode::commands::botmode_launch,
            botmode::commands::botmode_session,
            botmode::commands::botmode_set_difficulty,
            botmode::commands::botmode_set_cosmetics,
            botmode::commands::botmode_set_launch_options,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CS2 Stats");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp folder, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cs2stats-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn read_pack_reads_inside_the_packs_folder_only() {
        // fails if a pack name with `..`, an absolute path or another type can read outside the folder
        let s = Scratch::new("packs");
        let root = s.0.join("packs");
        fs::create_dir_all(root.join("icons")).unwrap();
        fs::write(root.join("pros.json"), b"{}").unwrap();
        fs::write(root.join("icons").join("ak47.svg"), b"<svg/>").unwrap();
        fs::write(s.0.join("secret.json"), b"{\"secret\":1}").unwrap();
        assert_eq!(read_pack_in(&root, "pros.json").unwrap(), b"{}");
        assert_eq!(read_pack_in(&root, "icons/ak47.svg").unwrap(), b"<svg/>");
        assert!(read_pack_in(&root, "missing.json").unwrap().is_empty());
        let outside = s.0.join("secret.json").display().to_string();
        for bad in ["../secret.json", "icons/../../secret.json", outside.as_str(), "pros.txt", "./pros.json"] {
            let err = read_pack_in(&root, bad).expect_err(bad);
            assert!(err.contains("not a pack file path"), "{bad}: {err}");
            // the command checks the name before it reads APPDATA, so a bad name gets the same answer
            match tauri::async_runtime::block_on(read_pack(bad.to_string())) {
                Err(e) => assert!(e.contains("not a pack file path"), "{bad}: {e}"),
                Ok(_) => panic!("{bad}: read_pack accepted it"),
            }
        }
    }

    #[test]
    fn an_unreadable_match_folder_is_an_error_naming_it() {
        // A file where the folder should be: read_dir fails with something other than NotFound.
        let s = Scratch::new("unreadable");
        let root = s.0.join("matches");
        fs::write(&root, b"not a folder").unwrap();
        let err = list_files(&root).err().expect("an error, not an empty list");
        assert!(err.starts_with(&root.display().to_string()), "{err}");
    }

    /// A Valve map folder: CURRENT naming `version`, and the version's tables with a COMPLETE list.
    /// `listed` overrides the byte counts COMPLETE gives.
    fn valve_map(root: &Path, demo: &str, version: &str, tables: &[(&str, &[u8])], listed: Option<u64>) {
        let dir = root.join(demo).join(version);
        fs::create_dir_all(&dir).unwrap();
        fs::write(root.join(demo).join("CURRENT"), format!("{version}\n")).unwrap();
        let mut sizes = serde_json::Map::new();
        for (name, body) in tables {
            fs::write(dir.join(name), body).unwrap();
            sizes.insert(name.to_string(), listed.unwrap_or(body.len() as u64).into());
        }
        fs::write(dir.join("COMPLETE"), serde_json::Value::Object(sizes).to_string()).unwrap();
    }

    const V1: &str = "v-1.13.0-0a1b2c3d";

    #[test]
    fn lists_complete_valve_matches_by_version_and_skips_the_rest() {
        // fails if a half-written or retired version is listed, or a listed path does not name its version
        let s = Scratch::new("valve-list");
        valve_map(&s.0, "match730_a", V1, &[("match.parquet", b"abc")], None);
        valve_map(&s.0, "match730_b", V1, &[("match.parquet", b"abc")], Some(9));
        valve_map(&s.0, "match730_c", V1, &[("match.parquet", b"abc")], None);
        fs::write(s.0.join("match730_c").join("RETIRED"), "replaced\n").unwrap();
        fs::write(s.0.join(VALVE_USER_FILE), "{\"steamid\": 76561197960265729, \"source\": \"--user\"}").unwrap();
        let l = list_valve_in(&s.0).unwrap();
        let files: Vec<(String, u64)> = l.files.into_iter().map(|f| (f.file, f.size)).collect();
        assert_eq!(files, [(format!("valve/match730_a/{V1}"), 3)]);
        let skipped: Vec<&str> = l.skipped.iter().map(|x| x.file.as_str()).collect();
        assert_eq!(skipped.len(), 2, "{skipped:?}");
        // a SteamID64 above 2^53 must come back exact
        assert_eq!(l.user.as_deref(), Some("76561197960265729"));
    }

    /// A directory link: a junction on Windows (no admin rights needed), a symbolic link elsewhere.
    fn dir_link(target: &Path, link: &Path) {
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap()
            .status
            .success());
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn a_version_folder_that_links_outside_is_neither_listed_nor_read() {
        // fails if a junction under the Valve folder serves files from elsewhere (review of #29)
        let s = Scratch::new("valve-link");
        let root = s.0.join("valve");
        valve_map(&s.0.join("elsewhere"), "m", V1, &[("match.parquet", b"secret")], None);
        fs::create_dir_all(root.join("match730_j")).unwrap();
        fs::write(root.join("match730_j").join("CURRENT"), format!("{V1}\n")).unwrap();
        dir_link(&s.0.join("elsewhere").join("m").join(V1), &root.join("match730_j").join(V1));
        let l = list_valve_in(&root).unwrap();
        assert!(l.files.is_empty() && l.skipped.len() == 1, "{:?}", l.skipped.iter().map(|x| &x.why).collect::<Vec<_>>());
        for p in [format!("match730_j/{V1}"), format!("match730_j/{V1}/match.parquet")] {
            let err = read_valve_in(&root, &p).unwrap_err();
            assert!(err.contains("outside the Valve folder"), "{err}");
        }
    }

    #[test]
    fn a_complete_list_naming_a_file_outside_keeps_its_match_from_being_listed_or_read() {
        // fails if a crafted COMPLETE points the listing or a read at a file beside the folder (review of #29)
        let s = Scratch::new("valve-escape");
        let root = s.0.join("valve");
        valve_map(&root, "match730_e", V1, &[("match.parquet", b"abc")], None);
        fs::write(s.0.join("stolen.parquet"), b"abc").unwrap();
        let complete = root.join("match730_e").join(V1).join("COMPLETE");
        fs::write(&complete, "{\"match.parquet\": 3, \"../../../stolen.parquet\": 3}").unwrap();
        let l = list_valve_in(&root).unwrap();
        assert!(l.files.is_empty());
        assert!(l.skipped[0].why.contains("not a table file name"), "{}", l.skipped[0].why);
        assert!(read_valve_in(&root, &format!("match730_e/{V1}")).is_err());
    }

    #[test]
    fn a_malformed_complete_list_skips_only_its_own_match() {
        // fails if one COMPLETE holding valid JSON that is not a name-to-size object hides every match
        // (review of #29: the dev host failed this way; the desktop host must not)
        let s = Scratch::new("valve-malformed");
        valve_map(&s.0, "match730_good", V1, &[("match.parquet", b"abc")], None);
        for (demo, body) in [("match730_null", "null"), ("match730_list", "[1]"), ("match730_size", "{\"match.parquet\": \"3\"}")] {
            valve_map(&s.0, demo, V1, &[("match.parquet", b"abc")], None);
            fs::write(s.0.join(demo).join(V1).join("COMPLETE"), body).unwrap();
        }
        let l = list_valve_in(&s.0).unwrap();
        let files: Vec<String> = l.files.into_iter().map(|f| f.file).collect();
        assert_eq!(files, [format!("valve/match730_good/{V1}")]);
        assert_eq!(l.skipped.len(), 3);
        assert!(read_valve_in(&s.0, &format!("match730_null/{V1}")).is_err());
    }

    #[test]
    fn an_unreadable_valve_user_file_is_reported_and_the_matches_still_listed() {
        // fails if a half-written or broken user file hides every match (review of #29)
        let s = Scratch::new("valve-user");
        valve_map(&s.0, "match730_a", V1, &[("match.parquet", b"abc")], None);
        for body in ["{\"steamid\": 12345}", "{\"steam"] {
            fs::write(s.0.join(VALVE_USER_FILE), body).unwrap();
            let l = list_valve_in(&s.0).unwrap();
            assert_eq!((l.user, l.files.len()), (None, 1));
            assert!(l.user_error.is_some());
        }
    }

    #[test]
    fn reads_only_the_tables_a_valve_version_lists_at_their_size() {
        // fails if a path escapes the folder, or a table rewritten since COMPLETE was written is returned
        let s = Scratch::new("valve-read");
        valve_map(&s.0, "match730_a", V1, &[("match.parquet", b"abc"), ("kills.parquet", b"k")], None);
        let names: Vec<String> = serde_json::from_slice(&read_valve_in(&s.0, &format!("match730_a/{V1}")).unwrap()).unwrap();
        assert_eq!(names, ["kills.parquet", "match.parquet"]);
        assert_eq!(read_valve_in(&s.0, &format!("match730_a/{V1}/match.parquet")).unwrap(), b"abc");
        for bad in [format!("../x/{V1}"), format!("match730_a/{V1}/../../x.parquet"), "match730_a/CURRENT".into(), format!("match730_a/{V1}/COMPLETE")] {
            assert!(read_valve_in(&s.0, &bad).is_err(), "{bad}");
        }
        assert!(read_valve_in(&s.0, &format!("match730_a/{V1}/rounds.parquet")).is_err());
        fs::write(s.0.join("match730_a").join(V1).join("match.parquet"), b"abcd").unwrap();
        assert!(read_valve_in(&s.0, &format!("match730_a/{V1}/match.parquet")).is_err());
    }

    #[test]
    fn a_relative_path_from_the_environment_is_made_absolute_against_the_current_folder() {
        // fails if a relative CS2_VALVE_MATCHES or CS2_EXTRACTOR_DIR reaches the importer, which runs in
        // another folder and would read and write somewhere else (review of #29)
        std::env::set_var("CS2_TEST_RELATIVE_PATH", PathBuf::from("data").join("valve"));
        let p = env_path("CS2_TEST_RELATIVE_PATH").unwrap().unwrap();
        assert_eq!(p, std::env::current_dir().unwrap().join("data").join("valve"));
        assert!(env_path("CS2_TEST_UNSET_PATH").unwrap().is_none());
    }

    #[test]
    fn admits_one_import_at_a_time_and_keeps_its_state_for_a_later_page() {
        // fails if a second press starts a second importer over the same folder (review of #29), or a page
        // opened during an import cannot see it
        let gate = ImportGate::new();
        gate.begin().unwrap();
        assert!(gate.begin().is_err());
        gate.progress(serde_json::json!({"event": "start", "i": 2, "n": 6}));
        let seen = gate.state().clone();
        assert!(seen.running && seen.at.as_ref().unwrap()["i"] == 2);
        gate.end(Some(ValveImport { code: Some(0), summary: None, error: None }));
        let done = gate.state().clone();
        assert!(!done.running && done.last.unwrap().code == Some(0));
        gate.begin().unwrap();
        assert!(gate.state().at.is_none());
    }

    #[test]
    fn opens_only_https_pages_on_the_hosts_the_app_links_to() {
        // fails if the page can open a file, a program, another site, or a look-alike host through open_external
        for ok in ["https://leetify.com/app/profile/76561197960265729", "https://leetify.com/", "https://www.hltv.org/player/1/x", "https://leetify.com/app/match-details/a-b/overview?x=1#y"] {
            assert!(outside_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://leetify.com/", "https://evil.example/", "https://leetify.com.evil.example/", "https://leetify.com@evil.example/",
            "https://user@leetify.com/", "https://leetify.com:8443/", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)",
            "ms-settings:privacy", "leetify.com", "", "https://hltv.org/",
        ] {
            assert!(outside_url(bad).is_err(), "{bad}");
        }
    }

    // what the stand-in shell was asked for, per test thread
    thread_local! {
        static SHELL_CALLS: std::cell::RefCell<Vec<(String, String, i32)>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    fn shell_ok(verb: &str, file: &str, show: i32) -> isize {
        SHELL_CALLS.with(|c| c.borrow_mut().push((verb.into(), file.into(), show)));
        42
    }
    fn shell_no_browser(verb: &str, file: &str, show: i32) -> isize {
        shell_ok(verb, file, show);
        31
    }

    #[test]
    fn open_external_asks_the_shell_to_open_exactly_the_allowed_url() {
        // fails if a refused URL reaches the shell, the shell gets another verb, a changed URL or another
        // show command, or a failed ShellExecuteW reads as success (review of #52)
        let url = "https://leetify.com/app/match-details/5e7a1c00-0000-4000-8000-000000000001/overview?x=1&y=a%20b";
        open_with(url, shell_ok).unwrap();
        assert!(open_with("file:///C:/Windows/System32/calc.exe", shell_ok).is_err());
        assert!(open_with("https://evil.example/", shell_ok).is_err());
        let calls = SHELL_CALLS.with(|c| c.take());
        assert_eq!(calls, [("open".to_string(), url.to_string(), SHOW_NORMAL)]);
        #[cfg(windows)]
        assert_eq!(SHOW_NORMAL, 1, "SW_SHOWNORMAL");
        let e = open_with("https://www.hltv.org/player/1/x", shell_no_browser).unwrap_err();
        assert!(e.contains("no browser set"), "{e}");
        SHELL_CALLS.with(|c| c.take());
        assert!(shell_result(42).is_ok());
        for code in [0, 2, 5, 31, 32] {
            assert!(shell_result(code).is_err(), "{code}");
        }
        assert!(shell_result(31).unwrap_err().contains("no browser set"));
    }

    #[test]
    fn a_missing_match_folder_lists_nothing() {
        let s = Scratch::new("missing");
        assert!(list_files(&s.0.join("matches")).unwrap().is_empty());
    }

    #[test]
    fn lists_finished_matches_newest_first_and_skips_inprogress() {
        let s = Scratch::new("listing");
        for f in ["2026/a.json.gz", "2026/b.json.gz", "inprogress/c.json.gz", "2026/notes.txt"] {
            let p = s.0.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"x").unwrap();
        }
        let files: Vec<String> = list_files(&s.0).unwrap().into_iter().map(|f| f.file).collect();
        assert_eq!(files, ["2026/b.json.gz", "2026/a.json.gz"]);
    }
}
