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
    pub id: String,
    /// the demo's file name in CS2's replays folder
    pub demo: String,
    pub steamid: String,
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
    /// argv quoted for a Windows command prompt, for the user to read or run by hand
    pub command_line: String,
    pub cfg_file: String,
    pub cfg_text: String,
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

/// A Windows command-line argument, quoted when it holds a space, a tab or a quote (CommandLineToArgvW's rules).
pub fn quote_arg(a: &str) -> String {
    if !a.is_empty() && !a.chars().any(|c| c.is_whitespace() || c == '"') {
        return a.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in a.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            c => {
                out.push_str(&"\\".repeat(slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
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
        command_line: argv.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" "),
        argv,
        cfg_file: format!("{CFG_NAME}.cfg"),
        cfg_text: format!("mirv_script_load \"{}\"\n", fwd(&director.display().to_string())),
        director_file: director.display().to_string(),
        demos,
        outputs,
        request: req.clone(),
    };
    let script = director_script(&plan)?;
    Ok((plan, script))
}

/// Timing the director waits on, in rendered frames, and the lead before each clip: povforge's values
/// (hlae.py build_job), not measured here.
fn director_job(plan: &Plan) -> serde_json::Value {
    json!({
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
pub fn director_script(plan: &Plan) -> Result<String, String> {
    if TEMPLATE.matches(PLACEHOLDER).count() != 1 {
        return Err("the director template must hold its job placeholder exactly once".into());
    }
    Ok(TEMPLATE.replacen(PLACEHOLDER, &director_job(plan).to_string(), 1))
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

/// Writes `files` into `dir` so that none is ever half-written or missing its partner: each goes to a
/// temporary name first, then all are renamed in order. The plan is renamed last, so a plan never
/// exists without its director. On a failure the temporary files are removed.
pub fn write_together(dir: &Path, files: &[(&str, &str)]) -> Result<(), String> {
    let tmp = |n: &str| dir.join(format!("{n}.tmp"));
    let clean = || for (n, _) in files { let _ = fs::remove_file(tmp(n)); };
    for (n, text) in files {
        if let Err(e) = fs::write(tmp(n), text) {
            clean();
            return Err(format!("{}: {e}", tmp(n).display()));
        }
    }
    for (n, _) in files {
        if let Err(e) = fs::rename(tmp(n), dir.join(n)) {
            clean();
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
    write_together(&dir, &[("director.js", script), ("plan.json", &plan_json)])
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "76561190000000001";
    const A1: &str = "c-00000000000000aa-r3";
    const A2: &str = "c-00000000000000aa-r9";
    const B1: &str = "c-00000000000000bb-r1";
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
        for d in ["match730_0001.dem", "match730_0002.dem"] {
            fs::write(replays.join(d), b"demo").unwrap();
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
    fn clip(id: &str, demo: &str, start: i64, end: i64) -> ClipReq {
        ClipReq { id: id.into(), demo: demo.into(), steamid: ME.into(), start_tick: start, end_tick: end, tick_rate: 64.0, reason: format!("reason {id}") }
    }
    fn req(m: &Machine, clips: Vec<ClipReq>) -> JobReq {
        JobReq { clips, hlae: m.hlae.display().to_string() }
    }

    #[test]
    fn the_command_is_the_fixed_template_with_insecure_first_in_the_games_arguments() {
        let m = machine("argv");
        let (plan, _) = build(&req(&m, vec![clip(A1, "match730_0001.dem", 1000, 2000)]), &m.env, ID, "t").unwrap();
        let hook = m.hlae.parent().unwrap().join("x64").join("AfxHookSource2.dll");
        assert_eq!(plan.argv, [
            m.hlae.display().to_string().as_str(), "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader",
            "-hookDllPath", hook.display().to_string().as_str(), "-programPath", m.env.cs2_exe.display().to_string().as_str(),
            "-cmdLine", "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips",
        ]);
        assert!(plan.command_line.ends_with(r#"-cmdLine "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips""#));
    }

    #[test]
    fn the_job_lives_in_its_own_folder_and_the_cfg_loads_its_director() {
        let m = machine("dir");
        let (plan, script) = build(&req(&m, vec![clip(A1, "match730_0001.dem", 1000, 2280)]), &m.env, ID, "t").unwrap();
        let dir = m.env.clips_root.join("jobs").join(ID);
        assert_eq!(plan.job_dir, dir.display().to_string());
        assert_eq!(plan.cfg_text, format!("mirv_script_load \"{}/director.js\"\n", dir.display().to_string().replace('\\', "/")));
        assert_eq!(plan.outputs[0].finished, m.env.clips_root.join(format!("{A1}.mp4")).display().to_string());
        assert_eq!(plan.outputs[0].duration_s, 20.0);
        // the director holds the job, with the demo's resolved path and no reason text
        let job = script.split("const JOB = ").nth(1).unwrap().split(";\n").next().unwrap();
        let v: serde_json::Value = serde_json::from_str(job).unwrap();
        assert_eq!(v["demos"][0]["path"], m.env.replays.join("match730_0001.dem").display().to_string().replace('\\', "/"));
        assert_eq!(v["demos"][0]["clips"][0], json!({ "id": A1, "steamid": ME, "start": 1000, "end": 2280 }));
        // the keys director.template.js reads, which src/clips/director.test.ts's fixture copies
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["bootFrames", "demos", "finishFrames", "frameStage", "loadTimeoutFrames", "outDir", "quitWhenDone", "seekLeadSeconds", "seekRetryFrames", "setup"]);
        assert_eq!(v["demos"][0]["tickrate"], 64.0);
        assert!(!v["setup"].as_array().unwrap().iter().any(|c| c.as_str().unwrap().contains("demo_ui_mode")), "the director, not setup, owns demo_ui_mode");
        assert!(!script.contains("reason c-"));
        assert!(!script.contains(PLACEHOLDER));
    }

    #[test]
    fn clips_group_by_demo_in_the_order_chosen_each_demo_in_tick_order() {
        let m = machine("group");
        let r = req(&m, vec![clip(A2, "match730_0001.dem", 9000, 9500), clip(B1, "match730_0002.dem", 100, 900), clip(A1, "match730_0001.dem", 1000, 2000)]);
        let (plan, _) = build(&r, &m.env, ID, "t").unwrap();
        let got: Vec<(String, Vec<String>)> = plan.demos.iter().map(|d| (Path::new(&d.path).file_name().unwrap().to_string_lossy().into(), d.clips.iter().map(|c| c.id.clone()).collect())).collect();
        assert_eq!(got, [("match730_0001.dem".into(), vec![A1.to_string(), A2.into()]), ("match730_0002.dem".into(), vec![B1.to_string()])]);
    }

    #[test]
    fn a_request_the_director_cannot_record_is_refused_by_name() {
        let m = machine("bad");
        let ok = clip(A1, "match730_0001.dem", 1000, 2000);
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
        let rates = build(&req(&m, vec![ok.clone(), ClipReq { id: A2.into(), tick_rate: 128.0, ..ok.clone() }]), &m.env, ID, "t").unwrap_err();
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
        let e = build(&req(&m, vec![clip(A1, "evil.dem", 1000, 2000)]), &m.env, ID, "t").unwrap_err();
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
        let (plan, script) = build(&req(&m, vec![clip(A1, "match730_0001.dem", 1000, 2000)]), &m.env, ID, "t").unwrap();
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
        let e = write_together(&dir, &[("director.js", "d"), ("plan.json", "p")]).unwrap_err();
        assert!(e.contains("plan.json"), "{e}");
        assert!(dir.join("plan.json").is_dir() && !dir.join("plan.json.tmp").exists() && !dir.join("director.js.tmp").exists());
    }
}
