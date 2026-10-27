//! The clipping service's host side (issue #11, design/clips.md). Everything lives in
//! `%APPDATA%\BotMatchStats\clips`: render jobs in `jobs\<id>` (the plan, the director script and
//! HLAE's raw takes), finished clips as `<clip id>.mp4`, reels in `reels\`.
//!
//! The web view builds every plan and FFmpeg argument list (src/clips/plan.ts and ffmpeg.ts); these
//! commands find the tools, check demos, write the job's files and run what the user asks for,
//! confined to that folder. Only [`clips_launch`] starts the game, and only when the user confirms
//! in the app: it starts CS2 through HLAE with `-insecure`, which HLAE needs to inject and which
//! keeps VAC off for the session. It refuses a command that differs from the one plan.ts writes, and
//! it has not been run against a live game.

use crate::botmode::launch::split;
use crate::botmode::process::{cs2_listed, is_secure_token};
use crate::botmode::steam::{find_cs2, steam_root};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The cfg the launch writes into `game\csgo\cfg`; plan.ts CFG_NAME.
const CFG_NAME: &str = "cs2stats_clips";

fn clips_dir() -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("CS2_CLIPS_DIR") {
        return std::path::absolute(PathBuf::from(d)).map_err(|e| e.to_string());
    }
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join("clips"))
}

/// A job id as plan.ts writes it: `job-YYYYMMDDTHHMMSSZ`.
fn job_id_ok(s: &str) -> bool {
    s.len() == 20 && s.starts_with("job-") && s.ends_with('Z') && s[4..19].chars().enumerate().all(|(i, c)| if i == 8 { c == 'T' } else { c.is_ascii_digit() })
}

/// A clip id as clips/ids.ts writes it: `c-<16 hex>-r<round>`.
fn clip_id_ok(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("c-") else { return false };
    let Some((hex, round)) = rest.split_once("-r") else { return false };
    hex.len() == 16
        && hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
        && (1..=3).contains(&round.len())
        && !round.starts_with('0')
        && round.chars().all(|c| c.is_ascii_digit())
}

fn file_info(p: &Path) -> Option<(u64, u64)> {
    let m = fs::metadata(p).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    m.is_file().then_some((m.len(), mtime))
}

// ---------------------------------------------------------------- finding the tools

/// The first of `names` in any folder of PATH.
fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// FFmpeg: `CS2_FFMPEG`, then PATH, then the usual install folders (winget's links, Scoop's shims,
/// Chocolatey's bin), then the copy in HLAE's own folder. Nothing is installed; the error says how.
pub fn find_ffmpeg(hlae: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("CS2_FFMPEG").map(PathBuf::from) {
        return if p.is_file() { Ok(p) } else { Err(format!("CS2_FFMPEG names {}, which is not a file", p.display())) };
    }
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Some(p) = on_path(&[exe]) {
        return Ok(p);
    }
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut look: Vec<PathBuf> = Vec::new();
    if let Some(l) = env("LOCALAPPDATA") {
        look.push(l.join("Microsoft").join("WinGet").join("Links").join(exe));
    }
    if let Some(u) = env("USERPROFILE") {
        look.push(u.join("scoop").join("shims").join(exe));
    }
    if let Some(p) = env("ProgramData") {
        look.push(p.join("chocolatey").join("bin").join(exe));
    }
    if let Some(h) = hlae.and_then(Path::parent) {
        look.push(h.join("ffmpeg").join("bin").join(exe));
    }
    look.into_iter().find(|p| p.is_file()).ok_or_else(|| {
        "FFmpeg was not found: not in CS2_FFMPEG, on PATH, in WinGet's, Scoop's or Chocolatey's folders, or beside HLAE. \
         Install it yourself (for example `winget install Gyan.FFmpeg`), then press Check again. The app does not install it."
            .into()
    })
}

