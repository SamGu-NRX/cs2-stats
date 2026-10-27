//! The clipping service's host side (issue #11, design/clips.md). Everything lives in
//! `%APPDATA%\BotMatchStats\clips`: render jobs in `jobs\<id>` (the plan, the director script and
//! HLAE's raw takes), finished clips as `<clip id>.mp4`, reels in `reels\`, the lower third's text in `text\`.
//!
//! The web view sends typed requests (clip ids, demo file names, ticks, the lower third's text) and
//! never a command, a path to read or an argument. Every command, script and FFmpeg argument is built
//! here: the render job in `job`, the FFmpeg templates in `ffmpeg`. Every path read or written is
//! checked inside its folder with links resolved. Only [`clips_launch`] starts the game, and only
//! when the user confirms in the app: it starts CS2 through HLAE with `-insecure`, which HLAE needs
//! to inject and which keeps VAC off for the session. It has not been run against a live game.

pub mod ffmpeg;
pub mod job;

use crate::botmode::paths::is_reparse;
use crate::botmode::process::cs2_listed;
use crate::botmode::steam::{find_cs2, steam_root};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn clips_dir() -> Result<PathBuf, String> {
    if let Some(d) = std::env::var_os("CS2_CLIPS_DIR") {
        return std::path::absolute(PathBuf::from(d)).map_err(|e| e.to_string());
    }
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not set")?;
    Ok(PathBuf::from(appdata).join("BotMatchStats").join("clips"))
}

/// The clips folder, created, with every link on the way resolved.
fn clips_root() -> Result<PathBuf, String> {
    let d = clips_dir()?;
    fs::create_dir_all(&d).map_err(|e| format!("{}: {e}", d.display()))?;
    Ok(plain(&d.canonicalize().map_err(|e| format!("{}: {e}", d.display()))?))
}

/// A job id as job.rs new_job_id writes it: `job-YYYYMMDDTHHMMSSmmmZ-<6 hex>`.
pub(crate) fn job_id_ok(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("job-") else { return false };
    let b = rest.as_bytes();
    b.len() == 26
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..18].iter().all(u8::is_ascii_digit)
        && &b[18..20] == b"Z-"
        && b[20..].iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// A clip id as clips/ids.ts writes it: `c-<16 hex>-r<round>`.
pub(crate) fn clip_id_ok(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("c-") else { return false };
    let Some((hex, round)) = rest.split_once("-r") else { return false };
    hex.len() == 16
        && hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
        && (1..=3).contains(&round.len())
        && !round.starts_with('0')
        && round.chars().all(|c| c.is_ascii_digit())
}

// ---------------------------------------------------------------- paths
//
// What the confinement below defends, and what it does not (design/clips.md "Threat model"): it keeps
// the web view, a stale or edited plan.json, a link or junction left in the clips folder, and content
// disguised as a take from steering a read or write outside the clips folder or the replays folder.
// It does not defend against another process running as the same user that can already write to
// %APPDATA%\BotMatchStats\clips or to CS2's replays folder: that process can read anything the user can,
// so racing a check against it protects nothing (the same ruling as the packs folder, #41). For the
// same reason the job, raw and replays folders themselves may be junctions: a user can move CS2's
// replays folder with one, and the checks resolve links before comparing.

/// A resolved path without Windows' verbatim prefix (`\\?\C:\x` becomes `C:\x`), so FFmpeg and HLAE
/// read it as written. Other verbatim forms are kept.
pub(crate) fn plain(p: &Path) -> PathBuf {
    let s = p.display().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// `p` with every link resolved, when that lies strictly inside `root` (also resolved).
pub(crate) fn resolved_inside(root: &Path, p: &Path) -> Result<PathBuf, String> {
    let r = plain(&root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?);
    let q = plain(&p.canonicalize().map_err(|e| format!("{}: {e}", p.display()))?);
    if q != r && q.starts_with(&r) {
        Ok(q)
    } else {
        Err(format!("{} resolves to {}, outside {}", p.display(), q.display(), r.display()))
    }
}

/// An existing regular file inside `root`: not itself a link or junction, and inside once every link
/// on the way is resolved. Returns the resolved path.
pub(crate) fn file_inside(root: &Path, p: &Path) -> Result<PathBuf, String> {
    let m = fs::symlink_metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
    if m.file_type().is_symlink() || is_reparse(&m) {
        return Err(format!("{} is a link", p.display()));
    }
    if !m.is_file() {
        return Err(format!("{} is not a regular file", p.display()));
    }
    resolved_inside(root, p)
}

/// The folder `rel` under the clips folder, created, checked to be that folder once links are resolved.
fn folder_in(root: &Path, rel: &[&str]) -> Result<PathBuf, String> {
    let want = rel.iter().fold(root.to_path_buf(), |p, r| p.join(r));
    fs::create_dir_all(&want).map_err(|e| format!("{}: {e}", want.display()))?;
    let got = resolved_inside(root, &want)?;
    if got != want {
        return Err(format!("{} leads to {}", want.display(), got.display()));
    }
    Ok(got)
}

/// A file `name` to write in `dir` (a folder from [`folder_in`]): refused when something other than a
/// regular file is already there under that name, such as a link, or a file with another hard link,
/// which FFmpeg's overwrite would write through.
fn output_in(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let p = dir.join(name);
    match fs::symlink_metadata(&p) {
        Ok(m) if m.file_type().is_symlink() || is_reparse(&m) || !m.is_file() => Err(format!("{} exists and is not a regular file", p.display())),
        Ok(_) if link_count(&p)? > 1 => Err(format!("{} has another hard link", p.display())),
        _ => Ok(p),
    }
}

/// How many directory entries (hard links) name the file at `p`.
#[cfg(windows)]
fn link_count(p: &Path) -> Result<u32, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES};
    let f = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(7)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(p)
        .map_err(|e| format!("{}: {e}", p.display()))?;
    // SAFETY: zeroed plain-data struct filled by the call for a handle `f` owns.
    unsafe {
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(f.as_raw_handle() as HANDLE, &mut info) == 0 {
            return Err(format!("{}: {}", p.display(), std::io::Error::last_os_error()));
        }
        Ok(info.nNumberOfLinks)
    }
}
#[cfg(not(windows))]
fn link_count(p: &Path) -> Result<u32, String> {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(p).map(|m| m.nlink() as u32).map_err(|e| format!("{}: {e}", p.display()))
}

