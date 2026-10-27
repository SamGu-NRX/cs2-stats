// A render job: everything one supervised launch of CS2 through HLAE needs to record the chosen
// moments, written down before anything runs, so the user sees the exact command and files first.
// The app writes the job's files to %APPDATA%\BotMatchStats\clips\jobs\<id>; nothing touches the game
// until the user confirms the launch (clips.rs clips_launch), which re-checks the command.
//
// The path chosen and why: design/clips.md. HLAE's flags are parsed in advancedfx hlae/Program.cs
// ProcessArgsCustomLoader; the command follows CS2-povforge's hlae.py launch_command (MIT).
import template from "./director.template.js?raw";
import { CLIP_ID } from "./ids";

/** The cfg the launch writes into CS2's cfg folder; its one line loads the director. */
export const CFG_NAME = "cs2stats_clips";

export interface RenderSettings { width: number; height: number; fps: number }
/** 1080p at 60 frames per second, povforge's defaults (hlae.py RecordSettings). */
export const RENDER_DEFAULTS: RenderSettings = { width: 1920, height: 1080, fps: 60 };

/**
 * HLAE's encoder for each take: x264 at CRF 16, povforge's video_options. A take is re-encoded by the
 * finishing template (ffmpeg.ts), so this only needs to be good enough to survive that.
 */
export const TAKE_VIDEO_OPTIONS = "-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 16";

/** One moment to record: its clip id, the demo, the POV player's SteamID64 and the ticks. */
export interface RenderClip { id: string; demoPath: string; steamid: string; startTick: number; endTick: number; tickRate: number; reason: string }

/** Where things are, from the host (clips.rs clips_env) and the user's HLAE choice. */
export interface RenderEnv { clipsDir: string; hlaeExe: string; cs2Exe: string }

export interface RenderJob {
  version: 1;
  id: string;
  created: string;
  settings: RenderSettings;
  /** the job's folder; the director and plan live here, and each take in raw\<clip id> */
  jobDir: string;
  hlae: { exe: string; hookDll: string };
  cs2: { exe: string; args: string[] };
  /** HLAE.exe and its arguments: exactly what the launch runs */
  argv: string[];
  /** argv quoted for a Windows command prompt, for the user to read or run by hand */
  commandLine: string;
  /** written into CS2's cfg folder at launch: game\csgo\cfg\<file> */
  cfg: { file: string; text: string };
  director: { file: string };
  demos: { path: string; tickRate: number; clips: { id: string; steamid: string; start: number; end: number; reason: string }[] }[];
  /** each clip's raw take folder (video.mp4 and audio.wav from HLAE) and its finished file */
  outputs: { id: string; take: string; finished: string; reason: string; durationS: number }[];
}

const WIN = (p: string) => p.replace(/\//g, "\\");
const FWD = (p: string) => p.replace(/\\/g, "/");
const join = (...parts: string[]) => parts.map((p, i) => (i ? p.replace(/^[\\/]+/, "") : p).replace(/[\\/]+$/, "")).join("\\");
const parent = (p: string) => WIN(p).replace(/\\[^\\]+$/, "");

/** A Windows command-line argument, quoted when it holds a space, a tab or a quote (CommandLineToArgvW's rules). */
export function quoteArg(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** The game's own arguments, inside HLAE's -cmdLine. -insecure is required: HLAE injects into the game, and VAC must be off for that. */
export function gameArgs(s: RenderSettings): string[] {
  return ["-insecure", "-novid", "-condebug", "-console", "-sw", "-width", String(s.width), "-height", String(s.height), "+exec", CFG_NAME];
}

/** HLAE's command: its custom loader injects AfxHookSource2 into cs2.exe and starts it with the game's arguments. */
export function hlaeArgv(hlaeExe: string, cs2Exe: string, s: RenderSettings): string[] {
  return [
    WIN(hlaeExe), "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader",
    "-hookDllPath", join(parent(hlaeExe), "x64", "AfxHookSource2.dll"),
    "-programPath", WIN(cs2Exe),
    "-cmdLine", gameArgs(s).join(" "),
  ];
}

/**
 * The console commands the director runs once before the first demo: hide the demo bar, record the
 * screen through HLAE's ffmpeg preset with the game's sound beside it. None of them is a setting CS2
 * saves to the user's config except, possibly, demo_ui_mode (unconfirmed; design/clips.md).
 */
export function setupCommands(s: RenderSettings): string[] {
  return [
    "demo_timescale 1",
    "demo_ui_mode 0",
    "mirv_streams record screen enabled 1",
    // {QUOTE} and {AFX_STREAM_PATH} are HLAE's own placeholders (shared/RecordingSettings.cpp)
    `mirv_streams settings add ffmpeg cs2stats "${TAKE_VIDEO_OPTIONS} {QUOTE}{AFX_STREAM_PATH}\\\\video.mp4{QUOTE}"`,
    "mirv_streams record screen settings cs2stats",
    `mirv_streams record fps ${s.fps}`,
    "mirv_streams record startMovieWav 1",
  ];
}

const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`render plan: ${msg}`); };

