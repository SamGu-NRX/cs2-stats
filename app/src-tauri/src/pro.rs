//! The pro match library: a folder of extracted pro demos the user picks in Data & settings, laid out as
//! the extractor publishes them (its `demos` folder: one folder per series, one per map inside it, each
//! map either a versioned folder with CURRENT and COMPLETE or a flat folder of tables). The app only
//! reads it: listing and reading are `read_dir`, `metadata` and `read`, and the one file this module
//! writes is the setting naming the folder, `%APPDATA%\BotMatchStats\pro-library.json`. So the library
//! may not be that folder, sit inside it or hold it (`open`).
//! app/tools/pro-folder.ts implements the same rules for the dev server. A map is listed as
//! "pro/<series>/<map>" (flat) or "pro/<series>/<map>/<version folder>" (versioned).

use super::{plain_name, table_name, version_dir, FileEntry, Skipped};
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

/// The app's own data folder, `%APPDATA%\BotMatchStats`, where the setting is written; None without APPDATA.
fn app_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("BotMatchStats"))
}

/// The library as it is read: the chosen folder resolved (every junction and link followed), and the
/// folder under it whose subfolders are series (the chosen folder, or its `demos` folder).
pub struct Library {
    canon: PathBuf,
    series: PathBuf,
}

/// Resolves a chosen folder, or says why it cannot be the library:
/// - It is resolved first, so every later check compares against where it really is.
/// - It may not be the app's data folder (`app`), sit inside it, or hold it: choosing or forgetting the
///   library writes the setting there, which would write into the library.
/// - Its `demos` folder, when it has one, may not be a link: a junction there could put the series
///   anywhere on the disk while the containment checks compared against it.
pub fn open(folder: &Path, app: Option<&Path>) -> Result<Library, String> {
    let canon = folder.canonicalize().map_err(|e| format!("{}: {e}", folder.display()))?;
    if let Some(app) = app {
        let app = app.canonicalize().unwrap_or_else(|_| app.to_path_buf());
        if canon.starts_with(&app) || app.starts_with(&canon) {
            return Err(format!(
                "{} is the app's own data folder, inside it or above it, and the app writes its settings there. Choose the extractor's demos folder instead.",
                folder.display()
            ));
        }
    }
    let demos = canon.join("demos");
    let series = match fs::symlink_metadata(&demos) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err(format!("{} is a link to another folder. Choose the folder it points to instead.", demos.display()))
        }
        Ok(m) if m.is_dir() => demos,
        _ => canon.clone(),
    };
    Ok(Library { canon, series })
}

/// Whether `p`, resolved, lies inside the chosen folder.
fn under(lib: &Library, p: &Path) -> bool {
    p.canonicalize().is_ok_and(|q| q != lib.canon && q.starts_with(&lib.canon))
}

/// A folder's entries by name, each with its metadata. On Windows the metadata comes with the listing
/// itself, so this is one call however many files the folder holds.
fn entries(dir: &Path) -> Result<BTreeMap<String, fs::Metadata>, String> {
    let items = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(items.flatten().filter_map(|e| Some((e.file_name().to_str()?.to_owned(), e.metadata().ok()?))).collect())
}

/// A version folder's COMPLETE list: file name to bytes, the extractor's record of every table it wrote.
fn complete_list(text: &str) -> Result<BTreeMap<String, u64>, String> {
    let sizes: BTreeMap<String, u64> = serde_json::from_str(text).map_err(|e| format!("COMPLETE: {e}"))?;
    if let Some(f) = sizes.keys().find(|f| !table_name(f)) {
        return Err(format!("COMPLETE lists \"{f}\", which is not a table file name"));
    }
    Ok(sizes)
}

/// One map folder now: its listed path and the file it is keyed by (the version's COMPLETE, or a flat
/// folder's match.parquet), a map that is not whole yet, a map left out for another reason, or no map.
enum Map {
    Listed { file: String, key: fs::Metadata },
    Incomplete(String),
    Skip(String),
    None,
}