fn file_info(p: &Path) -> Option<(u64, u64)> {
    let m = fs::symlink_metadata(p).ok()?;
    if m.file_type().is_symlink() || is_reparse(&m) || !m.is_file() {
        return None;
    }
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((m.len(), mtime))
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

/// The paths a render job needs on this machine.
fn job_env() -> Result<(job::JobEnv, PathBuf), String> {
    let (csgo, cs2_exe) = cs2_paths()?;
    Ok((job::JobEnv { clips_root: clips_root()?, replays: csgo.join("replays"), cs2_exe }, csgo))
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
    /// the lower third's font, from ffmpeg.rs's fixed list
    font: Option<String>,
}

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
            font: ffmpeg::allowed_font().map(|f| f.display().to_string()),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- demos and outputs

#[derive(Serialize)]
pub struct DemoOnDisk {
    name: String,
    /// the resolved demo, when it is a regular file in the replays folder; null otherwise
    path: Option<String>,
    size: u64,
}

fn demos_in(replays: &Path, names: &[String]) -> Result<Vec<DemoOnDisk>, String> {
    names
        .iter()
        .map(|n| {
            if !job::demo_name_ok(n) {
                return Err(format!("{n:?} is not a demo file name"));
            }
            Ok(match job::resolve_demo(replays, n) {
                Ok(p) => DemoOnDisk { name: n.clone(), size: file_info(&p).map_or(0, |i| i.0), path: Some(p.display().to_string()) },
                Err(_) => DemoOnDisk { name: n.clone(), path: None, size: 0 },
            })
        })
        .collect()
}

/// Which of these demos are in CS2's replays folder, as regular files reached without a link. Reads only.
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
    /// the take folder HLAE made, `take0000` and up (take_name_ok)
    take: String,
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

/// A take folder name as HLAE makes it: `take` and four digits (SuggestTakePath in advancedfx
/// shared/FileTools.cpp, called with 4 digits from AfxHookSource2/RenderSystemDX11Hooks.cpp).
fn take_name_ok(s: &str) -> bool {
    s.len() == 8 && s.starts_with("take") && s[4..].bytes().all(|b| b.is_ascii_digit())
}

/// One recorded take: its folder name, its video and sound, and the video's modified time.
struct TakeFiles {
    name: String,
    video: PathBuf,
    audio: Option<PathBuf>,
    mtime: u64,
}

/// HLAE's files in one take folder, or None when it holds no video yet. HLAE records each
/// `mirv_streams record start` into a new `<record name>\takeNNNN` folder. The screen stream, which
/// the director records, writes into the take folder itself (CAfxStreams::GetStreamFolder,
/// RenderSystemDX11Hooks.cpp); a named stream writes into `take\<stream name>`. The FFmpeg preset
/// names the file video.mp4. The game's sound goes to `take\audio.wav` (the startmovie wav detour in
/// AfxHookSource2/main.cpp). A video of 0 bytes is still being written or failed, so it does not count.
fn take_files(take: &Path) -> Option<TakeFiles> {
    let name = take.file_name()?.to_str()?.to_string();
    let mut subs: Vec<String> = fs::read_dir(take).ok()?.filter_map(|e| e.ok()).filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).filter_map(|e| e.file_name().into_string().ok()).collect();
    subs.sort();
    let video = std::iter::once(take.join("video.mp4"))
        .chain(subs.iter().map(|s| take.join(s).join("video.mp4")))
        .find(|p| file_info(p).is_some_and(|(size, _)| size > 0))?;
    let (_, mtime) = file_info(&video)?;
    let audio = take.join("audio.wav");
    Some(TakeFiles { name, audio: file_info(&audio).map(|_| audio), video, mtime })
}

/// How long a take's files must have gone unchanged before the take counts: they stop changing when
/// HLAE's encoder closes them, and by then CS2 has quit, so this only covers a file system that reports
/// the last write late. Ours; not measured.
const SETTLE: std::time::Duration = std::time::Duration::from_secs(5);

/// The director's console lines for one job, kept beside its takes (`jobs\<job>\session.log`).
const SESSION_LOG: &str = "session.log";

/// Copies each job's block of director lines out of CS2's console.log (`-condebug`), from `director
/// loaded job=<id>` to `ALL DONE job=<id>`, into that job's session.log, when the job's folder exists
/// and has none yet. Only `[cs2stats]` lines are kept. HLAE's script API cannot write files (mirv-script
/// fs.d.ts reads folders only), so the console log is the one record the director leaves; a later CS2
/// session may replace it, so this runs before every launch and every scan. Returns the jobs captured.
fn capture_sessions(root: &Path, console_log: &Path) -> Result<Vec<String>, String> {
    let Ok(text) = fs::read_to_string(console_log) else { return Ok(vec![]) };
    let mut captured = Vec::new();
    let mut block: Option<(String, Vec<String>)> = None;
    for line in text.lines() {
        let Some(at) = line.find("[cs2stats] ") else { continue };
        let ours = line[at..].trim_end().to_string();
        let job_of = |key: &str| ours.split(key).nth(1).map(|r| r.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>());
        if let Some(j) = job_of("director loaded job=") {
            block = Some((j, vec![ours]));
            continue;
        }
        let Some((j, lines)) = block.as_mut() else { continue };
        lines.push(ours.clone());
        if job_of("ALL DONE job=").as_deref() == Some(j.as_str()) {
            let (j, lines) = block.take().unwrap();
            if !job_id_ok(&j) {
                continue;
            }
            let dir = root.join("jobs").join(&j);
            if dir.is_dir() && fs::symlink_metadata(dir.join(SESSION_LOG)).is_err() {
                let dir = folder_in(root, &["jobs", &j])?;
                job::write_together(&dir, &[(SESSION_LOG, (lines.join("\n") + "\n").as_bytes())])?;
                captured.push(j);
            }
        }
    }
    Ok(captured)
}