/// A user's HLAE choice checked: a file named HLAE.exe with `x64\AfxHookSource2.dll` beside it.
pub fn check_hlae(p: &Path) -> Result<(), String> {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !name.eq_ignore_ascii_case("HLAE.exe") {
        return Err(format!("{} is not HLAE.exe", p.display()));
    }
    if !p.is_file() {
        return Err(format!("{} does not exist", p.display()));
    }
    let hook = p.parent().unwrap_or(Path::new("")).join("x64").join("AfxHookSource2.dll");
    if !hook.is_file() {
        return Err(format!("{} has no x64\\AfxHookSource2.dll beside it; is this HLAE's own folder?", p.display()));
    }
    Ok(())
}

/// HLAE: the user's choice when given, else `CS2_HLAE`, else the install folders HLAE's setup uses.
fn find_hlae(chosen: Option<&str>) -> Result<PathBuf, String> {
    if let Some(c) = chosen.filter(|c| !c.trim().is_empty()) {
        let p = PathBuf::from(c.trim());
        check_hlae(&p)?;
        return Ok(p);
    }
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut look: Vec<PathBuf> = env("CS2_HLAE").into_iter().collect();
    for k in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(d) = env(k) {
            look.push(d.join("HLAE").join("HLAE.exe"));
        }
    }
    look.into_iter().find(|p| check_hlae(p).is_ok()).ok_or_else(|| {
        "HLAE was not found. Download it from https://github.com/advancedfx/advancedfx/releases, unpack it, and choose its HLAE.exe.".into()
    })
}

/// The CS2 install: `game\csgo` and `game\bin\win64\cs2.exe`.
fn cs2_paths() -> Result<(PathBuf, PathBuf), String> {
    let install = find_cs2(&steam_root()?)?;
    let exe = install.csgo.parent().ok_or("game\\csgo has no parent")?.join("bin").join("win64").join("cs2.exe");
    if !exe.is_file() {
        return Err(format!("CS2 has no {}", exe.display()));
    }
    Ok((install.csgo, exe))
}

/// One tool's state: where it is, or why it was not found.
#[derive(Serialize)]
pub struct Found {
    path: Option<String>,
    error: Option<String>,
}