/// A version folder counts when every table its COMPLETE names is there, not a link, not empty and at the
/// size COMPLETE gives it; a flat folder (the extractor's output from before version folders) when its
/// match.parquet is there and none of its tables is empty. A folder or file that is a link is left out.
fn resolve(map: &Path, rel: &str) -> Map {
    let Ok(names) = entries(map) else { return Map::Skip("the folder cannot be read".into()) };
    if names.contains_key("RETIRED") {
        return Map::Skip("retired".into());
    }
    let is_link = |m: &fs::Metadata| m.file_type().is_symlink();
    if names.contains_key("CURRENT") {
        let version = fs::read_to_string(map.join("CURRENT")).unwrap_or_default().trim().to_string();
        if !version_dir(&version) {
            return Map::Skip(format!("CURRENT names \"{version}\", which is not a version folder"));
        }
        match names.get(&version) {
            None => return Map::Incomplete(format!("{version}: no such version folder")),
            Some(m) if is_link(m) || !m.is_dir() => return Map::Skip(format!("{version}: a link, left out")),
            _ => {}
        }
        let dir = map.join(&version);
        let Ok(files) = entries(&dir) else { return Map::Skip(format!("{version}: the folder cannot be read")) };
        let Some(done) = files.get("COMPLETE").filter(|m| !is_link(m) && m.is_file()) else {
            return Map::Incomplete(format!("{version}: no COMPLETE file yet"));
        };
        let sizes = match fs::read_to_string(dir.join("COMPLETE")).map_err(|e| format!("COMPLETE: {e}")).and_then(|t| complete_list(&t)) {
            Ok(s) => s,
            Err(why) => return Map::Incomplete(format!("{version}: {why}")),
        };
        for (table, bytes) in &sizes {
            let why = match files.get(table) {
                None => format!("{table} is missing"),
                Some(m) if is_link(m) || !m.is_file() => format!("{table} is a link, left out"),
                Some(m) if m.len() == 0 || *bytes == 0 => format!("{table} is empty"),
                Some(m) if m.len() != *bytes => format!("{table} is {} bytes, not the {bytes} COMPLETE lists", m.len()),
                _ => continue,
            };
            return Map::Incomplete(format!("{version}: {why}"));
        }
        return Map::Listed { file: format!("{rel}/{version}"), key: done.clone() };
    }
    let Some(first) = names.get("match.parquet") else { return Map::None };
    if is_link(first) {
        return Map::Skip("match.parquet is a link, left out".into());
    }
    if let Some((t, _)) = names.iter().find(|(t, m)| table_name(t) && m.len() == 0) {
        return Map::Incomplete(format!("{t} is empty"));
    }
    Map::Listed { file: rel.to_string(), key: first.clone() }
}

#[derive(Serialize)]
pub struct ProListing {
    /// the folder the user picked; None when none is set
    folder: Option<String>,
    files: Vec<FileEntry>,
    /// map folders left out, and why
    skipped: Vec<Skipped>,
    /// how many of those are not whole yet (a table missing, empty or short of its listed size)
    incomplete: usize,
    /// why the folder could not be listed at all
    error: Option<String>,
}