/// What proves a take complete (design/clips.md "When a take counts"): CS2 is no longer running; the
/// job's session log shows the director ended this clip at its end tick (`END <id> ... why=end_tick`)
/// and then finished the job (`ALL DONE job=<job>`); the take holds a non-empty video.mp4 and the
/// audio.wav the job asked for (it always sets `startMovieWav 1`); and neither file has changed for
/// SETTLE. Otherwise the reason it does not count.
fn take_complete(job_dir: &Path, job_id: &str, id: &str, t: &TakeFiles, cs2_running: bool, now: SystemTime) -> Result<(), String> {
    if cs2_running {
        return Err("CS2 is still running, so the take may still be recording".into());
    }
    let log = file_inside(job_dir, &job_dir.join(SESSION_LOG)).map_err(|_| "the director has not reported this job finished".to_string())?;
    let log = fs::read_to_string(&log).map_err(|e| format!("{}: {e}", log.display()))?;
    let ended = log.lines().any(|l| l.starts_with(&format!("[cs2stats] END {id} ")) && l.contains(" why=end_tick"));
    if !ended {
        return Err("the director did not record this clip to its end tick".into());
    }
    if !log.lines().any(|l| l == format!("[cs2stats] ALL DONE job={job_id}")) {
        return Err("the director did not finish this job".into());
    }
    let audio = t.audio.as_ref().ok_or("the take has no audio.wav")?;
    let settled = |p: &Path| -> bool {
        let Some((size, mtime)) = file_info(p) else { return false };
        let age = now.duration_since(UNIX_EPOCH + std::time::Duration::from_millis(mtime)).unwrap_or_default();
        size > 0 && age >= SETTLE
    };
    if !settled(&t.video) || !settled(audio) {
        return Err("the take's files are empty or still changing".into());
    }
    Ok(())
}

/// The newest complete take of one clip (`raw\<clip id>`): the highest-numbered take folder with a video.
fn newest_take(clip: &Path) -> Option<TakeFiles> {
    let mut takes: Vec<String> = fs::read_dir(clip).ok()?.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| take_name_ok(n)).collect();
    takes.sort();
    takes.iter().rev().find_map(|t| take_files(&clip.join(t)))
}

/// A file to read inside `root` ([`file_inside`]) that has no other hard link, which could make a
/// file elsewhere readable through the clips folder.
fn input_inside(root: &Path, p: &Path) -> Result<PathBuf, String> {
    let q = file_inside(root, p)?;
    if link_count(&q)? > 1 {
        return Err(format!("{} has another hard link", p.display()));
    }
    Ok(q)
}

fn scan_in(root: &Path, cs2_running: bool, now: SystemTime) -> Result<ClipsScan, String> {
    let mut out = ClipsScan { finished: vec![], takes: vec![], reels: vec![] };
    let names = |d: &Path| -> Vec<String> {
        fs::read_dir(d).map(|r| r.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect()).unwrap_or_default()
    };
    for n in names(root) {
        if let Some(id) = n.strip_suffix(".mp4").filter(|id| clip_id_ok(id)) {
            let p = root.join(&n);
            // a clip is renamed into place only after FFmpeg exits cleanly (run_render); an empty file is not one
            if let Some((size @ 1.., mtime)) = file_info(&p) {
                out.finished.push(Finished { id: id.into(), path: p.display().to_string(), size, mtime });
            }
        }
    }
    for n in names(&root.join("reels")) {
        let p = root.join("reels").join(&n);
        if let (true, Some((size @ 1.., mtime))) = (n.ends_with(".mp4") && !n.starts_with('.'), file_info(&p)) {
            out.reels.push(Finished { id: n.trim_end_matches(".mp4").into(), path: p.display().to_string(), size, mtime });
        }
    }
    for job in names(&root.join("jobs")).into_iter().filter(|j| job_id_ok(j)) {
        let raw = root.join("jobs").join(&job).join("raw");
        for id in names(&raw).into_iter().filter(|i| clip_id_ok(i)) {
            let Some(t) = newest_take(&raw.join(&id)) else { continue };
            if take_complete(&root.join("jobs").join(&job), &job, &id, &t, cs2_running, now).is_ok() {
                out.takes.push(Take { id, job: job.clone(), take: t.name, video: t.video.display().to_string(), audio: t.audio.map(|a| a.display().to_string()), mtime: t.mtime });
            }
        }
    }
    out.finished.sort_by(|a, b| a.id.cmp(&b.id));
    out.reels.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out.takes.sort_by(|a, b| (&a.id, &a.job).cmp(&(&b.id, &b.job)));
    Ok(out)
}

/// The clips folder's finished clips, reels and HLAE's raw takes. Reads only; links are not listed.
#[tauri::command]
pub async fn clips_scan() -> Result<ClipsScan, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = clips_root()?;
        if let Ok((csgo, _)) = cs2_paths() {
            capture_sessions(&root, &csgo.join("console.log"))?;
        }
        scan_in(&root, !cs2_listed()?.is_empty(), SystemTime::now())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- jobs

/// Builds the render job for the chosen clips and, when `write`, saves it as a new job folder. The
/// plan comes back either way, for the dialog to show; nothing touches the game.
#[tauri::command]
pub async fn clips_plan(request: job::JobReq, write: bool) -> Result<job::Plan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (env, _) = job_env()?;
        let (id, created) = job::new_job_id(SystemTime::now());
        let (plan, script) = job::build(&request, &env, &id, &created)?;
        if write {
            job::save(&plan, &script)?;
        }
        Ok(plan)
    })
    .await
    .map_err(|e| e.to_string())?
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
    job::write_together(&dir, &[("ffmpeg.ini", format!("[Ffmpeg]\nPath={}\n", ffmpeg.display()).as_bytes())])?;
    Ok(Some(ini))
}

