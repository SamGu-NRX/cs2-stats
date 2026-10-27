//! The pro match library: a folder of extracted pro demos the user picks in Data & settings, laid out as
//! the extractor publishes them (its `demos` folder: one folder per series, one per map inside it, each
//! map either a versioned folder with CURRENT and COMPLETE or a flat folder of tables). The app only
//! reads it: listing and reading are `read_dir`, `metadata` and `read`, and the one file this module
//! writes is the setting naming the folder, `%APPDATA%\BotMatchStats\pro-library.json`.
//! app/tools/pro-folder.ts implements the same rules for the dev server. A map is listed as
//! "pro/<series>/<map>" (flat) or "pro/<series>/<map>/<version folder>" (versioned).

use super::{inside, plain_name, table_name, version_dir, FileEntry, Skipped};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const SETTING: &str = "pro-library.json";

fn setting_file() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join(SETTING))
}

/// The folder the user picked, from the setting; None when none is set. An unreadable setting is an error.
pub fn library_folder() -> Result<Option<PathBuf>, String> {
    let f = setting_file()?;
    let text = match fs::read_to_string(&f) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", f.display())),
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", f.display()))?;
    match v.get("folder") {
        Some(serde_json::Value::String(s)) if !s.is_empty() => Ok(Some(PathBuf::from(s))),
        Some(serde_json::Value::Null) | None => Ok(None),
        _ => Err(format!("{} names no folder (\"folder\": <path>)", f.display())),
    }
}

fn save_folder(folder: Option<&Path>) -> Result<(), String> {
    let f = setting_file()?;
    if let Some(dir) = f.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let body = serde_json::json!({ "folder": folder.map(|p| p.display().to_string()) });
    fs::write(&f, body.to_string()).map_err(|e| format!("{}: {e}", f.display()))
}

/// The folder whose subfolders are series: the picked folder, or its `demos` folder when the user picked
/// the data folder above it.
fn series_root(folder: &Path) -> PathBuf {
    let demos = folder.join("demos");
    if demos.is_dir() { demos } else { folder.to_path_buf() }
}

/// A version folder's COMPLETE list (table file name to bytes), when COMPLETE lies inside `root` and names
/// only plain table files. The tables themselves are checked as each is read (read_in): checking every
/// table of every map at each listing made a listing of 1,080 maps take over half a minute.
fn complete(root: &Path, dir: &Path) -> Result<BTreeMap<String, u64>, String> {
    let c = dir.join("COMPLETE");
    if !c.exists() {
        return Err("no COMPLETE file yet".into());
    }
    if !inside(root, &c) {
        return Err("its version folder resolves outside the library".into());
    }
    let text = fs::read_to_string(&c).map_err(|e| format!("COMPLETE: {e}"))?;
    let sizes: BTreeMap<String, u64> = serde_json::from_str(&text).map_err(|e| format!("COMPLETE: {e}"))?;
    if let Some(f) = sizes.keys().find(|f| !table_name(f)) {
        return Err(format!("COMPLETE lists \"{f}\", which is not a table file name"));
    }
    Ok(sizes)
}

/// A flat map folder's tables: its plain table files inside `root`, with their sizes.
fn flat_tables(root: &Path, dir: &Path) -> Result<BTreeMap<String, u64>, String> {
    let mut out = BTreeMap::new();
    for item in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let item = item.map_err(|e| format!("{}: {e}", dir.display()))?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else { continue };
        let p = item.path();
        if table_name(&name) && p.is_file() && inside(root, &p) {
            out.insert(name, fs::metadata(&p).map(|m| m.len()).unwrap_or(0));
        }
    }
    Ok(out)
}

/// One map folder now: its listed path and the file it is keyed by (the version's COMPLETE, or a flat
/// folder's match.parquet), why it has no complete map, or no map at all.
enum Map {
    Listed { file: String, key: fs::Metadata },
    Skip(String),
    None,
}