/// Every whole map of the library. A folder that cannot be listed is reported in `error`, not returned as
/// an error, so the user's own matches still load. A series or map folder that is a link is left out.
pub fn list_in(folder: &Path, app: Option<&Path>) -> ProListing {
    let mut out = ProListing { folder: Some(folder.display().to_string()), files: Vec::new(), skipped: Vec::new(), incomplete: 0, error: None };
    let lib = match open(folder, app) {
        Ok(l) => l,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    let series = match fs::read_dir(&lib.series) {
        Ok(s) => s,
        Err(e) => {
            out.error = Some(format!("{}: {e}", lib.series.display()));
            return out;
        }
    };
    for s in series.flatten() {
        let (Some(sname), Ok(st)) = (s.file_name().to_str().map(str::to_owned), s.file_type()) else { continue };
        if !plain_name(&sname) || !(st.is_dir() || st.is_symlink()) {
            continue;
        }
        if st.is_symlink() {
            out.skipped.push(Skipped { file: format!("pro/{sname}"), why: "a link, left out".into() });
            continue;
        }
        let Ok(maps) = fs::read_dir(s.path()) else { continue };
        for m in maps.flatten() {
            let (Some(mname), Ok(mt)) = (m.file_name().to_str().map(str::to_owned), m.file_type()) else { continue };
            if !plain_name(&mname) || !(mt.is_dir() || mt.is_symlink()) {
                continue;
            }
            let rel = format!("pro/{sname}/{mname}");
            let found = if mt.is_symlink() { Map::Skip("a link, left out".into()) } else { resolve(&m.path(), &rel) };
            match found {
                Map::Listed { file, key } => out.files.push(FileEntry {
                    size: key.len(),
                    mtime: key.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64),
                    file,
                }),
                Map::Incomplete(why) => {
                    out.incomplete += 1;
                    out.skipped.push(Skipped { file: rel, why });
                }
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
/// only if it is one of the map's tables (at its COMPLETE size for a version folder) and resolves inside
/// the chosen folder.
pub fn read_in(folder: &Path, app: Option<&Path>, path: &str) -> Result<Vec<u8>, String> {
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
    let lib = open(folder, app)?;
    let map = lib.series.join(parts[0]).join(parts[1]);
    // a version folder's tables are the ones its COMPLETE lists; a flat folder's, its plain table files
    let (dir, listed) = match version {
        Some(v) => {
            let dir = map.join(v);
            if !under(&lib, &dir.join("COMPLETE")) {
                return Err(format!("{path}: this version is gone; rescan"));
            }
            let text = fs::read_to_string(dir.join("COMPLETE")).map_err(|_| format!("{path}: this version is gone; rescan"))?;
            (dir, Some(complete_list(&text).map_err(|why| format!("{path}: {why}"))?))
        }
        None => {
            if !under(&lib, &map.join("match.parquet")) {
                return Err(format!("{path}: no map here; rescan"));
            }
            (map, None)
        }
    };
    let Some(table) = table else {
        let names: Vec<String> = match listed {
            Some(sizes) => sizes.into_keys().collect(),
            None => entries(&dir)?.into_iter().filter(|(n, m)| table_name(n) && m.is_file()).map(|(n, _)| n).collect(),
        };
        return serde_json::to_vec(&names).map_err(|e| e.to_string());
    };
    let want = match &listed {
        Some(sizes) => Some(*sizes.get(table).ok_or_else(|| format!("{path}: not one of this map's tables"))?),
        None => None,
    };
    let p = dir.join(table);
    if !under(&lib, &p) {
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
    open(&path, app_dir().as_deref())?;
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
        Some(f) => list_in(&f, app_dir().as_deref()),
        None => ProListing { folder: None, files: Vec::new(), skipped: Vec::new(), incomplete: 0, error: None },
    })
}

#[tauri::command]
pub async fn read_pro(path: String) -> Result<tauri::ipc::Response, String> {
    let folder = library_folder()?.ok_or("no pro match library is set")?;
    read_in(&folder, app_dir().as_deref(), &path).map(tauri::ipc::Response::new)
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
        let l = list_in(&lib.0, None);
        let files: Vec<&str> = l.files.iter().map(|f| f.file.as_str()).collect();
        assert_eq!(files, ["pro/a-vs-b-1/m2-nuke/v-1.2.0-0123abcd", "pro/a-vs-b-1/m1-dust2"]);
        // a flat folder is keyed by match.parquet alone
        assert_eq!(l.files[1].size, 5);
        let mut skipped: Vec<&str> = l.skipped.iter().map(|s| s.file.as_str()).collect();
        skipped.sort();
        assert_eq!(skipped, ["pro/a-vs-b-1/m3-inferno", "pro/c-vs-d-2/m1-mirage"]);
        assert_eq!(l.incomplete, 1);
        assert_eq!(list_in(&lib.0.join("demos"), None).files.len(), 2);
    }

    #[test]
    fn reads_only_a_maps_own_tables() {
        // fails if a read can leave the library or reach a file that is not one of the map's tables
        let lib = Library::new("read");
        let names: Vec<String> = serde_json::from_slice(&read_in(&lib.0, None, "a-vs-b-1/m1-dust2").unwrap()).unwrap();
        assert_eq!(names, ["kills.parquet", "match.parquet"]);
        assert_eq!(read_in(&lib.0, None, "a-vs-b-1/m2-nuke/v-1.2.0-0123abcd/match.parquet").unwrap(), b"m2");
        for bad in [
            "a-vs-b-1/m1-dust2/notes.txt",
            "../a-vs-b-1/m1-dust2",
            "a-vs-b-1/../m1-dust2/match.parquet",
            "a-vs-b-1/m1-dust2/../../x.parquet",
            "c-vs-d-2/m1-mirage/v-1.2.0-89abcdef/match.parquet",
            "a-vs-b-1/m2-nuke/v-1.2.0-0123abcd/kills.parquet",
        ] {
            assert!(read_in(&lib.0, None, bad).is_err(), "{bad} was read");
        }
    }

    /// How long listing a real library takes: `CS2_PRO_LIBRARY=<folder> cargo test --lib pro:: -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn times_a_real_library() {
        let folder = PathBuf::from(std::env::var_os("CS2_PRO_LIBRARY").expect("CS2_PRO_LIBRARY names the library"));
        for pass in ["first", "second"] {
            let t = std::time::Instant::now();
            let l = list_in(&folder, None);
            println!("{pass} listing: {} maps, {} skipped, {:?}", l.files.len(), l.skipped.len(), t.elapsed());
        }
    }

    /// A folder under the system temp folder, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("cs2-pro-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn write(&self, rel: &str, b: &[u8]) {
            let f = self.0.join(rel);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, b).unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A directory junction at `link` to `target`, as a user (or a stray tool) could leave in a library.
    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap().status.success();
        assert!(ok, "mklink /J {} {}", link.display(), target.display());
    }

    #[cfg(windows)]
    #[test]
    fn refuses_links_that_lead_out_of_the_library() {
        // fails if a demos folder, series folder or map folder that is a junction to a folder outside the
        // chosen one is listed or read
        let outside = Scratch::new("outside");
        outside.write("s-1/m1/match.parquet", b"out");
        outside.write("m1/match.parquet", b"out");
        let lib = Scratch::new("linked");
        junction(&lib.0.join("demos"), &outside.0);
        let l = list_in(&lib.0, None);
        assert!(l.files.is_empty() && l.error.as_deref().is_some_and(|e| e.contains("is a link")), "{:?}", l.error);
        assert!(read_in(&lib.0, None, "s-1/m1/match.parquet").is_err());

        let lib = Scratch::new("linked-map");
        lib.write("demos/s-1/own/match.parquet", b"own");
        junction(&lib.0.join("demos").join("s-1").join("m1"), &outside.0.join("m1"));
        junction(&lib.0.join("demos").join("s-2"), &outside.0.join("s-1"));
        let l = list_in(&lib.0, None);
        let files: Vec<&str> = l.files.iter().map(|f| f.file.as_str()).collect();
        assert_eq!(files, ["pro/s-1/own"]);
        assert!(read_in(&lib.0, None, "s-1/m1/match.parquet").is_err());
        assert!(read_in(&lib.0, None, "s-2/m1/match.parquet").is_err());
    }

    #[test]
    fn refuses_the_apps_own_data_folder() {
        // fails if the library may be the folder the app writes its setting to, a folder inside it or a
        // folder holding it, so that choosing or forgetting the library writes into it
        let home = Scratch::new("appdata");
        let app = home.0.join("BotMatchStats");
        home.write("BotMatchStats/demos/s-1/m1/match.parquet", b"m");
        for folder in [app.clone(), app.join("demos"), home.0.clone()] {
            let err = open(&folder, Some(&app)).err().unwrap_or_default();
            assert!(err.contains("the app writes its settings there"), "{} was accepted: {err}", folder.display());
            assert!(list_in(&folder, Some(&app)).files.is_empty());
        }
        let elsewhere = Scratch::new("library");
        elsewhere.write("demos/s-1/m1/match.parquet", b"m");
        assert!(open(&elsewhere.0, Some(&app)).is_ok());
    }

    #[test]
    fn lists_a_map_only_when_every_table_its_marker_names_is_whole() {
        // fails if a version is listed while a table its COMPLETE names is missing, empty or short
        let lib = Scratch::new("incomplete");
        let version = |map: &str, files: &[(&str, &[u8])], complete: &str| {
            lib.write(&format!("demos/s-1/{map}/CURRENT"), b"v-1.0.0-0123abcd");
            for (f, b) in files {
                lib.write(&format!("demos/s-1/{map}/v-1.0.0-0123abcd/{f}"), b);
            }
            lib.write(&format!("demos/s-1/{map}/v-1.0.0-0123abcd/COMPLETE"), complete.as_bytes());
        };
        version("whole", &[("match.parquet", b"mm"), ("kills.parquet", b"kkk")], r#"{"match.parquet": 2, "kills.parquet": 3}"#);
        version("missing", &[("match.parquet", b"mm")], r#"{"match.parquet": 2, "kills.parquet": 3}"#);
        version("empty", &[("match.parquet", b"mm"), ("kills.parquet", b"")], r#"{"match.parquet": 2, "kills.parquet": 0}"#);
        version("short", &[("match.parquet", b"mm"), ("kills.parquet", b"k")], r#"{"match.parquet": 2, "kills.parquet": 3}"#);
        let l = list_in(&lib.0, None);
        let files: Vec<&str> = l.files.iter().map(|f| f.file.as_str()).collect();
        assert_eq!(files, ["pro/s-1/whole/v-1.0.0-0123abcd"]);
        assert_eq!(l.incomplete, 3);
    }

    #[test]
    fn never_writes_into_the_library() {
        // fails if listing or reading the library creates, changes or removes anything in it
        let lib = Library::new("ro");
        let mut before = Vec::new();
        snapshot(&lib.0, &mut before);
        for f in &list_in(&lib.0, None).files {
            let rel = f.file.strip_prefix("pro/").unwrap();
            let names: Vec<String> = serde_json::from_slice(&read_in(&lib.0, None, rel).unwrap()).unwrap();
            for n in names {
                read_in(&lib.0, None, &format!("{rel}/{n}")).unwrap();
            }
        }
        let mut after = Vec::new();
        snapshot(&lib.0, &mut after);
        before.sort();
        after.sort();
        assert_eq!(before, after);
    }
}