/// The saved job `id`, built again from its own request: refused when its plan.json differs from that
/// in any way (an edited command, demo, folder or clip). Its director is written again from the build,
/// so an edited director.js never runs.
fn rebuild_saved(env: &job::JobEnv, id: &str) -> Result<job::Plan, String> {
    if !job_id_ok(id) {
        return Err(format!("{id:?} is not a job id"));
    }
    let dir = folder_in(&env.clips_root, &["jobs", id])?;
    let plan_path = file_inside(&dir, &dir.join("plan.json"))?;
    let text = fs::read_to_string(&plan_path).map_err(|e| format!("{}: {e}", plan_path.display()))?;
    let saved: job::Plan = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", plan_path.display()))?;
    if saved.id != id {
        return Err(format!("{} names another job ({})", plan_path.display(), saved.id));
    }
    let (plan, script) = job::build(&saved.request, env, id, &saved.created)?;
    if plan != saved {
        return Err(format!("{} differs from the plan the app builds from its own request; save the plan again", plan_path.display()));
    }
    job::write_together(&dir, &[("director.js", script.as_bytes())])?;
    Ok(plan)
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
/// It rebuilds the job from its request ([`rebuild_saved`]) and refuses while any cs2.exe runs. Then
/// it writes `game\csgo\cfg\cs2stats_clips.cfg` (the line that loads the job's director), writes
/// HLAE's ffmpeg.ini when HLAE has no FFmpeg of its own, and starts the rebuilt command without
/// waiting for it. Untested against a live game.
#[tauri::command]
pub async fn clips_launch(job: String) -> Result<Launched, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (env, csgo) = job_env()?;
        // the console log of an earlier job is replaced by this session's; keep its director lines first
        capture_sessions(&env.clips_root, &csgo.join("console.log"))?;
        let plan = rebuild_saved(&env, &job)?;
        if let Some(p) = cs2_listed()?.first() {
            return Err(format!("CS2 is running (process {}). Close it, then render again.", p.pid));
        }
        let hlae = PathBuf::from(&plan.argv[0]);
        let ffmpeg = find_ffmpeg(Some(&hlae))?;
        let ini = ensure_ffmpeg_ini(&hlae, &ffmpeg)?;
        let cfg = csgo.join("cfg").join(&plan.cfg_file);
        job::write_together(cfg.parent().ok_or("CS2 has no cfg folder")?, &[(plan.cfg_file.as_str(), plan.cfg_text.as_bytes())])?;
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

// ---------------------------------------------------------------- finishing and reels

/// One line of the lower third: at most 200 characters, no control characters.
fn lower_third_line(s: &str) -> Result<&str, String> {
    if s.chars().count() > 200 || s.chars().any(char::is_control) {
        return Err("the lower third's text must be one line of at most 200 characters".into());
    }
    Ok(s)
}

/// Builds the finishing command for clip `id`'s take in job `job`: the take resolved inside the clips
/// folder, the two lines written to `text\` by this function, the font from the fixed list, the
/// output `<id>.mp4` in the clips folder.
#[allow(clippy::too_many_arguments)]
/// An FFmpeg run that writes `part`, renamed over `out` only after a clean exit (run_render).
#[derive(Debug)]
struct Render {
    args: Vec<String>,
    part: PathBuf,
    out: PathBuf,
}

/// Whether CS2 runs and the time now, which decide whether a take is complete (take_complete).
struct Gate {
    cs2_running: bool,
    now: SystemTime,
}

#[allow(clippy::too_many_arguments)]
fn finish_command(root: &Path, font: &Path, id: &str, job_id: &str, take: &str, reason: &str, subline: &str, duration_s: f64, gate: &Gate) -> Result<Render, String> {
    if !clip_id_ok(id) || !job_id_ok(job_id) || !take_name_ok(take) {
        return Err(format!("{id:?} in {job_id:?}, {take:?} is not a take of a clip of a job"));
    }
    if !(duration_s.is_finite() && duration_s > 0.0 && duration_s <= 600.0) {
        return Err(format!("a clip of {duration_s} s"));
    }
    let dir = root.join("jobs").join(job_id).join("raw").join(id).join(take);
    let files = take_files(&dir).ok_or_else(|| format!("{} holds no recorded video", dir.display()))?;
    let video = input_inside(root, &files.video)?;
    let audio = files.audio.as_ref().map(|a| input_inside(root, a)).transpose()?;
    take_complete(&root.join("jobs").join(job_id), job_id, id, &files, gate.cs2_running, gate.now).map_err(|e| format!("{}: not finished recording: {e}", dir.display()))?;
    // every target is checked before anything is written, so a refusal leaves nothing behind
    let text = folder_in(root, &["text"])?;
    let (rn, sn) = (format!("{id}.txt"), format!("{id}-sub.txt"));
    let reason_file = output_in(&text, &rn)?;
    let sub_file = output_in(&text, &sn)?;
    let out = output_in(root, &format!("{id}.mp4"))?;
    let (reason, subline) = (lower_third_line(reason)?, lower_third_line(subline)?);
    job::write_together(&text, &[(rn.as_str(), reason.as_bytes()), (sn.as_str(), subline.as_bytes())])?;
    let part = job::new_part(root, &format!("{id}.mp4"))?;
    let args = ffmpeg::finish_args(&ffmpeg::FinishSpec {
        video: &video, audio: audio.as_deref(), reason_file: &reason_file, subline_file: &sub_file, font,
        start_s: 0.0, duration_s, width: job::WIDTH, height: job::HEIGHT, fps: job::FPS, out: &part,
    })
    .and_then(|a| ffmpeg::check_built(&a).map(|_| a))
    .inspect_err(|_| { let _ = fs::remove_file(&part); })?;
    Ok(Render { args, part, out })
}

/// Builds the reel command for finished clips `ids`, in order, into `reels\<name>`.
fn reel_command(root: &Path, ids: &[String], name: &str) -> Result<Render, String> {
    let clips = ids
        .iter()
        .map(|id| if clip_id_ok(id) { input_inside(root, &root.join(format!("{id}.mp4"))) } else { Err(format!("{id:?} is not a clip id")) })
        .collect::<Result<Vec<_>, _>>()?;
    let reels = folder_in(root, &["reels"])?;
    let out = output_in(&reels, name)?;
    if clips.len() < 2 {
        return Err(format!("FFmpeg template: a reel needs two clips or more, got {}", clips.len()));
    }
    let part = job::new_part(&reels, name)?;
    let args = ffmpeg::reel_args(&clips, &part)
        .and_then(|a| ffmpeg::check_built(&a).map(|_| a))
        .inspect_err(|_| { let _ = fs::remove_file(&part); })?;
    Ok(Render { args, part, out })
}

#[derive(Serialize)]
pub struct FfmpegRun {
    code: Option<i32>,
    /// the last 2000 characters FFmpeg wrote to stderr, for a failed run
    error: Option<String>,
    output: String,
}

/// Runs a render with `exec` (FFmpeg's exit code and stderr) and settles its part file: renamed over the
/// output only after exit code 0 with a non-empty file, else removed, so a failed or cut-off run never
/// replaces a good clip or stands as one.
fn run_render(r: &Render, exec: impl FnOnce(&[String]) -> Result<(Option<i32>, String), String>) -> Result<FfmpegRun, String> {
    let ran = exec(&r.args);
    let ok = matches!(ran, Ok((Some(0), _))) && file_info(&r.part).is_some_and(|(size, _)| size > 0);
    if !ok {
        let _ = fs::remove_file(&r.part);
    }
    let (code, stderr) = ran.inspect_err(|_| { let _ = fs::remove_file(&r.part); })?;
    if ok {
        fs::rename(&r.part, &r.out).map_err(|e| {
            let _ = fs::remove_file(&r.part);
            format!("{}: {e}", r.out.display())
        })?;
        return Ok(FfmpegRun { code, error: None, output: r.out.display().to_string() });
    }
    let err: Vec<char> = stderr.trim().chars().collect();
    let tail: String = err[err.len().saturating_sub(2000)..].iter().collect();
    Ok(FfmpegRun { code: if code == Some(0) { None } else { code }, error: Some(if code == Some(0) { "FFmpeg exited cleanly but wrote nothing".into() } else { tail }), output: String::new() })
}

/// Runs FFmpeg from the clips folder on a built render.
fn run_ffmpeg(root: &Path, r: &Render, hlae: Option<&str>) -> Result<FfmpegRun, String> {
    let ffmpeg = find_ffmpeg(hlae.map(Path::new))?;
    run_render(r, |args| {
        let out = std::process::Command::new(&ffmpeg)
            .args(args)
            .current_dir(root)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("{}: {e}", ffmpeg.display()))?;
        Ok((out.status.code(), String::from_utf8_lossy(&out.stderr).into_owned()))
    })
}

