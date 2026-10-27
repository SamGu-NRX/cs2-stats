//! A render job, built here and only here from a typed request: the clips (id, demo file name,
//! SteamID64, ticks), and the HLAE.exe the user chose. The web view sends no command, path or script.
//! This module checks the request, finds each demo in CS2's replays folder, and builds HLAE's exact
//! command from a fixed template, the director script (src/clips/director.template.js) and the plan
//! the user reads before anything starts. The launch builds the job again from the request in
//! plan.json and refuses when the saved plan differs, so an edited plan or director cannot run.

use super::{check_hlae, clip_id_ok, file_inside, job_id_ok, plain};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The cfg the launch writes into `game\csgo\cfg`; its one line loads the director.
pub const CFG_NAME: &str = "cs2stats_clips";
/// 1080p at 60 frames per second, povforge's defaults (hlae.py RecordSettings).
pub const WIDTH: u32 = 1920;
pub const HEIGHT: u32 = 1080;
pub const FPS: u32 = 60;
/// HLAE's encoder for each take: x264 at CRF 16, povforge's video_options. The finishing template
/// re-encodes the take, so this only needs to be good enough to survive that.
const TAKE_VIDEO_OPTIONS: &str = "-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 16";
/// The longest clip a job may hold, in seconds; a moment is one round, which CS2 caps well under it.
const MAX_CLIP_S: f64 = 600.0;
const TEMPLATE: &str = include_str!("../../../src/clips/director.template.js");
const PLACEHOLDER: &str = "__CS2STATS_JOB__";

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipReq {
    /// the clip id, which must be the one clip_id_for gives the demo, player and round below
    pub id: String,
    /// the demo's file name in CS2's replays folder
    pub demo: String,
    pub steamid: String,
    /// the round's number in the match
    pub round: u32,
    pub start_tick: i64,
    pub end_tick: i64,
    pub tick_rate: f64,
    /// for the plan the user reads; the director never sees it
    pub reason: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobReq {
    pub clips: Vec<ClipReq>,
    pub hlae: String,
}

/// Where things are on this machine: the clips folder, CS2's replays folder and cs2.exe.
pub struct JobEnv {
    pub clips_root: PathBuf,
    pub replays: PathBuf,
    pub cs2_exe: PathBuf,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanClip {
    pub id: String,
    pub steamid: String,
    pub start: i64,
    pub end: i64,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanDemo {
    pub path: String,
    pub tick_rate: f64,
    pub clips: Vec<PlanClip>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub id: String,
    pub take: String,
    pub finished: String,
    pub reason: String,
    pub duration_s: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version: u32,
    pub id: String,
    pub created: String,
    pub settings: Settings,
    pub job_dir: String,
    pub hlae_exe: String,
    pub hook_dll: String,
    pub cs2_exe: String,
    /// HLAE.exe and its arguments: exactly what the launch runs
    pub argv: Vec<String>,
    /// argv as one PowerShell command (`& 'HLAE.exe' '-noGui' ...`), for the user to read or run by
    /// hand in PowerShell. Not a cmd.exe command: cmd would read `&` and `%` in a path. The launch itself
    /// passes argv to the process directly and uses no shell.
    pub powershell: String,
    pub cfg_file: String,
    /// what the cfg's one line loads: each launch's own copy of the director, with that launch's nonce
    /// (clips/mod.rs prepare_launch); written here with the copy's name left as `<launch nonce>`
    pub cfg_text: String,
    /// the director for reading, without a nonce; a launch runs its own copy in `launches\<nonce>.js`
    pub director_file: String,
    pub demos: Vec<PlanDemo>,
    pub outputs: Vec<Output>,
    /// what the plan was built from; the launch builds it again from this
    pub request: JobReq,
}

/// The game's own arguments, inside HLAE's -cmdLine. -insecure is required: HLAE injects into the
/// game, and VAC must be off for that. Nothing else is accepted (`build` writes exactly this).
pub fn game_args() -> Vec<String> {
    let (w, h) = (WIDTH.to_string(), HEIGHT.to_string());
    ["-insecure", "-novid", "-condebug", "-console", "-sw", "-width", &w, "-height", &h, "+exec", CFG_NAME].map(String::from).to_vec()
}

/// HLAE's command (its flags are parsed in advancedfx hlae/Program.cs ProcessArgsCustomLoader; the
/// set follows CS2-povforge hlae.py launch_command): the custom loader injects AfxHookSource2 into
/// cs2.exe and starts it with the game's arguments.
pub fn hlae_argv(hlae: &Path, cs2: &Path) -> Vec<String> {
    let hook = hlae.parent().unwrap_or(Path::new("")).join("x64").join("AfxHookSource2.dll");
    let mut v: Vec<String> = vec![hlae.display().to_string()];
    v.extend(["-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader"].map(String::from));
    v.extend(["-hookDllPath".into(), hook.display().to_string(), "-programPath".into(), cs2.display().to_string(), "-cmdLine".into(), game_args().join(" ")]);
    v
}

/// One PowerShell argument: single-quoted, so nothing in it is expanded (`$`, `%`, `&`, backticks), with a
/// single quote doubled, as PowerShell's single-quoted strings write one.
pub fn ps_quote(a: &str) -> String {
    format!("'{}'", a.replace('\'', "''"))
}

/// argv as a PowerShell command: the call operator `&` and each argument single-quoted.
pub fn powershell_command(argv: &[String]) -> String {
    std::iter::once("&".to_string()).chain(argv.iter().map(|a| ps_quote(a))).collect::<Vec<_>>().join(" ")
}

/// The console commands the director runs once before the first demo: record the screen through
/// HLAE's FFmpeg preset, with the game's sound beside it. HLAE's own settings; none is a CS2 setting.
/// The demo bar (demo_ui_mode) is the director's to hide and put back (director.template.js).
fn setup_commands() -> Vec<String> {
    vec![
        "demo_timescale 1".into(),
        "mirv_streams record screen enabled 1".into(),
        // {QUOTE} and {AFX_STREAM_PATH} are HLAE's own placeholders (shared/RecordingSettings.cpp)
        format!("mirv_streams settings add ffmpeg cs2stats \"{TAKE_VIDEO_OPTIONS} {{QUOTE}}{{AFX_STREAM_PATH}}\\\\video.mp4{{QUOTE}}\""),
        "mirv_streams record screen settings cs2stats".into(),
        format!("mirv_streams record fps {FPS}"),
        "mirv_streams record startMovieWav 1".into(),
    ]
}

/// A path with forward slashes, as CS2's console and HLAE's script read it.
fn fwd(p: &str) -> String {
    p.replace('\\', "/")
}

/// A demo file name the replays folder can hold: a plain name ending in .dem.
pub fn demo_name_ok(s: &str) -> bool {
    s.len() > 4 && s.to_ascii_lowercase().ends_with(".dem") && !s.starts_with('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// The demo `name` in `replays`: a regular file reached without a link, directly inside the folder
/// once every link on the way is resolved. A junction or link named like a demo is refused.
pub fn resolve_demo(replays: &Path, name: &str) -> Result<PathBuf, String> {
    if !demo_name_ok(name) {
        return Err(format!("{name:?} is not a demo file name"));
    }
    let p = file_inside(replays, &replays.join(name)).map_err(|e| format!("demo {name}: {e}"))?;
    let root = plain(&replays.canonicalize().map_err(|e| format!("{}: {e}", replays.display()))?);
    if p.parent() != Some(root.as_path()) {
        return Err(format!("demo {name} resolves outside CS2's replays folder"));
    }
    Ok(p)
}

/// 64 bits of FNV-1a over the text's UTF-16 code units, as 16 hex digits: clips/ids.ts fnv64.
pub fn fnv64(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for u in text.encode_utf16() {
        h ^= u64::from(u);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// The clip id the app gives a moment of `player` in `round` of the Valve match whose demo is `demo`:
/// clips/ids.ts clipId over the match key `valve/<demo name without .dem>` (ids.ts matchKey). Valve
/// matches are the only ones with a demo on disk (clips/state.ts demoSource).
pub fn clip_id_for(demo: &str, player: &str, round: u32) -> Result<String, String> {
    if !demo_name_ok(demo) {
        return Err(format!("{demo:?} is not a demo file name"));
    }
    if !(1..=999).contains(&round) {
        return Err(format!("round {round} is not a round number"));
    }
    Ok(format!("c-{}-r{round}", fnv64(&format!("valve/{}|{player}", &demo[..demo.len() - 4]))))
}

/// The demo's length in ticks, from its file info (CDemoFileInfo.playback_ticks): a CS2 demo starts
/// with `PBDEMS2\0` and the file info's offset; there, a frame of a varint command (2, DEM_FileInfo),
/// tick and size, then the message, whose field 2 is the tick count. Refused, naming why, when the demo
/// is not a CS2 demo or its file info is compressed or missing, so a clip is never bounded by a guess.
pub fn demo_playback_ticks(path: &Path) -> Result<i64, String> {
    use std::io::{Read, Seek, SeekFrom};
    let fail = |m: &str| format!("{}: {m}", path.display());
    let mut f = fs::File::open(path).map_err(|e| fail(&e.to_string()))?;
    let mut head = [0u8; 16];
    f.read_exact(&mut head).map_err(|_| fail("too short for a CS2 demo"))?;
    if &head[..8] != b"PBDEMS2\0" {
        return Err(fail("not a CS2 demo (no PBDEMS2 header)"));
    }
    let offset = u32::from_le_bytes([head[8], head[9], head[10], head[11]]) as u64;
    if offset < 16 {
        return Err(fail("its file info offset is missing; the demo may not have been finished"));
    }
    f.seek(SeekFrom::Start(offset)).map_err(|e| fail(&e.to_string()))?;
    let mut b = Vec::new();
    f.take(4096).read_to_end(&mut b).map_err(|e| fail(&e.to_string()))?;
    file_info_ticks(&b).map_err(|m| fail(&m))
}

/// A protobuf varint at `b[*i..]`: at most 10 bytes, the tenth carrying only the 64th bit. Every shift
/// and step is checked, so truncated, overlong or oversized input is an error, never a panic or a wrap.
fn varint(b: &[u8], i: &mut usize) -> Result<u64, &'static str> {
    let mut v = 0u64;
    for k in 0..10u32 {
        let c = *b.get(*i).ok_or("a number is cut short")?;
        *i = i.checked_add(1).ok_or("a number is cut short")?;
        let bits = u64::from(c & 0x7f);
        if k == 9 && bits > 1 {
            return Err("a number is larger than 64 bits");
        }
        v |= bits.checked_shl(7 * k).ok_or("a number is larger than 64 bits")?;
        if c < 0x80 {
            return Ok(v);
        }
    }
    Err("a number runs past 10 bytes")
}

/// `i + n` as an index into `b`, refused when it overflows or runs past the end.
fn advance(b: &[u8], i: usize, n: u64) -> Result<usize, &'static str> {
    let n = usize::try_from(n).map_err(|_| "a length is too large")?;
    let j = i.checked_add(n).ok_or("a length is too large")?;
    if j > b.len() {
        return Err("a length runs past the end");
    }
    Ok(j)
}

/// The tick count in a demo's file-info frame (`b` starts at the frame): a varint command (2,
/// DEM_FileInfo; 64 marks compression), tick and size, then the CDemoFileInfo message, whose field 2,
/// playback_ticks, is an int32.
fn file_info_ticks(b: &[u8]) -> Result<i64, String> {
    let mut i = 0;
    let cmd = varint(b, &mut i).map_err(|e| format!("its file info frame is malformed: {e}"))?;
    let _tick = varint(b, &mut i).map_err(|e| format!("its file info frame is malformed: {e}"))?;
    let size = varint(b, &mut i).map_err(|e| format!("its file info frame is malformed: {e}"))?;
    if cmd & 64 != 0 {
        return Err("its file info is compressed, which the app does not read".into());
    }
    if cmd != 2 {
        return Err("no file info frame at its file info offset".into());
    }
    let end = advance(b, i, size).map_err(|e| format!("its file info frame is malformed: {e}"))?;
    let msg = &b[i..end];
    let mut j = 0;
    let bad = |e: &str| format!("its file info is malformed: {e}");
    while j < msg.len() {
        let key = varint(msg, &mut j).map_err(bad)?;
        match (key >> 3, key & 7) {
            (2, 0) => {
                let v = varint(msg, &mut j).map_err(bad)?;
                // an int32 field: protobuf writes a negative one as ten bytes, which is no tick count either
                return i32::try_from(v).ok().filter(|t| *t >= 0).map(i64::from).ok_or_else(|| bad("the tick count is not a non-negative int32"));
            }
            (_, 0) => {
                varint(msg, &mut j).map_err(bad)?;
            }
            (_, 5) => j = advance(msg, j, 4).map_err(bad)?,
            (_, 1) => j = advance(msg, j, 8).map_err(bad)?,
            (_, 2) => {
                let n = varint(msg, &mut j).map_err(bad)?;
                j = advance(msg, j, n).map_err(bad)?;
            }
            _ => return Err(bad("an unknown field type")),
        }
    }
    Err("its file info holds no tick count".into())
}

fn steamid_ok(s: &str) -> bool {
    s.len() == 17 && s.starts_with("7656119") && s.chars().all(|c| c.is_ascii_digit())
}

/// Checks the request and builds the job `id` (created at `created`): the plan and the director script.
/// Refuses, naming the clip, an id that is not a clip id or comes twice, ticks that are not a forward
/// range of at most MAX_CLIP_S, a player without a SteamID64 (the director finds the player by it;
/// bots have none), a demo not in the replays folder, and clips of one demo that disagree on the tick rate.
pub fn build(req: &JobReq, env: &JobEnv, id: &str, created: &str) -> Result<(Plan, String), String> {
    if !job_id_ok(id) {
        return Err(format!("{id:?} is not a job id"));
    }
    if req.clips.is_empty() {
        return Err("render plan: no clips chosen".into());
    }
    let hlae = PathBuf::from(req.hlae.trim());
    check_hlae(&hlae)?;
    let hlae = plain(&hlae.canonicalize().map_err(|e| format!("{}: {e}", hlae.display()))?);
    let cs2 = plain(&env.cs2_exe.canonicalize().map_err(|e| format!("{}: {e}", env.cs2_exe.display()))?);
    let root = plain(&env.clips_root.canonicalize().map_err(|e| format!("{}: {e}", env.clips_root.display()))?);
    let mut seen = std::collections::HashSet::new();
    let mut demos: Vec<(PathBuf, f64, Vec<&ClipReq>)> = Vec::new();
    for c in &req.clips {
        let at = |m: &str| format!("render plan: {}: {m}", c.id);
        if !clip_id_ok(&c.id) {
            return Err(format!("render plan: {:?} is not a clip id", c.id));
        }
        if !seen.insert(c.id.clone()) {
            return Err(at("chosen twice"));
        }
        if !(c.tick_rate.is_finite() && c.tick_rate > 0.0 && c.tick_rate <= 1024.0) {
            return Err(at("no tick rate"));
        }
        if c.start_tick < 0 || c.end_tick <= c.start_tick || (c.end_tick - c.start_tick) as f64 > MAX_CLIP_S * c.tick_rate {
            return Err(at(&format!("ticks {} to {} are not a range of at most {MAX_CLIP_S} s", c.start_tick, c.end_tick)));
        }
        if !steamid_ok(&c.steamid) {
            return Err(at("the POV player has no SteamID64, so the director cannot find them"));
        }
        if c.reason.chars().count() > 300 || c.reason.chars().any(char::is_control) {
            return Err(at("the reason is not one line of at most 300 characters"));
        }
        let path = resolve_demo(&env.replays, &c.demo).map_err(|e| at(&e))?;
        // the clip id names the match (its demo), the player and the round, so a request cannot pair one
        // moment's id with another demo, player or round: the output would be filed as the wrong moment
        let want = clip_id_for(&c.demo, &c.steamid, c.round)?;
        if c.id != want {
            return Err(at(&format!("the id does not match its demo, player and round {} (expected {want})", c.round)));
        }
        // the host cannot read the match's round ticks (they are in parquet), so it bounds the clip by the
        // demo itself: its file info gives the length in ticks
        let length = demo_playback_ticks(&path).map_err(|e| at(&e))?;
        if c.end_tick > length {
            return Err(at(&format!("ticks {} to {} run past the end of the demo, {length} ticks", c.start_tick, c.end_tick)));
        }
        match demos.iter_mut().find(|d| d.0 == path) {
            Some(d) if d.1 != c.tick_rate => return Err(format!("render plan: {}: its clips disagree on the tick rate", c.demo)),
            Some(d) => d.2.push(c),
            None => demos.push((path, c.tick_rate, vec![c])),
        }
    }
    let job_dir = root.join("jobs").join(id);
    let director = job_dir.join("director.js");
    let argv = hlae_argv(&hlae, &cs2);
    let demos: Vec<PlanDemo> = demos
        .into_iter()
        .map(|(path, rate, mut cs)| {
            // in demo order, so the director only ever seeks forward within a demo
            cs.sort_by_key(|c| c.start_tick);
            PlanDemo {
                path: path.display().to_string(),
                tick_rate: rate,
                clips: cs.iter().map(|c| PlanClip { id: c.id.clone(), steamid: c.steamid.clone(), start: c.start_tick, end: c.end_tick, reason: c.reason.clone() }).collect(),
            }
        })
        .collect();
    let outputs = demos
        .iter()
        .flat_map(|d| {
            d.clips.iter().map(|c| Output {
                id: c.id.clone(),
                take: job_dir.join("raw").join(&c.id).display().to_string(),
                finished: root.join(format!("{}.mp4", c.id)).display().to_string(),
                reason: c.reason.clone(),
                duration_s: (c.end - c.start) as f64 / d.tick_rate,
            })
        })
        .collect();
    let plan = Plan {
        version: 2,
        id: id.into(),
        created: created.into(),
        settings: Settings { width: WIDTH, height: HEIGHT, fps: FPS },
        job_dir: job_dir.display().to_string(),
        hlae_exe: argv[0].clone(),
        hook_dll: argv[7].clone(),
        cs2_exe: argv[9].clone(),
        powershell: powershell_command(&argv),
        argv,
        cfg_file: format!("{CFG_NAME}.cfg"),
        cfg_text: format!("mirv_script_load \"{}/launches/<launch nonce>.js\"\n", fwd(&job_dir.display().to_string())),
        director_file: director.display().to_string(),
        demos,
        outputs,
        request: req.clone(),
    };
    let script = director_script(&plan, "")?;
    Ok((plan, script))
}

/// Timing the director waits on, in rendered frames, and the lead before each clip: povforge's values
/// (hlae.py build_job), not measured here.
fn director_job(plan: &Plan, nonce: &str) -> serde_json::Value {
    json!({
        "nonce": nonce,
        "id": plan.id,
        "outDir": fwd(&format!("{}\\raw", plan.job_dir)),
        "demos": plan.demos.iter().map(|d| json!({
            "path": fwd(&d.path), "tickrate": d.tick_rate,
            "clips": d.clips.iter().map(|c| json!({ "id": c.id, "steamid": c.steamid, "start": c.start, "end": c.end })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "setup": setup_commands(),
        "frameStage": 12, "bootFrames": 300, "loadTimeoutFrames": 20000, "seekRetryFrames": 900, "finishFrames": 180, "seekLeadSeconds": 2,
        "quitWhenDone": true,
    })
}

/// The director script: the template with the job as JSON in place of its one placeholder.
/// The director script for a launch with `nonce` (empty for the copy kept to read): the template with
/// the job as JSON in place of its one placeholder.
pub fn director_script(plan: &Plan, nonce: &str) -> Result<String, String> {
    if TEMPLATE.matches(PLACEHOLDER).count() != 1 {
        return Err("the director template must hold its job placeholder exactly once".into());
    }
    Ok(TEMPLATE.replacen(PLACEHOLDER, &director_job(plan, nonce).to_string(), 1))
}

/// Days since 1970-01-01 as (year, month, day): Howard Hinnant's civil_from_days.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// A new job's id and its creation time: `job-YYYYMMDDTHHMMSSmmmZ-<6 hex>`, to the millisecond with a
/// random suffix, so two plans saved in the same second never share a folder.
pub fn new_job_id(now: SystemTime) -> (String, String) {
    use std::hash::{BuildHasher, Hasher};
    let d = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (y, mo, da) = civil(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    let (h, mi, s) = (t / 3600, t % 3600 / 60, t % 60);
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(d.as_nanos());
    let suffix = hasher.finish() & 0xff_ffff;
    (
        format!("job-{y:04}{mo:02}{da:02}T{h:02}{mi:02}{s:02}{ms:03}Z-{suffix:06x}"),
        format!("{y:04}-{mo:02}-{da:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z"),
    )
}

/// A new file `.<name>.<random>.tmp` in `dir`, created exclusively (`create_new`), so nothing that was
/// already there, a file, a link or another writer's temporary, is ever written into.
fn new_temp(dir: &Path, name: &str, text: &[u8]) -> Result<PathBuf, String> {
    use std::hash::{BuildHasher, Hasher};
    use std::io::Write;
    for _ in 0..8 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
        let p = dir.join(format!(".{name}.{:016x}.tmp", h.finish()));
        match fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(mut f) => {
                return f.write_all(text).and_then(|_| f.sync_all()).map(|_| p.clone()).map_err(|e| {
                    let _ = fs::remove_file(&p);
                    format!("{}: {e}", p.display())
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", p.display())),
        }
    }
    Err(format!("{}: no free temporary name for {name}", dir.display()))
}

/// A new, empty file `.<stem>.<random>.part.mp4` beside `name` in `dir`, created exclusively, for FFmpeg
/// to write into: the result is renamed over `name` only once FFmpeg exits cleanly (mod.rs run_render),
/// so a failed or cut-off render never stands where a finished clip should.
pub(crate) fn new_part(dir: &Path, name: &str) -> Result<PathBuf, String> {
    use std::hash::{BuildHasher, Hasher};
    let stem = name.strip_suffix(".mp4").ok_or_else(|| format!("{name} is not an .mp4"))?;
    for _ in 0..8 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
        let p = dir.join(format!(".{stem}.{:016x}.part.mp4", h.finish()));
        match fs::OpenOptions::new().write(true).create_new(true).open(&p) {
            Ok(_) => return Ok(p),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", p.display())),
        }
    }
    Err(format!("{}: no free temporary name for {name}", dir.display()))
}

/// Writes `files` into `dir` so that none is ever half-written or missing its partner: each goes to a
/// new temporary file first ([`new_temp`]), then all are renamed in order, which replaces a directory
/// entry and never writes through an existing file or hard link. The plan is renamed last, so a plan
/// never exists without its director. On a failure the temporary files are removed.
pub fn write_together(dir: &Path, files: &[(&str, &[u8])]) -> Result<(), String> {
    let mut tmps: Vec<PathBuf> = Vec::new();
    let clean = |t: &[PathBuf]| for p in t { let _ = fs::remove_file(p); };
    for (n, text) in files {
        match new_temp(dir, n, text) {
            Ok(p) => tmps.push(p),
            Err(e) => {
                clean(&tmps);
                return Err(e);
            }
        }
    }
    for (i, (n, _)) in files.iter().enumerate() {
        if let Err(e) = fs::rename(&tmps[i], dir.join(n)) {
            clean(&tmps[i..]);
            return Err(format!("{}: {e}", dir.join(n).display()));
        }
    }
    Ok(())
}

/// Saves a built job: its folder (refused when it exists, ids are unique), the raw takes' folder, and
/// the director then the plan, written together.
pub fn save(plan: &Plan, script: &str) -> Result<(), String> {
    let dir = PathBuf::from(&plan.job_dir);
    if dir.exists() {
        return Err(format!("{} exists already", dir.display()));
    }
    fs::create_dir_all(dir.join("raw")).map_err(|e| format!("{}: {e}", dir.display()))?;
    let plan_json = serde_json::to_string_pretty(plan).map_err(|e| e.to_string())? + "\n";
    write_together(&dir, &[("director.js", script.as_bytes()), ("plan.json", plan_json.as_bytes())])
}

/// A CS2 demo as far as the host reads one: the PBDEMS2 header, its file info offset, and there an
/// uncompressed DEM_FileInfo frame whose message holds playback_time (field 1), playback_ticks
/// (field 2) and playback_frames (field 3), laid out as a real demo's (the HLTV demo read 2026-10-27).
#[cfg(test)]
pub(crate) fn fake_demo(ticks: u64) -> Vec<u8> {
    fn varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 { out.push(b); return; }
            out.push(b | 0x80);
        }
    }
    let mut msg = vec![0x0d];
    msg.extend((ticks as f32 / 64.0).to_le_bytes());
    msg.push(0x10);
    varint(ticks, &mut msg);
    msg.push(0x18);
    varint(ticks + 1, &mut msg);
    let mut d = b"PBDEMS2\0".to_vec();
    d.extend(64u32.to_le_bytes());
    d.extend(0u32.to_le_bytes());
    d.resize(64, 0);
    varint(2, &mut d);
    varint(ticks, &mut d);
    varint(msg.len() as u64, &mut d);
    d.extend(msg);
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "76561190000000001";
    const D1: &str = "match730_0001.dem";
    const D2: &str = "match730_0002.dem";
    /// the moments' ids, as the app gives them (clip_id_for): demo 1 rounds 3 and 9, demo 2 round 1
    fn a1() -> String { clip_id_for(D1, ME, 3).unwrap() }
    fn a2() -> String { clip_id_for(D1, ME, 9).unwrap() }
    fn b1() -> String { clip_id_for(D2, ME, 1).unwrap() }
    const ID: &str = "job-20261026T180405123Z-a1b2c3";

    /// A scratch machine: a clips folder, CS2's replays folder with two demos, cs2.exe and an HLAE folder.
    struct Machine {
        root: PathBuf,
        env: JobEnv,
        hlae: PathBuf,
    }
    impl Drop for Machine {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    fn machine(tag: &str) -> Machine {
        let root = std::env::temp_dir().join(format!("cs2stats-job-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let game = root.join("Counter-Strike Global Offensive").join("game");
        let replays = game.join("csgo").join("replays");
        fs::create_dir_all(&replays).unwrap();
        for d in [D1, D2] {
            fs::write(replays.join(d), fake_demo(100_000)).unwrap();
        }
        let cs2 = game.join("bin").join("win64").join("cs2.exe");
        fs::create_dir_all(cs2.parent().unwrap()).unwrap();
        fs::write(&cs2, b"").unwrap();
        let hlae = root.join("HLAE").join("HLAE.exe");
        fs::create_dir_all(hlae.parent().unwrap().join("x64")).unwrap();
        fs::write(&hlae, b"").unwrap();
        fs::write(hlae.parent().unwrap().join("x64").join("AfxHookSource2.dll"), b"").unwrap();
        let clips = root.join("clips");
        fs::create_dir_all(&clips).unwrap();
        let canon = |p: &Path| plain(&p.canonicalize().unwrap());
        Machine { env: JobEnv { clips_root: canon(&clips), replays: canon(&replays), cs2_exe: canon(&cs2) }, hlae: canon(&hlae), root }
    }
    fn clip(demo: &str, round: u32, start: i64, end: i64) -> ClipReq {
        let id = clip_id_for(demo, ME, round).unwrap();
        ClipReq { reason: format!("reason {id}"), id, demo: demo.into(), steamid: ME.into(), round, start_tick: start, end_tick: end, tick_rate: 64.0 }
    }
    fn req(m: &Machine, clips: Vec<ClipReq>) -> JobReq {
        JobReq { clips, hlae: m.hlae.display().to_string() }
    }

    #[test]
    fn the_command_is_the_fixed_template_with_insecure_first_in_the_games_arguments() {
        let m = machine("argv");
        let (plan, _) = build(&req(&m, vec![clip(D1, 3, 1000, 2000)]), &m.env, ID, "t").unwrap();
        let hook = m.hlae.parent().unwrap().join("x64").join("AfxHookSource2.dll");
        assert_eq!(plan.argv, [
            m.hlae.display().to_string().as_str(), "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader",
            "-hookDllPath", hook.display().to_string().as_str(), "-programPath", m.env.cs2_exe.display().to_string().as_str(),
            "-cmdLine", "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips",
        ]);
        assert!(plan.powershell.starts_with("& '") && plan.powershell.ends_with("'-cmdLine' '-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips'"), "{}", plan.powershell);
    }

    #[test]
    fn the_job_lives_in_its_own_folder_and_the_cfg_loads_its_director() {
        let m = machine("dir");
        let (plan, script) = build(&req(&m, vec![clip(D1, 3, 1000, 2280)]), &m.env, ID, "t").unwrap();
        let dir = m.env.clips_root.join("jobs").join(ID);
        assert_eq!(plan.job_dir, dir.display().to_string());
        assert_eq!(plan.cfg_text, format!("mirv_script_load \"{}/launches/<launch nonce>.js\"\n", dir.display().to_string().replace('\\', "/")));
        assert_eq!(plan.outputs[0].finished, m.env.clips_root.join(format!("{}.mp4", a1())).display().to_string());
        assert_eq!(plan.outputs[0].duration_s, 20.0);
        // the director holds the job, with the demo's resolved path and no reason text. The template's
        // line ends are whatever the checkout gave it (CRLF on Windows with core.autocrlf), so the job's
        // line is read with lines(), which takes either.
        let job = script.split("const JOB = ").nth(1).unwrap().lines().next().unwrap().trim_end().trim_end_matches(';');
        let v: serde_json::Value = serde_json::from_str(job).unwrap();
        assert_eq!(v["demos"][0]["path"], m.env.replays.join("match730_0001.dem").display().to_string().replace('\\', "/"));
        assert_eq!(v["demos"][0]["clips"][0], json!({ "id": a1(), "steamid": ME, "start": 1000, "end": 2280 }));
        // the keys director.template.js reads, which src/clips/director.test.ts's fixture copies
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["bootFrames", "demos", "finishFrames", "frameStage", "id", "loadTimeoutFrames", "nonce", "outDir", "quitWhenDone", "seekLeadSeconds", "seekRetryFrames", "setup"]);
        assert_eq!(v["demos"][0]["tickrate"], 64.0);
        assert!(!v["setup"].as_array().unwrap().iter().any(|c| c.as_str().unwrap().contains("demo_ui_mode")), "the director, not setup, owns demo_ui_mode");
        assert!(!script.contains("reason c-"));
        assert!(!script.contains(PLACEHOLDER));
    }

    #[test]
    fn clips_group_by_demo_in_the_order_chosen_each_demo_in_tick_order() {
        let m = machine("group");
        let r = req(&m, vec![clip(D1, 9, 9000, 9500), clip(D2, 1, 100, 900), clip(D1, 3, 1000, 2000)]);
        let (plan, _) = build(&r, &m.env, ID, "t").unwrap();
        let got: Vec<(String, Vec<String>)> = plan.demos.iter().map(|d| (Path::new(&d.path).file_name().unwrap().to_string_lossy().into(), d.clips.iter().map(|c| c.id.clone()).collect())).collect();
        assert_eq!(got, [(D1.to_string(), vec![a1(), a2()]), (D2.to_string(), vec![b1()])]);
    }

    #[test]
    fn a_clip_id_must_name_its_demo_player_and_round() {
        let m = machine("bind");
        // the value clips/ids.ts gives the same match key, player and round (src/clips/ids.test.ts)
        assert_eq!(clip_id_for("match730_0001.dem", ME, 3).unwrap(), "c-e3fad9374b01f517-r3");
        let refused = |c: ClipReq| build(&req(&m, vec![c]), &m.env, ID, "t").unwrap_err();
        // match 1's round 3 id, with match 2's demo, another player, or another round
        for c in [ClipReq { demo: D2.into(), ..clip(D1, 3, 1000, 2000) }, ClipReq { steamid: "76561190000000002".into(), ..clip(D1, 3, 1000, 2000) }, ClipReq { round: 4, ..clip(D1, 3, 1000, 2000) }] {
            let e = refused(c);
            assert!(e.contains("does not match its demo, player and round"), "{e}");
        }
        build(&req(&m, vec![clip(D1, 3, 1000, 2000)]), &m.env, ID, "t").unwrap();
    }

    #[test]
    fn a_malformed_demo_is_an_error_never_a_panic() {
        // the frame as a real demo writes it, then varints and lengths at their limits
        let good = fake_demo(1234);
        let frame = &good[64..];
        assert_eq!(file_info_ticks(frame), Ok(1234));
        let cases: Vec<(Vec<u8>, &str)> = vec![
            (vec![], "cut short"),
            (vec![0x82], "cut short"),                                    // a truncated varint
            (vec![0x80; 11], "past 10 bytes"),                           // an overlong one
            (vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], "larger than 64 bits"),
            ([vec![2, 0], vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]].concat(), "too large"), // size u64::MAX
            (vec![2, 0, 50, 0x10, 0x05], "runs past the end"),           // a size past the frame
            (vec![2, 0, 3, 0x0a, 0xff, 0x01], "runs past the end"),     // a field length past the message
            (vec![2, 0, 2, 0x0d, 0x00], "runs past the end"),           // a fixed32 cut short
            (vec![2, 0, 2, 0x10, 0x80], "cut short"),                    // the tick count cut short
            ([vec![2, 0, 11, 0x10], vec![0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]].concat(), "non-negative int32"),
            (vec![2, 0, 2, 0x0f, 0x00], "unknown field type"),
            (vec![66, 0, 0], "compressed"),
            (vec![3, 0, 0], "no file info frame"),
        ];
        for (bytes, want) in cases {
            let e = file_info_ticks(&bytes).unwrap_err();
            assert!(e.contains(want), "{bytes:?}: {e}");
        }
        // every truncation and every single-byte change of a good frame: an answer or an error, never a panic
        for n in 0..frame.len() {
            let _ = file_info_ticks(&frame[..n]);
        }
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        for k in 0..frame.len() {
            for _ in 0..64 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                let mut f = frame.to_vec();
                f[k] = seed as u8;
                let _ = file_info_ticks(&f);
            }
        }
    }

    #[test]
    fn a_clip_must_end_within_its_demo() {
        let m = machine("length");
        // the fixture demos are 100,000 ticks long
        assert_eq!(demo_playback_ticks(&m.env.replays.join(D1)).unwrap(), 100_000);
        build(&req(&m, vec![clip(D1, 3, 99_000, 100_000)]), &m.env, ID, "t").unwrap();
        let e = build(&req(&m, vec![clip(D1, 3, 99_000, 100_001)]), &m.env, ID, "t").unwrap_err();
        assert!(e.contains("run past the end of the demo, 100000 ticks"), "{e}");
        // a file that is not a CS2 demo, and a demo whose file info is compressed, bound nothing: refused
        fs::write(m.env.replays.join(D2), b"HL2DEMO\0................").unwrap();
        assert!(build(&req(&m, vec![clip(D2, 1, 1, 2)]), &m.env, ID, "t").unwrap_err().contains("not a CS2 demo"));
        let mut z = fake_demo(5000);
        z[64] = 2 | 64;
        fs::write(m.env.replays.join(D2), z).unwrap();
        assert!(build(&req(&m, vec![clip(D2, 1, 1, 2)]), &m.env, ID, "t").unwrap_err().contains("compressed"));
    }

    #[test]
    fn the_copyable_command_is_a_powershell_call_that_expands_nothing() {
        let argv: Vec<String> = [r"C:\Tools & More\100% HLAE\it's\HLAE.exe", "-cmdLine", "-insecure +exec cs2stats_clips"].map(String::from).to_vec();
        assert_eq!(powershell_command(&argv), r"& 'C:\Tools & More\100% HLAE\it''s\HLAE.exe' '-cmdLine' '-insecure +exec cs2stats_clips'");
    }

    #[test]
    fn a_request_the_director_cannot_record_is_refused_by_name() {
        let m = machine("bad");
        let ok = clip(D1, 3, 1000, 2000);
        let refused = |c: ClipReq, want: &str| {
            let e = build(&req(&m, vec![c]), &m.env, ID, "t").unwrap_err();
            assert!(e.contains(want), "{e}");
        };
        refused(ClipReq { id: "../x".into(), ..ok.clone() }, "not a clip id");
        refused(ClipReq { end_tick: 1000, ..ok.clone() }, "not a range");
        refused(ClipReq { end_tick: 1000 + 64 * 601, ..ok.clone() }, "not a range");
        refused(ClipReq { steamid: "BOT Kev".into(), ..ok.clone() }, "no SteamID64");
        refused(ClipReq { demo: "..\\x.dem".into(), ..ok.clone() }, "not a demo file name");
        refused(ClipReq { demo: "match730_9999.dem".into(), ..ok.clone() }, "demo match730_9999.dem");
        refused(ClipReq { reason: "two\nlines".into(), ..ok.clone() }, "one line");
        let twice = build(&req(&m, vec![ok.clone(), ok.clone()]), &m.env, ID, "t").unwrap_err();
        assert!(twice.contains("chosen twice"), "{twice}");
        let rates = build(&req(&m, vec![ok.clone(), ClipReq { tick_rate: 128.0, ..clip(D1, 9, 1000, 2000) }]), &m.env, ID, "t").unwrap_err();
        assert!(rates.contains("disagree on the tick rate"), "{rates}");
        let not_hlae = build(&JobReq { clips: vec![ok.clone()], hlae: m.env.cs2_exe.display().to_string() }, &m.env, ID, "t").unwrap_err();
        assert!(not_hlae.contains("is not HLAE.exe"), "{not_hlae}");
        assert!(build(&req(&m, vec![ok]), &m.env, "../job", "t").unwrap_err().contains("not a job id"));
    }

    #[cfg(windows)]
    fn link(target: &Path, at: &Path) {
        // a directory junction needs no privilege, unlike a file symlink
        let ok = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(at).arg(target).output().unwrap().status.success();
        assert!(ok, "mklink /J failed");
    }
    #[cfg(not(windows))]
    fn link(target: &Path, at: &Path) {
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    #[test]
    fn a_link_named_like_a_demo_is_refused() {
        let m = machine("link");
        let elsewhere = m.root.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        link(&elsewhere, &m.env.replays.join("evil.dem"));
        let e = build(&req(&m, vec![ClipReq { demo: "evil.dem".into(), ..clip(D1, 3, 1000, 2000) }]), &m.env, ID, "t").unwrap_err();
        assert!(e.contains("demo evil.dem"), "{e}");
        assert!(resolve_demo(&m.env.replays, "evil.dem").is_err());
        assert!(resolve_demo(&m.env.replays, "match730_0001.dem").is_ok());
    }

    #[test]
    fn job_ids_carry_milliseconds_and_a_random_suffix() {
        let t = UNIX_EPOCH + std::time::Duration::from_millis(1_793_037_845_123);
        let (a, created) = new_job_id(t);
        let (b, _) = new_job_id(t);
        assert!(a.starts_with("job-20261026T180405123Z-") && job_id_ok(&a), "{a}");
        assert_eq!(created, "2026-10-26T18:04:05.123Z");
        assert_ne!(a, b, "two jobs in the same millisecond share an id");
    }

    #[test]
    fn a_saved_job_holds_its_director_and_plan_and_refuses_its_folder_twice() {
        let m = machine("save");
        let (plan, script) = build(&req(&m, vec![clip(D1, 3, 1000, 2000)]), &m.env, ID, "t").unwrap();
        save(&plan, &script).unwrap();
        let dir = PathBuf::from(&plan.job_dir);
        assert_eq!(fs::read_to_string(dir.join("director.js")).unwrap(), script);
        let back: Plan = serde_json::from_str(&fs::read_to_string(dir.join("plan.json")).unwrap()).unwrap();
        assert_eq!(back, plan);
        assert!(dir.join("raw").is_dir());
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
        assert!(save(&plan, &script).unwrap_err().contains("exists already"));
    }

    #[test]
    fn a_failed_write_leaves_no_plan_and_no_temporary_files() {
        let m = machine("atomic");
        let dir = m.env.clips_root.join("jobs").join(ID);
        fs::create_dir_all(dir.join("plan.json")).unwrap(); // a folder where the plan should go: its rename fails
        let e = write_together(&dir, &[("director.js", b"d"), ("plan.json", b"p")]).unwrap_err();
        assert!(e.contains("plan.json"), "{e}");
        assert!(dir.join("plan.json").is_dir());
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "a temporary file was left");
    }

    #[test]
    fn a_temporary_file_is_always_new() {
        let m = machine("temp");
        let dir = &m.env.clips_root;
        let a = new_temp(dir, "plan.json", b"a").unwrap();
        let b = new_temp(dir, "plan.json", b"b").unwrap();
        assert_ne!(a, b);
        assert_eq!((fs::read(&a).unwrap(), fs::read(&b).unwrap()), (b"a".to_vec(), b"b".to_vec()));
    }
}