/// A version folder counts once its COMPLETE file exists, and a flat folder (the extractor's output from
/// before version folders, never rewritten) once its match.parquet does; a map's tables are checked as
/// each is read (read_in). The walk reads directory entries, so a folder or file that is a link shows as
/// one, and only a map with a link on its path costs a canonicalize to prove it stays inside the library.
/// Checking every table of every map made a listing of 1,080 maps take over half a minute.
fn resolve(root: &Path, map: &Path, rel: &str, linked: bool) -> Map {
    let Ok(items) = fs::read_dir(map) else { return Map::Skip("the folder cannot be read".into()) };
    let names: BTreeMap<String, fs::FileType> = items
        .flatten()
        .filter_map(|e| Some((e.file_name().to_str()?.to_owned(), e.file_type().ok()?)))
        .collect();
    if names.contains_key("RETIRED") {
        return Map::Skip("retired".into());
    }
    let (file, done, mut link) = if let Some(pointer) = names.get("CURRENT") {
        let version = fs::read_to_string(map.join("CURRENT")).unwrap_or_default().trim().to_string();
        if !version_dir(&version) {
            return Map::Skip(format!("CURRENT names \"{version}\", which is not a version folder"));
        }
        let Some(vdir) = names.get(&version) else { return Map::Skip(format!("{version}: no such version folder")) };
        (format!("{rel}/{version}"), map.join(&version).join("COMPLETE"), linked || pointer.is_symlink() || vdir.is_symlink())
    } else if let Some(first) = names.get("match.parquet") {
        (rel.to_string(), map.join("match.parquet"), linked || first.is_symlink())
    } else {
        return Map::None;
    };
    let Ok(key) = fs::symlink_metadata(&done) else { return Map::Skip("no COMPLETE file yet".into()) };
    link |= key.file_type().is_symlink();
    if link && !inside(root, &done) {
        return Map::Skip("resolves outside the library".into());
    }
    Map::Listed { file, key }
}

#[derive(Serialize)]
pub struct ProListing {
    /// the folder the user picked; None when none is set
    folder: Option<String>,
    files: Vec<FileEntry>,
    /// map folders with no complete map now, and why
    skipped: Vec<Skipped>,
    /// why the folder could not be listed at all
    error: Option<String>,
}

/// Every map of the library whose tables are complete. A folder that cannot be listed is reported in
/// `error`, not returned as an error, so the user's own matches still load.
pub fn list_in(folder: &Path) -> ProListing {
    let mut out = ProListing { folder: Some(folder.display().to_string()), files: Vec::new(), skipped: Vec::new(), error: None };
    let root = series_root(folder);
    let series = match fs::read_dir(&root) {
        Ok(s) => s,
        Err(e) => {
            out.error = Some(format!("{}: {e}", root.display()));
            return out;
        }
    };
    // a folder entry that is a link (a junction) is followed, and its maps proven to stay inside the library
    let folder_like = |t: &fs::FileType| t.is_dir() || t.is_symlink();
    for s in series.flatten() {
        let (Some(sname), Ok(st)) = (s.file_name().to_str().map(str::to_owned), s.file_type()) else { continue };
        if !plain_name(&sname) || !folder_like(&st) {
            continue;
        }
        let Ok(maps) = fs::read_dir(s.path()) else { continue };
        for m in maps.flatten() {
            let (Some(mname), Ok(mt)) = (m.file_name().to_str().map(str::to_owned), m.file_type()) else { continue };
            if !plain_name(&mname) || !folder_like(&mt) {
                continue;
            }
            let rel = format!("pro/{sname}/{mname}");
            match resolve(&root, &m.path(), &rel, st.is_symlink() || mt.is_symlink()) {
                Map::Listed { file, key } => out.files.push(FileEntry {
                    size: key.len(),
                    mtime: key.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64),
                    file,
                }),
                Map::Skip(why) => out.skipped.push(Skipped { file: rel, why }),
                Map::None => {}
            }
        }
    }
    out.files.sort_by(|a, b| b.file.cmp(&a.file));
    out
}