/// Finishes HLAE's take `take` of clip `id` from job `job` into `<id>.mp4`: trimmed to `duration_s`, the
/// lower third's two lines (`reason`, `subline`; the app hides personal info in them first) drawn in.
#[tauri::command]
pub async fn clips_finish(id: String, job: String, take: String, reason: String, subline: String, duration_s: f64, hlae: Option<String>) -> Result<FfmpegRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = clips_root()?;
        let font = ffmpeg::allowed_font().ok_or("No font for the lower third was found (Segoe UI or Arial in Windows' Fonts folder)")?;
        let gate = Gate { cs2_running: !cs2_listed()?.is_empty(), now: SystemTime::now() };
        let render = finish_command(&root, &font, &id, &job, &take, &reason, &subline, duration_s, &gate)?;
        run_ffmpeg(&root, &render, hlae.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Joins finished clips `ids`, in order, into a new reel in `reels\`.
#[tauri::command]
pub async fn clips_reel(ids: Vec<String>, hlae: Option<String>) -> Result<FfmpegRun, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = clips_root()?;
        let (stamp, _) = job::new_job_id(SystemTime::now());
        let render = reel_command(&root, &ids, &format!("reel-{}.mp4", stamp.trim_start_matches("job-")))?;
        run_ffmpeg(&root, &render, hlae.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOB: &str = "job-20261026T180405123Z-a1b2c3";
    const CLIP: &str = "c-0123456789abcdef-r3";

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scratch(tag: &str) -> Scratch {
        let d = std::env::temp_dir().join(format!("cs2stats-clips-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        Scratch(plain(&d.canonicalize().unwrap()))
    }

    #[cfg(windows)]
    fn link(target: &Path, at: &Path) {
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(at).arg(target).output().unwrap().status.success();
        assert!(ok, "mklink /J failed");
    }
    #[cfg(not(windows))]
    fn link(target: &Path, at: &Path) {
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    #[test]
    fn ids_are_checked_before_they_name_a_file() {
        assert!(job_id_ok(JOB));
        for bad in ["job-20261026T180405Z", "job-20261026T180405123Z-A1B2C3", "job-20261026T180405123Z-a1b2c", "../x", "job-20261026T180405123Z-a1b2c3/.."] {
            assert!(!job_id_ok(bad), "{bad}");
        }
        assert!(clip_id_ok(CLIP));
        for bad in ["c-0123456789ABCDEF-r1", "c-0123456789abcdef-r0", "c-0123456789abcdef-r1000", "c-0123-r1", "c-0123456789abcdef-r1/.."] {
            assert!(!clip_id_ok(bad), "{bad}");
        }
        assert!(job::demo_name_ok("match730_003781274_0123.dem"));
        for bad in ["..\\x.dem", "a b.dem", "x.json", ".dem"] {
            assert!(!job::demo_name_ok(bad), "{bad}");
        }
    }

    const TAKE: &str = "take0000";

    /// CS2 has quit, now.
    fn gate() -> Gate {
        Gate { cs2_running: false, now: SystemTime::now() }
    }

    /// Sets a file's last write a minute back, past SETTLE.
    fn settle(p: &Path) {
        fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(SystemTime::now() - std::time::Duration::from_secs(60)).unwrap();
    }

    /// The director's session log for JOB, as capture_sessions keeps it: CLIP recorded to its end tick, the job finished.
    fn session(root: &Path, why: &str) {
        let dir = root.join("jobs").join(JOB);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SESSION_LOG), format!("[cs2stats] director loaded job={JOB}: 1 demos\n[cs2stats] END {CLIP} tick=2000 why={why}\n[cs2stats] ALL DONE job={JOB}\n")).unwrap();
    }

    /// A complete take as HLAE lays one out: the screen stream's video in the take folder, the sound
    /// beside it, both settled, and the director's log saying it recorded the clip and finished.
    fn take(root: &Path) {
        let t = root.join("jobs").join(JOB).join("raw").join(CLIP).join(TAKE);
        fs::create_dir_all(&t).unwrap();
        fs::write(t.join("video.mp4"), b"v").unwrap();
        fs::write(t.join("audio.wav"), b"a").unwrap();
        settle(&t.join("video.mp4"));
        settle(&t.join("audio.wav"));
        session(root, "end_tick");
    }

    #[test]
    fn a_take_counts_only_after_the_director_ends_it_and_cs2_has_quit() {
        let s = scratch("complete");
        let root = &s.0;
        let t = root.join("jobs").join(JOB).join("raw").join(CLIP).join(TAKE);
        fs::create_dir_all(&t).unwrap();
        fs::write(t.join("video.mp4"), b"v").unwrap();
        let listed = |running: bool| scan_in(root, running, SystemTime::now()).unwrap().takes.len();
        let finish = |running: bool| finish_command(root, &root.join("f.ttf"), CLIP, JOB, TAKE, "r", "s", 3.0, &Gate { cs2_running: running, now: SystemTime::now() });
        // a growing video, with no sound yet and no word from the director: not recorded
        assert_eq!(listed(false), 0);
        assert!(finish(false).unwrap_err().contains("not finished recording"));
        // the director's lines reach the job through CS2's console log, once it has said ALL DONE
        let console = root.join("console.log");
        fs::write(&console, format!("noise\n[cs2stats] director loaded job={JOB}: 1 demos\n[cs2stats] START {CLIP} tick=1000\n")).unwrap();
        assert_eq!(capture_sessions(root, &console).unwrap(), Vec::<String>::new());
        fs::write(&console, format!("noise\n00:01 [cs2stats] director loaded job={JOB}: 1 demos\n[cs2stats] END {CLIP} tick=2000 why=end_tick\nmore noise\n[cs2stats] ALL DONE job={JOB}\n")).unwrap();
        assert_eq!(capture_sessions(root, &console).unwrap(), [JOB]);
        let log = fs::read_to_string(root.join("jobs").join(JOB).join(SESSION_LOG)).unwrap();
        assert!(!log.contains("noise") && log.contains(&format!("[cs2stats] END {CLIP} tick=2000 why=end_tick")));
        // still no sound, then sound still being written, then CS2 still running: not yet
        assert_eq!(listed(false), 0);
        fs::write(t.join("audio.wav"), b"a").unwrap();
        assert_eq!(listed(false), 0);
        settle(&t.join("video.mp4"));
        settle(&t.join("audio.wav"));
        assert_eq!((listed(true), listed(false)), (0, 1));
        assert!(finish(true).unwrap_err().contains("CS2 is still running"));
        finish(false).unwrap();
        // a clip the director stopped early (the camera left the player) is not a recording of the moment
        session(root, "camera_lost");
        assert_eq!(listed(false), 0);
    }

    #[test]
    fn a_failed_render_leaves_the_old_clip_and_no_part_file() {
        let s = scratch("render");
        let root = &s.0;
        take(root);
        let out = root.join(format!("{CLIP}.mp4"));
        fs::write(&out, b"the good clip").unwrap();
        let parts = || fs::read_dir(root).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".part.mp4")).count();
        let render = || finish_command(root, &root.join("f.ttf"), CLIP, JOB, TAKE, "r", "s", 3.0, &gate()).unwrap();
        // FFmpeg writes half a file and fails: the old clip stays, the part goes
        let r = render();
        assert_eq!((r.args.last().unwrap(), &r.out), (&r.part.display().to_string(), &out));
        let run = run_render(&r, |args| { fs::write(args.last().unwrap(), b"half").unwrap(); Ok((Some(1), "boom".into())) }).unwrap();
        assert_eq!((run.code, run.error.as_deref(), fs::read(&out).unwrap(), parts()), (Some(1), Some("boom"), b"the good clip".to_vec(), 0));
        // a clean exit that wrote nothing counts as a failure too
        let r = render();
        let run = run_render(&r, |_| Ok((Some(0), String::new()))).unwrap();
        assert_eq!((run.error.is_some(), fs::read(&out).unwrap(), parts()), (true, b"the good clip".to_vec(), 0));
        // FFmpeg could not start: nothing changes either
        let r = render();
        assert!(run_render(&r, |_| Err("no ffmpeg".into())).is_err());
        assert_eq!((fs::read(&out).unwrap(), parts()), (b"the good clip".to_vec(), 0));
        // a clean, non-empty run replaces the clip
        let r = render();
        let run = run_render(&r, |args| { fs::write(args.last().unwrap(), b"the new clip").unwrap(); Ok((Some(0), String::new())) }).unwrap();
        assert_eq!((run.code, run.output, fs::read(&out).unwrap(), parts()), (Some(0), out.display().to_string(), b"the new clip".to_vec(), 0));
    }

    #[test]
    fn the_newest_complete_take_is_found_in_hlaes_take_folders() {
        let s = scratch("takes");
        let clip = s.0.join("jobs").join(JOB).join("raw").join(CLIP);
        let mk = |rel: &str, bytes: &[u8]| {
            let p = clip.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, bytes).unwrap();
        };
        // take0000: the screen stream in the take folder; take0001: a named stream's folder with the
        // sound in the take; take0002: a video still empty; notes: not a take
        mk("take0000/video.mp4", b"v0");
        mk("take0001/screen/video.mp4", b"v1");
        mk("take0001/audio.wav", b"a1");
        mk("take0002/video.mp4", b"");
        mk("notes/video.mp4", b"x");
        let t = newest_take(&clip).unwrap();
        assert_eq!((t.name.as_str(), t.video.clone(), t.audio.clone()), ("take0001", clip.join("take0001").join("screen").join("video.mp4"), Some(clip.join("take0001").join("audio.wav"))));
        for p in ["take0000/video.mp4", "take0001/screen/video.mp4", "take0001/audio.wav"] {
            settle(&clip.join(p));
        }
        session(&s.0, "end_tick");
        let scan = scan_in(&s.0, false, SystemTime::now()).unwrap();
        assert_eq!(scan.takes.iter().map(|t| (t.take.as_str(), t.audio.is_some())).collect::<Vec<_>>(), [("take0001", true)]);
        // finishing names its take, and reads that take's files only
        let args = finish_command(&s.0, &s.0.join("f.ttf"), CLIP, JOB, "take0001", "r", "s", 3.0, &gate()).unwrap().args;
        assert!(args.contains(&clip.join("take0001").join("screen").join("video.mp4").display().to_string()));
        assert!(args.contains(&clip.join("take0001").join("audio.wav").display().to_string()));
        assert!(finish_command(&s.0, &s.0.join("f.ttf"), CLIP, JOB, "take0002", "r", "s", 3.0, &gate()).unwrap_err().contains("no recorded video"));
        for bad in ["../take0001", "take01", "takeABCD"] {
            assert!(finish_command(&s.0, &s.0.join("f.ttf"), CLIP, JOB, bad, "r", "s", 3.0, &gate()).unwrap_err().contains("is not a take"), "{bad}");
        }
    }

    #[test]
    fn a_take_file_with_another_hard_link_is_not_read() {
        let s = scratch("takelink");
        take(&s.0);
        let elsewhere = s.0.join("elsewhere.mp4");
        fs::write(&elsewhere, b"secret").unwrap();
        let v = s.0.join("jobs").join(JOB).join("raw").join(CLIP).join(TAKE).join("video.mp4");
        fs::remove_file(&v).unwrap();
        fs::hard_link(&elsewhere, &v).unwrap();
        let e = finish_command(&s.0, &s.0.join("f.ttf"), CLIP, JOB, TAKE, "r", "s", 3.0, &gate()).unwrap_err();
        assert!(e.contains("another hard link"), "{e}");
    }

    #[test]
    fn finishing_reads_only_the_take_and_writes_the_text_and_clip_into_the_clips_folder() {
        let s = scratch("finish");
        let root = &s.0;
        take(root);
        let font = root.join("font.ttf");
        let r = finish_command(root, &font, CLIP, JOB, TAKE, "3K on B Site, +38% round impact", "Mirage · Round 14", 3.0, &gate()).unwrap();
        let args = &r.args;
        let take = root.join("jobs").join(JOB).join("raw").join(CLIP).join(TAKE);
        assert_eq!(args.iter().filter(|a| a.as_str() == "-i").count(), 2);
        assert!(args.contains(&take.join("video.mp4").display().to_string()) && args.contains(&take.join("audio.wav").display().to_string()));
        // FFmpeg writes a part file beside the clip, renamed over it only after a clean run (run_render)
        assert_eq!((args.last().unwrap(), &r.out), (&r.part.display().to_string(), &root.join(format!("{CLIP}.mp4"))));
        assert!(r.part.parent() == Some(root.as_path()) && r.part.file_name().unwrap().to_string_lossy().ends_with(".part.mp4"));
        // the text reaches drawtext only through files written into text\, never inline
        let filter = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        assert!(!filter.contains("round impact") && filter.contains(&ffmpeg::filter_path(&root.join("text").join(format!("{CLIP}.txt")))));
        assert_eq!(fs::read_to_string(root.join("text").join(format!("{CLIP}.txt"))).unwrap(), "3K on B Site, +38% round impact");
        // refused: a bad id, a missing take, text that is not one line, a clip of no length
        assert!(finish_command(root, &font, "../x", JOB, TAKE, "r", "s", 3.0, &gate()).is_err());
        assert!(finish_command(root, &font, "c-0123456789abcdef-r4", JOB, TAKE, "r", "s", 3.0, &gate()).is_err());
        assert!(finish_command(root, &font, CLIP, JOB, TAKE, "a\nb", "s", 3.0, &gate()).unwrap_err().contains("one line"));
        assert!(finish_command(root, &font, CLIP, JOB, TAKE, "r", "s", 0.0, &gate()).is_err());
    }

    #[test]
    fn a_take_or_output_that_is_a_link_is_refused() {
        let s = scratch("links");
        let root = &s.0;
        let outside = root.join("..").join(format!("cs2stats-clips-outside-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(outside.join(TAKE)).unwrap();
        fs::write(outside.join(TAKE).join("video.mp4"), b"secret").unwrap();
        // the take's folder is a junction to a folder outside the clips folder
        let raw = root.join("jobs").join(JOB).join("raw");
        fs::create_dir_all(&raw).unwrap();
        link(&outside, &raw.join(CLIP));
        let e = finish_command(root, &root.join("f.ttf"), CLIP, JOB, TAKE, "r", "s", 3.0, &gate()).unwrap_err();
        assert!(e.contains("outside"), "{e}");
        // a finished clip's name taken by a link
        link(&outside, &root.join(format!("{CLIP}.mp4")));
        assert!(reel_command(root, &[CLIP.into(), CLIP.into()], "r.mp4").unwrap_err().contains("link"));
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn an_output_or_lower_third_with_another_hard_link_is_refused() {
        let s = scratch("hardlink");
        let root = &s.0;
        take(root);
        let elsewhere = root.join("elsewhere.txt");
        fs::write(&elsewhere, b"keep").unwrap();
        // the clip's output name is a second hard link to another file
        fs::hard_link(&elsewhere, root.join(format!("{CLIP}.mp4"))).unwrap();
        let e = finish_command(root, &root.join("f.ttf"), CLIP, JOB, TAKE, "r", "s", 3.0, &gate()).unwrap_err();
        assert!(e.contains("another hard link"), "{e}");
        assert!(!root.join("text").join(format!("{CLIP}.txt")).exists(), "a refused finish wrote its text");
        fs::remove_file(root.join(format!("{CLIP}.mp4"))).unwrap();
        // the lower third's text file, likewise
        fs::create_dir_all(root.join("text")).unwrap();
        fs::hard_link(&elsewhere, root.join("text").join(format!("{CLIP}.txt"))).unwrap();
        let e = finish_command(root, &root.join("f.ttf"), CLIP, JOB, TAKE, "r", "s", 3.0, &gate()).unwrap_err();
        assert!(e.contains("another hard link"), "{e}");
        assert_eq!(fs::read(&elsewhere).unwrap(), b"keep");
        // a plain file of that name is replaced, not written through
        fs::remove_file(root.join("text").join(format!("{CLIP}.txt"))).unwrap();
        fs::write(root.join("text").join(format!("{CLIP}.txt")), b"old").unwrap();
        finish_command(root, &root.join("f.ttf"), CLIP, JOB, TAKE, "new", "s", 3.0, &gate()).unwrap();
        assert_eq!(fs::read_to_string(root.join("text").join(format!("{CLIP}.txt"))).unwrap(), "new");
    }

    #[test]
    fn a_reel_joins_finished_clips_inside_the_clips_folder_only() {
        let s = scratch("reel");
        let root = &s.0;
        let b = "c-0123456789abcdef-r9";
        for id in [CLIP, b] {
            fs::write(root.join(format!("{id}.mp4")), b"x").unwrap();
        }
        let r = reel_command(root, &[CLIP.into(), b.into()], "reel-1.mp4").unwrap();
        assert_eq!((r.args.last().unwrap(), r.out.clone()), (&r.part.display().to_string(), root.join("reels").join("reel-1.mp4")));
        assert!(reel_command(root, &["../../x".into(), b.into()], "r.mp4").unwrap_err().contains("not a clip id"));
        assert!(reel_command(root, &[CLIP.into()], "r.mp4").unwrap_err().contains("two clips or more"));
    }

    #[test]
    fn a_scan_lists_finished_clips_reels_and_takes_and_skips_strangers() {
        let s = scratch("scan");
        let root = &s.0;
        fs::write(root.join(format!("{CLIP}.mp4")), b"x").unwrap();
        fs::write(root.join("notes.mp4"), b"x").unwrap();
        fs::create_dir_all(root.join("reels")).unwrap();
        fs::write(root.join("reels").join("reel-1.mp4"), b"x").unwrap();
        take(root);
        fs::create_dir_all(root.join("jobs").join("junk").join("raw").join(CLIP)).unwrap();
        // an empty clip and a part file are not finished clips
        fs::write(root.join("c-0123456789abcdef-r4.mp4"), b"").unwrap();
        fs::write(root.join(format!(".{CLIP}.0123456789abcdef.part.mp4")), b"x").unwrap();
        fs::write(root.join("reels").join(".reel-2.0123456789abcdef.part.mp4"), b"x").unwrap();
        fs::write(root.join("reels").join("reel-3.mp4"), b"").unwrap();
        let s = scan_in(root, false, SystemTime::now()).unwrap();
        assert_eq!(s.finished.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), [CLIP]);
        assert_eq!(s.reels.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["reel-1"]);
        assert_eq!(s.takes.iter().map(|t| (t.id.as_str(), t.job.as_str(), t.take.as_str(), t.audio.is_some())).collect::<Vec<_>>(), [(CLIP, JOB, TAKE, true)]);
    }

    /// A machine with a saved job, for the launch's rebuild check.
    fn saved_job(s: &Scratch) -> (job::JobEnv, job::Plan) {
        let root = &s.0;
        let replays = root.join("replays");
        fs::create_dir_all(&replays).unwrap();
        fs::write(replays.join("match730_0001.dem"), job::fake_demo(100_000)).unwrap();
        let cs2 = root.join("bin").join("cs2.exe");
        fs::create_dir_all(cs2.parent().unwrap()).unwrap();
        fs::write(&cs2, b"").unwrap();
        let hlae = root.join("HLAE").join("HLAE.exe");
        fs::create_dir_all(hlae.parent().unwrap().join("x64")).unwrap();
        fs::write(&hlae, b"").unwrap();
        fs::write(hlae.parent().unwrap().join("x64").join("AfxHookSource2.dll"), b"").unwrap();
        let clips = root.join("clips");
        fs::create_dir_all(&clips).unwrap();
        let env = job::JobEnv { clips_root: clips, replays, cs2_exe: cs2 };
        let req = job::JobReq {
            clips: vec![job::ClipReq { id: job::clip_id_for("match730_0001.dem", "76561190000000001", 3).unwrap(), demo: "match730_0001.dem".into(), steamid: "76561190000000001".into(), round: 3, start_tick: 1000, end_tick: 2000, tick_rate: 64.0, reason: "r".into() }],
            hlae: hlae.display().to_string(),
        };
        let (plan, script) = job::build(&req, &env, JOB, "2026-10-26T18:04:05.123Z").unwrap();
        job::save(&plan, &script).unwrap();
        (env, plan)
    }

    #[test]
    fn the_launch_rebuilds_the_saved_job_and_refuses_a_tampered_plan() {
        let s = scratch("tamper");
        let (env, plan) = saved_job(&s);
        let dir = PathBuf::from(&plan.job_dir);
        // an edited director is replaced by the rebuilt one
        fs::write(dir.join("director.js"), "mirv.exec('quit')").unwrap();
        assert_eq!(rebuild_saved(&env, JOB).unwrap(), plan);
        assert!(fs::read_to_string(dir.join("director.js")).unwrap().contains("[cs2stats]"));
        let tamper = |edit: &dyn Fn(&mut job::Plan)| {
            let mut p = plan.clone();
            edit(&mut p);
            fs::write(dir.join("plan.json"), serde_json::to_string(&p).unwrap()).unwrap();
            rebuild_saved(&env, JOB)
        };
        // an extra game flag after -insecure, another program, another cfg line
        let extra = tamper(&|p| p.argv[11] = "-insecure -novid +exec cs2stats_clips -allow_third_party_software".into()).unwrap_err();
        assert!(extra.contains("differs from the plan"), "{extra}");
        assert!(tamper(&|p| p.argv[9] = "C:\\Windows\\notepad.exe".into()).unwrap_err().contains("differs"));
        assert!(tamper(&|p| p.cfg_text = "exec autoexec\n".into()).unwrap_err().contains("differs"));
        // a request that names a demo outside the replays folder fails the rebuild itself
        let outside = tamper(&|p| { p.request.clips[0].demo = "..\\..\\secret.dem".into(); }).unwrap_err();
        assert!(outside.contains("not a demo file name"), "{outside}");
        // the original plan launches again
        fs::write(dir.join("plan.json"), serde_json::to_string(&plan).unwrap()).unwrap();
        assert_eq!(rebuild_saved(&env, JOB).unwrap(), plan);
    }

    #[test]
    fn hlaes_ffmpeg_ini_is_written_only_when_hlae_has_no_ffmpeg() {
        let s = scratch("ini");
        let hlae = s.0.join("HLAE").join("HLAE.exe");
        fs::create_dir_all(hlae.parent().unwrap()).unwrap();
        let ff = s.0.join("ffmpeg.exe");
        let ini = ensure_ffmpeg_ini(&hlae, &ff).unwrap().unwrap();
        assert_eq!(fs::read_to_string(&ini).unwrap(), format!("[Ffmpeg]\nPath={}\n", ff.display()));
        assert_eq!(ensure_ffmpeg_ini(&hlae, &ff).unwrap(), None);
    }
}