/**
 * The job for `clips`, grouped by demo in the order given. Refuses, naming the problem, a clip whose
 * id is not a clip id, whose ticks are not a forward range, or whose player is not a SteamID64 (the
 * director finds the player by it; bots have none), and settings outside 640x360 to 3840x2160 at
 * 24 to 240 fps.
 */
export function buildRenderJob(clips: RenderClip[], env: RenderEnv, s: RenderSettings, now: Date): RenderJob {
  check(clips.length > 0, "no clips chosen");
  check(Number.isInteger(s.width) && Number.isInteger(s.height) && s.width >= 640 && s.height >= 360 && s.width <= 3840 && s.height <= 2160, `size ${s.width}x${s.height} is outside 640x360 to 3840x2160`);
  check(Number.isInteger(s.fps) && s.fps >= 24 && s.fps <= 240, `${s.fps} fps is outside 24 to 240`);
  check(/^hlae\.exe$/i.test(WIN(env.hlaeExe).split("\\").pop() ?? ""), `${env.hlaeExe} is not HLAE.exe`);
  check(/^cs2\.exe$/i.test(WIN(env.cs2Exe).split("\\").pop() ?? ""), `${env.cs2Exe} is not cs2.exe`);
  const seen = new Set<string>();
  for (const c of clips) {
    check(CLIP_ID.test(c.id), `${c.id} is not a clip id`);
    check(!seen.has(c.id), `${c.id} is chosen twice`);
    seen.add(c.id);
    check(Number.isInteger(c.startTick) && Number.isInteger(c.endTick) && c.startTick >= 0 && c.endTick > c.startTick, `${c.id}: ticks ${c.startTick} to ${c.endTick} are not a range`);
    check(/^7656119\d{10}$/.test(c.steamid), `${c.id}: the POV player has no SteamID64, so the director cannot find them`);
    check(/\.dem$/i.test(c.demoPath), `${c.id}: ${c.demoPath} is not a .dem file`);
    check(c.tickRate > 0, `${c.id}: no tick rate`);
  }
  const id = `job-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const jobDir = join(env.clipsDir, "jobs", id);
  const byDemo = new Map<string, RenderClip[]>();
  for (const c of clips) byDemo.set(c.demoPath, [...(byDemo.get(c.demoPath) ?? []), c]);
  const demos = [...byDemo].map(([path, cs]) => {
    const rates = new Set(cs.map((c) => c.tickRate));
    check(rates.size === 1, `${path}: its clips disagree on the tick rate`);
    return {
      path: WIN(path), tickRate: cs[0].tickRate,
      // in demo order, so the director only ever seeks forward within a demo
      clips: [...cs].sort((a, b) => a.startTick - b.startTick).map((c) => ({ id: c.id, steamid: c.steamid, start: c.startTick, end: c.endTick, reason: c.reason })),
    };
  });
  const argv = hlaeArgv(env.hlaeExe, env.cs2Exe, s);
  const director = join(jobDir, "director.js");
  return {
    version: 1, id, created: now.toISOString(), settings: s, jobDir,
    hlae: { exe: argv[0], hookDll: argv[7] },
    cs2: { exe: WIN(env.cs2Exe), args: gameArgs(s) },
    argv, commandLine: argv.map(quoteArg).join(" "),
    cfg: { file: `${CFG_NAME}.cfg`, text: `mirv_script_load "${FWD(director)}"\n` },
    director: { file: director },
    demos,
    outputs: demos.flatMap((d) => d.clips.map((c) => ({
      id: c.id, take: join(jobDir, "raw", c.id), finished: join(env.clipsDir, `${c.id}.mp4`), reason: c.reason, durationS: (c.end - c.start) / d.tickRate,
    }))),
  };
}

/** Timing the director waits on, in rendered frames, and the lead before each clip. povforge's values (hlae.py build_job), not measured here. */
const DIRECTOR_TIMING = { frameStage: 12, bootFrames: 300, loadTimeoutFrames: 20000, seekRetryFrames: 900, finishFrames: 180, seekLeadSeconds: 2 };

/** The director script for the job: the template with the job's demos, clips and setup as JSON. */
export function directorScript(job: RenderJob): string {
  const data = {
    outDir: FWD(join(job.jobDir, "raw")),
    demos: job.demos.map((d) => ({ path: FWD(d.path), tickrate: d.tickRate, clips: d.clips.map(({ id, steamid, start, end }) => ({ id, steamid, start, end })) })),
    setup: setupCommands(job.settings),
    ...DIRECTOR_TIMING,
    quitWhenDone: true,
  };
  if (!template.includes("__CS2STATS_JOB__")) throw new Error("director template has no job placeholder");
  return template.replace("__CS2STATS_JOB__", () => JSON.stringify(data));
}

/** The job's files, as the host writes them into jobDir: the plan for the record and the director. */
export const jobFiles = (job: RenderJob): { name: string; text: string }[] => [
  { name: "plan.json", text: `${JSON.stringify(job, null, 2)}\n` },
  { name: "director.js", text: directorScript(job) },
];