/// One read under the library. `path` is the listed file without "pro/": "<series>/<map>[/<version>]"
/// returns the map's table file names as JSON, and the same with "/<table>.parquet" returns that table,
/// only if it is one of the map's tables (at its COMPLETE size for a version folder).
pub fn read_in(folder: &Path, path: &str) -> Result<Vec<u8>, String> {
    let parts: Vec<&str> = path.split('/').collect();
    let bad = || format!("{path}: not a pro library path (<series>/<map>[/<version folder>][/<table>.parquet])");
    if parts.len() < 2 || parts.len() > 4 || !plain_name(parts[0]) || !plain_name(parts[1]) {
        return Err(bad());
    }
    let (version, table) = match &parts[2..] {
        [] => (None, None),
        [x] if version_dir(x) => (Some(*x), None),
        [x] if table_name(x) => (None, Some(*x)),
        [v, t] if version_dir(v) && table_name(t) => (Some(*v), Some(*t)),
        _ => return Err(bad()),
    };
    let root = series_root(folder);
    let map = root.join(parts[0]).join(parts[1]);
    // a version folder's tables are the ones its COMPLETE lists; a flat folder's, its plain table files
    let (dir, listed) = match version {
        Some(v) => {
            let dir = map.join(v);
            let sizes = complete(&root, &dir).map_err(|why| format!("{path}: {why}; rescan"))?;
            (dir, Some(sizes))
        }
        None => {
            if !inside(&root, &map.join("match.parquet")) {
                return Err(format!("{path}: no map here; rescan"));
            }
            (map, None)
        }
    };
    let Some(table) = table else {
        let names: Vec<String> = match listed {
            Some(sizes) => sizes.into_keys().collect(),
            None => flat_tables(&root, &dir)?.into_keys().collect(),
        };
        return serde_json::to_vec(&names).map_err(|e| e.to_string());
    };
    let want = match &listed {
        Some(sizes) => Some(*sizes.get(table).ok_or_else(|| format!("{path}: not one of this map's tables"))?),
        None => None,
    };
    let p = dir.join(table);
    if !inside(&root, &p) {
        return Err(format!("{path}: not one of this map's tables"));
    }
    let bytes = fs::read(&p).map_err(|e| format!("{path}: {e}"))?;
    if let Some(want) = want.filter(|w| bytes.len() as u64 != *w) {
        return Err(format!("{path}: {} bytes, not the {want} COMPLETE lists; rescan", bytes.len()));
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn pro_library() -> Result<Option<String>, String> {
    Ok(library_folder()?.map(|p| p.display().to_string()))
}

/// Asks for a folder with the system's folder picker and saves it; None when the user cancels.
#[tauri::command]
pub async fn choose_pro_library(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().set_title("Pro match library").blocking_pick_folder() else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    save_folder(Some(&path))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn forget_pro_library() -> Result<(), String> {
    save_folder(None)
}

#[tauri::command]
pub async fn list_pro() -> Result<ProListing, String> {
    Ok(match library_folder()? {
        Some(f) => list_in(&f),
        None => ProListing { folder: None, files: Vec::new(), skipped: Vec::new(), error: None },
    })
}

#[tauri::command]
pub async fn read_pro(path: String) -> Result<tauri::ipc::Response, String> {
    let folder = library_folder()?.ok_or("no pro match library is set")?;
    read_in(&folder, &path).map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A library under the system temp folder, removed when dropped: one flat map, one versioned map,
    /// one retired map and one version folder still being written (no COMPLETE).
    struct Library(PathBuf);
    impl Library {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!("cs2-pro-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            let w = |p: &str, b: &[u8]| {
                let f = root.join(p);
                fs::create_dir_all(f.parent().unwrap()).unwrap();
                fs::write(f, b).unwrap();
            };
            w("demos/a-vs-b-1/m1-dust2/match.parquet", b"match");
            w("demos/a-vs-b-1/m1-dust2/kills.parquet", b"kills!");
            w("demos/a-vs-b-1/m1-dust2/notes.txt", b"not a table");
            w("demos/a-vs-b-1/m2-nuke/CURRENT", b"v-1.2.0-0123abcd\n");
            w("demos/a-vs-b-1/m2-nuke/v-1.2.0-0123abcd/match.parquet", b"m2");
            w("demos/a-vs-b-1/m2-nuke/v-1.2.0-0123abcd/COMPLETE", br#"{"match.parquet": 2}"#);
            w("demos/a-vs-b-1/m3-inferno/RETIRED", b"replaced");
            w("demos/a-vs-b-1/m3-inferno/match.parquet", b"old");
            w("demos/c-vs-d-2/m1-mirage/CURRENT", b"v-1.2.0-89abcdef");
            w("demos/c-vs-d-2/m1-mirage/v-1.2.0-89abcdef/match.parquet", b"half");
            Library(root)
        }
    }
    impl Drop for Library {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Every path under `dir`, and each file's size and modified time. A folder's own modified time is
    /// left out: NTFS updates it lazily, after the files created in it.
    fn snapshot(dir: &Path, out: &mut Vec<(PathBuf, u64, Option<std::time::SystemTime>)>) {
        for e in fs::read_dir(dir).unwrap().flatten() {
            let m = e.metadata().unwrap();
            if m.is_dir() {
                out.push((e.path(), 0, None));
                snapshot(&e.path(), out);
            } else {
                out.push((e.path(), m.len(), Some(m.modified().unwrap())));
            }
        }
    }

    #[test]
    fn lists_complete_maps_of_the_extractors_layout() {
        // fails if a flat or versioned map is missed, a retired or half-written one is listed, or the
        // data folder above demos/ is not accepted
        let lib = Library::new("list");
        let l = list_in(&lib.0);
        let files: Vec<&str> = l.files.iter().map(|f| f.file.as_str()).collect();
        assert_eq!(files, ["pro/a-vs-b-1/m2-nuke/v-1.2.0-0123abcd", "pro/a-vs-b-1/m1-dust2"]);
        // a flat folder is keyed by match.parquet alone
        assert_eq!(l.files[1].size, 5);
        let mut skipped: Vec<&str> = l.skipped.iter().map(|s| s.file.as_str()).collect();
        skipped.sort();
        assert_eq!(skipped, ["pro/a-vs-b-1/m3-inferno", "pro/c-vs-d-2/m1-mirage"]);
        assert_eq!(list_in(&lib.0.join("demos")).files.len(), 2);
    }

    #[test]
    fn reads_only_a_maps_own_tables() {
        // fails if a read can leave the library or reach a file that is not one of the map's tables
        let lib = Library::new("read");
        let names: Vec<String> = serde_json::from_slice(&read_in(&lib.0, "a-vs-b-1/m1-dust2").unwrap()).unwrap();
        assert_eq!(names, ["kills.parquet", "match.parquet"]);
        assert_eq!(read_in(&lib.0, "a-vs-b-1/m2-nuke/v-1.2.0-0123abcd/match.parquet").unwrap(), b"m2");
        for bad in [
            "a-vs-b-1/m1-dust2/notes.txt",
            "../a-vs-b-1/m1-dust2",
            "a-vs-b-1/../m1-dust2/match.parquet",
            "a-vs-b-1/m1-dust2/../../x.parquet",
            "c-vs-d-2/m1-mirage/v-1.2.0-89abcdef/match.parquet",
            "a-vs-b-1/m2-nuke/v-1.2.0-0123abcd/kills.parquet",
        ] {
            assert!(read_in(&lib.0, bad).is_err(), "{bad} was read");
        }
    }

    /// How long listing a real library takes: `CS2_PRO_LIBRARY=<folder> cargo test --lib pro:: -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn times_a_real_library() {
        let folder = PathBuf::from(std::env::var_os("CS2_PRO_LIBRARY").expect("CS2_PRO_LIBRARY names the library"));
        for pass in ["first", "second"] {
            let t = std::time::Instant::now();
            let l = list_in(&folder);
            println!("{pass} listing: {} maps, {} skipped, {:?}", l.files.len(), l.skipped.len(), t.elapsed());
        }
    }

    #[test]
    fn never_writes_into_the_library() {
        // fails if listing or reading the library creates, changes or removes anything in it
        let lib = Library::new("ro");
        let mut before = Vec::new();
        snapshot(&lib.0, &mut before);
        for f in &list_in(&lib.0).files {
            let rel = f.file.strip_prefix("pro/").unwrap();
            let names: Vec<String> = serde_json::from_slice(&read_in(&lib.0, rel).unwrap()).unwrap();
            for n in names {
                read_in(&lib.0, &format!("{rel}/{n}")).unwrap();
            }
        }
        let mut after = Vec::new();
        snapshot(&lib.0, &mut after);
        before.sort();
        after.sort();
        assert_eq!(before, after);
    }
}