fn found(r: Result<PathBuf, String>) -> Found {
    match r {
        Ok(p) => Found { path: Some(p.display().to_string()), error: None },
        Err(e) => Found { path: None, error: Some(e) },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipsEnv {
    clips_dir: String,
    cs2: Found,
    replays: Found,
    hlae: Found,
    ffmpeg: Found,
    /// the lower third's font (ffmpeg.ts FONT_CANDIDATES), as found
    font: Option<String>,
}

const FONTS: [&str; 5] = [
    "C:/Windows/Fonts/seguisb.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
];

/// Where the clips folder, CS2, its replays folder, HLAE (`hlae`: the user's choice) and FFmpeg are. Reads only.
#[tauri::command]
pub async fn clips_env(hlae: Option<String>) -> Result<ClipsEnv, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cs2 = cs2_paths();
        let replays = cs2.as_ref().map_err(Clone::clone).and_then(|(csgo, _)| {
            let r = csgo.join("replays");
            if r.is_dir() { Ok(r) } else { Err(format!("CS2 has no replays folder at {}", r.display())) }
        });
        let h = find_hlae(hlae.as_deref());
        Ok(ClipsEnv {
            clips_dir: clips_dir()?.display().to_string(),
            ffmpeg: found(find_ffmpeg(h.as_ref().ok().map(PathBuf::as_path))),
            cs2: found(cs2.map(|(_, exe)| exe)),
            replays: found(replays),
            hlae: found(h),
            font: FONTS.iter().find(|f| Path::new(f).is_file()).map(|f| f.to_string()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- demos and outputs

/// A demo file name the replays folder can hold: a plain name ending in .dem.
fn demo_name_ok(s: &str) -> bool {
    s.len() > 4 && s.to_ascii_lowercase().ends_with(".dem") && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) && !s.starts_with('.')
}

#[derive(Serialize)]
pub struct DemoOnDisk {
    name: String,
    path: Option<String>,
    size: u64,
}

fn demos_in(replays: &Path, names: &[String]) -> Result<Vec<DemoOnDisk>, String> {
    names
        .iter()
        .map(|n| {
            if !demo_name_ok(n) {
                return Err(format!("{n:?} is not a demo file name"));
            }
            let p = replays.join(n);
            Ok(match file_info(&p) {
                Some((size, _)) => DemoOnDisk { name: n.clone(), path: Some(p.display().to_string()), size },
                None => DemoOnDisk { name: n.clone(), path: None, size: 0 },
            })
        })
        .collect()
}

/// Which of these demos are in CS2's replays folder. Reads only.
#[tauri::command]
pub async fn clips_demos(names: Vec<String>) -> Result<Vec<DemoOnDisk>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (csgo, _) = cs2_paths()?;
        demos_in(&csgo.join("replays"), &names)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Finished {
    id: String,
    path: String,
    size: u64,
    mtime: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Take {
    id: String,
    job: String,
    video: String,
    audio: Option<String>,
    mtime: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ClipsScan {
    finished: Vec<Finished>,
    takes: Vec<Take>,
    reels: Vec<Finished>,
}

fn scan_in(root: &Path) -> Result<ClipsScan, String> {
    let mut out = ClipsScan { finished: vec![], takes: vec![], reels: vec![] };
    let names = |d: &Path| -> Vec<String> {
        fs::read_dir(d).map(|r| r.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect()).unwrap_or_default()
    };
    for n in names(root) {
        if let Some(id) = n.strip_suffix(".mp4").filter(|id| clip_id_ok(id)) {
            let p = root.join(&n);
            if let Some((size, mtime)) = file_info(&p) {
                out.finished.push(Finished { id: id.into(), path: p.display().to_string(), size, mtime });
            }
        }
    }
    for n in names(&root.join("reels")) {
        let p = root.join("reels").join(&n);
        if let (true, Some((size, mtime))) = (n.ends_with(".mp4"), file_info(&p)) {
            out.reels.push(Finished { id: n.trim_end_matches(".mp4").into(), path: p.display().to_string(), size, mtime });
        }
    }
    for job in names(&root.join("jobs")).into_iter().filter(|j| job_id_ok(j)) {
        let raw = root.join("jobs").join(&job).join("raw");
        for id in names(&raw).into_iter().filter(|i| clip_id_ok(i)) {
            let video = raw.join(&id).join("video.mp4");
            let audio = raw.join(&id).join("audio.wav");
            if let Some((_, mtime)) = file_info(&video) {
                out.takes.push(Take {
                    id,
                    job: job.clone(),
                    video: video.display().to_string(),
                    audio: file_info(&audio).map(|_| audio.display().to_string()),
                    mtime,
                });
            }
        }
    }
    out.finished.sort_by(|a, b| a.id.cmp(&b.id));
    out.reels.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.takes.sort_by(|a, b| (&a.id, &a.job).cmp(&(&b.id, &b.job)));
    Ok(out)
}

/// The clips folder's finished clips, reels and HLAE's raw takes. Reads only.
#[tauri::command]
pub async fn clips_scan() -> Result<ClipsScan, String> {
    tauri::async_runtime::spawn_blocking(|| scan_in(&clips_dir()?)).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- jobs

#[derive(Deserialize)]
pub struct NamedText {
    name: String,
    text: String,
}

fn save_job_in(root: &Path, job: &str, files: &[NamedText]) -> Result<PathBuf, String> {
    if !job_id_ok(job) {
        return Err(format!("{job:?} is not a job id"));
    }
    let dir = root.join("jobs").join(job);
    fs::create_dir_all(dir.join("raw")).map_err(|e| format!("{}: {e}", dir.display()))?;
    for f in files {
        if !matches!(f.name.as_str(), "plan.json" | "director.js") {
            return Err(format!("a job holds plan.json and director.js, not {:?}", f.name));
        }
        let p = dir.join(&f.name);
        fs::write(&p, &f.text).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(dir)
}

/// Writes a job's plan and director into `jobs\<job>`. Touches nothing outside the clips folder.
#[tauri::command]
pub async fn clips_save_job(job: String, files: Vec<NamedText>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_job_in(&clips_dir()?, &job, &files).map(|d| d.display().to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// What plan.json says the launch runs.
#[derive(Deserialize)]
struct PlanArgv {
    argv: Vec<String>,
    #[serde(rename = "jobDir")]
    job_dir: String,
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Checks a plan's command against the one plan.ts hlaeArgv writes, flag by flag: HLAE.exe with its
/// hook DLL beside it, the custom loader starting this install's cs2.exe, and a game command line
/// with -insecure, no token that turns VAC on, and the director's cfg. Anything else is refused.
pub fn check_argv(argv: &[String], cs2_exe: &Path) -> Result<(), String> {
    const FLAGS: [&str; 5] = ["-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader"];
    if argv.len() != 12 {
        return Err(format!("the plan's command has {} parts, not the 12 the app writes", argv.len()));
    }
    let hlae = Path::new(&argv[0]);
    check_hlae(hlae)?;
    if argv[1..6] != FLAGS.map(String::from) {
        return Err(format!("the plan's HLAE flags are {:?}, not {FLAGS:?}", &argv[1..6]));
    }
    let hook = hlae.parent().unwrap_or(Path::new("")).join("x64").join("AfxHookSource2.dll");
    if argv[6] != "-hookDllPath" || !same_path(Path::new(&argv[7]), &hook) {
        return Err(format!("the plan injects {}, not HLAE's {}", argv[7], hook.display()));
    }
    if argv[8] != "-programPath" || !same_path(Path::new(&argv[9]), cs2_exe) {
        return Err(format!("the plan starts {}, not this install's {}", argv[9], cs2_exe.display()));
    }
    if argv[10] != "-cmdLine" {
        return Err("the plan's command has no -cmdLine".into());
    }
    let game = split(&argv[11])?;
    if let Some(t) = game.iter().find(|t| is_secure_token(t)) {
        return Err(format!("the game's command line contains {t}, which turns VAC on; clips only start CS2 with -insecure"));
    }
    if game.first().map(String::as_str) != Some("-insecure") {
        return Err("the game's command line must start with -insecure".into());
    }
    let exec = game.windows(2).filter(|w| w[0] == "+exec").count();
    if exec != 1 || !game.windows(2).any(|w| w[0] == "+exec" && w[1] == CFG_NAME) {
        return Err(format!("the game's command line must run +exec {CFG_NAME} and nothing else"));
    }
    if game.iter().any(|t| t.starts_with('+') && t != "+exec") {
        return Err("the game's command line may run no console command but +exec".into());
    }
    Ok(())
}

/// HLAE finds FFmpeg in `ffmpeg\bin\ffmpeg.exe` beside HLAE.exe, else through `ffmpeg\ffmpeg.ini`
/// (povforge hlae.py ensure_ffmpeg_ini). Writes the ini only when neither exists; returns what it did.
fn ensure_ffmpeg_ini(hlae: &Path, ffmpeg: &Path) -> Result<Option<PathBuf>, String> {
    let dir = hlae.parent().unwrap_or(Path::new("")).join("ffmpeg");
    let ini = dir.join("ffmpeg.ini");
    if dir.join("bin").join("ffmpeg.exe").is_file() || ini.is_file() {
        return Ok(None);
    }
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    fs::write(&ini, format!("[Ffmpeg]\nPath={}\n", ffmpeg.display())).map_err(|e| format!("{}: {e}", ini.display()))?;
    Ok(Some(ini))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launched {
    pid: u32,
    cfg: String,
    ffmpeg_ini: Option<String>,
}

/// Starts CS2 through HLAE for a saved job. The user confirms this in the app first; nothing else calls it.
///
/// It refuses while any cs2.exe runs, and when the plan's command is not the one the app writes
/// ([`check_argv`]). Then it writes `game\csgo\cfg\cs2stats_clips.cfg` (the line that loads the job's
/// director), writes HLAE's ffmpeg.ini when HLAE has no FFmpeg of its own, and starts HLAE without
/// waiting for it. Untested against a live game.
#[tauri::command]
pub async fn clips_launch(job: String) -> Result<Launched, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !job_id_ok(&job) {
            return Err(format!("{job:?} is not a job id"));
        }
        let root = clips_dir()?;
        let dir = root.join("jobs").join(&job);
        let plan_path = dir.join("plan.json");
        let text = fs::read_to_string(&plan_path).map_err(|e| format!("{}: {e}", plan_path.display()))?;
        let plan: PlanArgv = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", plan_path.display()))?;
        if !same_path(Path::new(&plan.job_dir), &dir) {
            return Err(format!("{} names another job folder ({})", plan_path.display(), plan.job_dir));
        }
        let director = dir.join("director.js");
        if !director.is_file() {
            return Err(format!("the job has no director at {}", director.display()));
        }
        let (csgo, cs2_exe) = cs2_paths()?;
        check_argv(&plan.argv, &cs2_exe)?;
        if let Some(p) = cs2_listed()?.first() {
            return Err(format!("CS2 is running (process {}). Close it, then render again.", p.pid));
        }
        let hlae = PathBuf::from(&plan.argv[0]);
        let ffmpeg = find_ffmpeg(Some(&hlae))?;
        let ini = ensure_ffmpeg_ini(&hlae, &ffmpeg)?;
        let cfg = csgo.join("cfg").join(format!("{CFG_NAME}.cfg"));
        let line = format!("mirv_script_load \"{}\"\n", director.display().to_string().replace('\\', "/"));
        fs::write(&cfg, line).map_err(|e| format!("{}: {e}", cfg.display()))?;
        let child = std::process::Command::new(&hlae)
            .args(&plan.argv[1..])
            .current_dir(hlae.parent().unwrap_or(Path::new(".")))
            .spawn()
            .map_err(|e| format!("{}: {e}", hlae.display()))?;
        Ok(Launched { pid: child.id(), cfg: cfg.display().to_string(), ffmpeg_ini: ini.map(|p| p.display().to_string()) })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- ffmpeg

/// Options that make FFmpeg read a script or write a file of its own choosing; none of the templates uses them.
const REFUSED: [&str; 9] = ["-filter_script", "-filter_complex_script", "-/filter_complex", "-dump_attachment", "-report", "-vstats_file", "-passlogfile", "-sdp_file", "-progress"];

fn is_absolute_like(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || s.starts_with("\\\\") || s.starts_with('/')
}

fn inside(root: &Path, p: &Path) -> bool {
    p.is_absolute() && !p.components().any(|c| matches!(c, Component::ParentDir)) && p.starts_with(root)
}

/// One level of FFmpeg's unescaping: `\x` is x, text in single quotes is literal. Each char comes with
/// whether it was escaped or quoted, so the caller can tell a separator from a literal one.
fn unescape_level(s: &[(char, bool)]) -> Vec<(char, bool)> {
    let mut out = Vec::new();
    let mut quoted = false;
    let mut i = 0;
    while i < s.len() {
        let (c, lit) = s[i];
        if lit {
            out.push((c, true));
        } else if c == '\'' {
            quoted = !quoted;
        } else if quoted {
            out.push((c, true));
        } else if c == '\\' && i + 1 < s.len() {
            i += 1;
            out.push((s[i].0, true));
        } else {
            out.push((c, false));
        }
        i += 1;
    }
    out
}

/// The paths a filtergraph names (`textfile=` and `fontfile=` values), unescaped as FFmpeg does:
/// once for the graph, once for the filter's options (ffmpeg.ts filterPath). A value ends at an
/// unescaped `:` (the next option) or at the graph's own separators.
fn filter_paths(filter: &str) -> Vec<(String, String)> {
    let raw: Vec<(char, bool)> = filter.chars().map(|c| (c, false)).collect();
    // the graph level keeps its escapes as literal chars; options are split on what stays unescaped
    let graph = unescape_level(&raw);
    let mut out = Vec::new();
    let text: String = graph.iter().map(|(c, _)| *c).collect();
    for key in ["textfile=", "fontfile="] {
        let mut from = 0;
        while let Some(i) = text[from..].find(key) {
            let start = text[..from + i].chars().count() + key.chars().count();
            // the option level: re-escape the graph-literal chars so only option-level escapes remain
            let mut j = start;
            let mut val_chars: Vec<(char, bool)> = Vec::new();
            while j < graph.len() {
                let (c, lit) = graph[j];
                if !lit && matches!(c, ',' | ';' | '[' | ']') {
                    break;
                }
                val_chars.push((c, false));
                j += 1;
            }
            let opt = unescape_level(&val_chars);
            let val: String = opt.iter().take_while(|(c, lit)| *lit || *c != ':').map(|(c, _)| *c).collect();
            out.push((key.trim_end_matches('=').to_string(), val));
            from += i + key.len();
        }
    }
    out
}

/// Checks an FFmpeg argument list from ffmpeg.ts: no option that writes or reads on its own, every
/// absolute path inside the clips folder (a font inside a fonts folder), no `..`, and the last
/// argument, the output, an .mp4 or .png inside the clips folder. FFmpeg runs in the clips folder, so a
/// relative name lands there too.
pub fn check_ffmpeg_args(root: &Path, args: &[String]) -> Result<(), String> {
    let out = args.last().ok_or("no FFmpeg arguments")?;
    if !inside(root, Path::new(out)) || !(out.ends_with(".mp4") || out.ends_with(".png")) {
        return Err(format!("FFmpeg may write only an .mp4 or .png inside the clips folder, not {out}"));
    }
    for (i, a) in args.iter().enumerate() {
        if REFUSED.iter().any(|r| a.eq_ignore_ascii_case(r)) {
            return Err(format!("FFmpeg option {a} is not allowed here"));
        }
        if a.split(['/', '\\']).any(|s| s == "..") {
            return Err(format!("FFmpeg argument {a} steps out of its folder"));
        }
        let lavfi = i >= 2 && args[i - 1] == "-i" && args[i - 2] == "lavfi";
        if is_absolute_like(a) && !lavfi && !inside(root, Path::new(a)) {
            return Err(format!("FFmpeg argument {a} is outside the clips folder"));
        }
        if i > 0 && args[i - 1] == "-filter_complex" {
            for (key, p) in filter_paths(a) {
                let p = Path::new(&p);
                let ok = if key == "fontfile" {
                    p.components().any(|c| c.as_os_str().eq_ignore_ascii_case("fonts")) && !p.components().any(|c| matches!(c, Component::ParentDir))
                } else {
                    inside(root, p)
                };
                if !ok {
                    return Err(format!("the filter's {key} {} is not allowed", p.display()));
                }
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct FfmpegRun {
    code: Option<i32>,
    /// the last 2000 characters FFmpeg wrote to stderr, for a failed run
    error: Option<String>,
}

/// Runs FFmpeg on the clips folder (`args` from ffmpeg.ts, checked by [`check_ffmpeg_args`]), after
/// writing `texts` (the lower third's lines) into `text\`.
#[tauri::command]
pub async fn clips_ffmpeg(args: Vec<String>, texts: Vec<NamedText>, hlae: Option<String>) -> Result<FfmpegRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = clips_dir()?;
        fs::create_dir_all(root.join("text")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("reels")).map_err(|e| e.to_string())?;
        // compare against the folder as FFmpeg will see it: the same spelling the plan used
        check_ffmpeg_args(&root, &args)?;
        for t in &texts {
            if !(t.name.ends_with(".txt") && t.name[..t.name.len() - 4].chars().all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))) {
                return Err(format!("{:?} is not a text file name", t.name));
            }
            fs::write(root.join("text").join(&t.name), &t.text).map_err(|e| e.to_string())?;
        }
        let ffmpeg = find_ffmpeg(hlae.as_deref().map(Path::new))?;
        let out = std::process::Command::new(&ffmpeg).args(&args).current_dir(&root).output().map_err(|e| format!("{}: {e}", ffmpeg.display()))?;
        let err: Vec<char> = String::from_utf8_lossy(&out.stderr).trim().chars().collect();
        let code = out.status.code();
        Ok(FfmpegRun { code, error: (code != Some(0)).then(|| err[err.len().saturating_sub(2000)..].iter().collect()) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cs2stats-clips-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ids_are_checked_before_they_name_a_file() {
        assert!(job_id_ok("job-20261026T180405Z"));
        for bad in ["job-20261026T180405", "job-2026102XT180405Z", "../x", "job-20261026T180405Z/.."] {
            assert!(!job_id_ok(bad), "{bad}");
        }
        assert!(clip_id_ok("c-0123456789abcdef-r12"));
        for bad in ["c-0123456789ABCDEF-r1", "c-0123456789abcdef-r0", "c-0123456789abcdef-r1000", "c-0123-r1", "c-0123456789abcdef-r1/.."] {
            assert!(!clip_id_ok(bad), "{bad}");
        }
        assert!(demo_name_ok("match730_003781274_0123.dem"));
        for bad in ["..\\x.dem", "a b.dem", "x.json", ".dem"] {
            assert!(!demo_name_ok(bad), "{bad}");
        }
    }

    /// A fake HLAE folder and cs2.exe, for the command checks.
    fn tools(root: &Path) -> (PathBuf, PathBuf) {
        let hlae = root.join("HLAE").join("HLAE.exe");
        fs::create_dir_all(hlae.parent().unwrap().join("x64")).unwrap();
        fs::write(&hlae, b"").unwrap();
        fs::write(hlae.parent().unwrap().join("x64").join("AfxHookSource2.dll"), b"").unwrap();
        let cs2 = root.join("game").join("bin").join("win64").join("cs2.exe");
        fs::create_dir_all(cs2.parent().unwrap()).unwrap();
        fs::write(&cs2, b"").unwrap();
        (hlae, cs2)
    }

    fn argv(hlae: &Path, cs2: &Path, game: &str) -> Vec<String> {
        let hook = hlae.parent().unwrap().join("x64").join("AfxHookSource2.dll");
        [
            hlae.display().to_string().as_str(), "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader",
            "-hookDllPath", hook.display().to_string().as_str(), "-programPath", cs2.display().to_string().as_str(), "-cmdLine", game,
        ]
        .map(String::from)
        .to_vec()
    }

    #[test]
    fn the_launch_accepts_only_the_command_the_app_writes() {
        let root = scratch("argv");
        let (hlae, cs2) = tools(&root);
        let good = "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips";
        check_argv(&argv(&hlae, &cs2, good), &cs2).unwrap();
        let refused = |game: &str, want: &str| {
            let e = check_argv(&argv(&hlae, &cs2, game), &cs2).unwrap_err();
            assert!(e.contains(want), "{game}: {e}");
        };
        refused("-novid -insecure +exec cs2stats_clips", "start with -insecure");
        refused("-insecure -secure +exec cs2stats_clips", "turns VAC on");
        refused("-insecure +exec autoexec", "+exec cs2stats_clips");
        refused("-insecure +exec cs2stats_clips +connect 1.2.3.4", "no console command");
        let mut other = argv(&hlae, &cs2, good);
        other[9] = root.join("other.exe").display().to_string();
        fs::write(&other[9], b"").unwrap();
        assert!(check_argv(&other, &cs2).unwrap_err().contains("not this install's"));
        let mut extra = argv(&hlae, &cs2, good);
        extra.insert(1, "-addEnv".into());
        assert!(check_argv(&extra, &cs2).unwrap_err().contains("12 the app writes"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ffmpeg_may_write_only_into_the_clips_folder() {
        let root = scratch("ff");
        let r = |p: &str| root.join(p).display().to_string();
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let ok = s(&["-y", "-i", &r("jobs/job-20261026T180405Z/raw/c-0123456789abcdef-r3/video.mp4"), "-f", "lavfi", "-i", "anullsrc=r=48000", "-filter_complex",
            "[0:v]drawtext=fontfile=C\\\\:/Windows/Fonts/seguisb.ttf:textfile=X[v]", &r("c-0123456789abcdef-r3.mp4")]);
        // the textfile here is not inside the clips folder
        assert!(check_ffmpeg_args(&root, &ok).unwrap_err().contains("textfile"));
        let text = r("text/c.txt").replace('\\', "/").replacen(':', "\\\\:", 1);
        let mut good = ok.clone();
        good[8] = format!("[0:v]drawtext=fontfile=C\\\\:/Windows/Fonts/seguisb.ttf:textfile={text}[v]");
        check_ffmpeg_args(&root, &good).unwrap();
        let mut out = good.clone();
        *out.last_mut().unwrap() = std::env::temp_dir().join("x.mp4").display().to_string();
        assert!(check_ffmpeg_args(&root, &out).unwrap_err().contains("only an .mp4 or .png inside"));
        let mut second = good.clone();
        second.insert(9, std::env::temp_dir().join("y.mp4").display().to_string());
        assert!(check_ffmpeg_args(&root, &second).unwrap_err().contains("outside the clips folder"));
        let mut script = good.clone();
        script.insert(0, "-filter_complex_script".into());
        assert!(check_ffmpeg_args(&root, &script).unwrap_err().contains("not allowed"));
        let mut up = good.clone();
        up[2] = r("../x.mp4");
        assert!(check_ffmpeg_args(&root, &up).unwrap_err().contains("steps out"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn filter_paths_are_read_as_ffmpeg_unescapes_them() {
        // the graph and option escaping ffmpeg.ts filterPath writes for C:/clips/it's [x]/r.txt
        let f = r#"[0:v]drawtext=fontfile=C\\:/Windows/Fonts/seguisb.ttf:textfile=C\\:/clips/it\\\'s \[x\]/r.txt:expansion=none:alpha='if(lt(t,1),0,1)'[v]"#;
        assert_eq!(
            filter_paths(f),
            [("textfile".to_string(), "C:/clips/it's [x]/r.txt".to_string()), ("fontfile".to_string(), "C:/Windows/Fonts/seguisb.ttf".to_string())]
        );
    }

    #[test]
    fn a_scan_lists_finished_clips_reels_and_takes_and_skips_strangers() {
        let root = scratch("scan");
        let id = "c-0123456789abcdef-r3";
        fs::write(root.join(format!("{id}.mp4")), b"x").unwrap();
        fs::write(root.join("notes.mp4"), b"x").unwrap();
        fs::create_dir_all(root.join("reels")).unwrap();
        fs::write(root.join("reels").join("reel-1.mp4"), b"x").unwrap();
        let take = root.join("jobs").join("job-20261026T180405Z").join("raw").join(id);
        fs::create_dir_all(&take).unwrap();
        fs::write(take.join("video.mp4"), b"x").unwrap();
        fs::create_dir_all(root.join("jobs").join("junk").join("raw").join(id)).unwrap();
        let s = scan_in(&root).unwrap();
        assert_eq!(s.finished.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), [id]);
        assert_eq!(s.reels.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["reel-1"]);
        assert_eq!(s.takes.iter().map(|t| (t.id.as_str(), t.job.as_str(), t.audio.is_some())).collect::<Vec<_>>(), [(id, "job-20261026T180405Z", false)]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_job_holds_its_plan_and_director_only() {
        let root = scratch("job");
        let f = |name: &str| NamedText { name: name.into(), text: "x".into() };
        let dir = save_job_in(&root, "job-20261026T180405Z", &[f("plan.json"), f("director.js")]).unwrap();
        assert!(dir.join("plan.json").is_file() && dir.join("raw").is_dir());
        assert!(save_job_in(&root, "job-20261026T180405Z", &[f("../evil.cfg")]).unwrap_err().contains("not \"../evil.cfg\""));
        assert!(save_job_in(&root, "../x", &[]).unwrap_err().contains("not a job id"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hlaes_ffmpeg_ini_is_written_only_when_hlae_has_no_ffmpeg() {
        let root = scratch("ini");
        let (hlae, _) = tools(&root);
        let ff = root.join("ffmpeg.exe");
        let ini = ensure_ffmpeg_ini(&hlae, &ff).unwrap().unwrap();
        assert_eq!(fs::read_to_string(&ini).unwrap(), format!("[Ffmpeg]\nPath={}\n", ff.display()));
        assert_eq!(ensure_ffmpeg_ini(&hlae, &ff).unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }
}
