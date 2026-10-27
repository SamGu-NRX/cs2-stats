// A render job as the app's host builds it (src-tauri/src/clips/job.rs): the web view sends only the
// chosen clips and the HLAE.exe the user picked, and gets back the plan to show. The host builds the
// exact HLAE command, the director script and every path itself, and checks each demo in CS2's
// replays folder; nothing here can change what the launch runs. The types mirror the Rust structs' JSON.

/** One chosen moment: its clip id, its demo's file name in CS2's replays folder, the POV player and the ticks. */
export interface ClipRequest { id: string; demo: string; steamid: string; startTick: number; endTick: number; tickRate: number; reason: string }
export interface JobRequest { clips: ClipRequest[]; hlae: string }

/** The size and rate every take is recorded at (job.rs WIDTH, HEIGHT, FPS). */
export const RENDER = { width: 1920, height: 1080, fps: 60 } as const;

export interface RenderPlan {
  version: number;
  id: string;
  created: string;
  settings: { width: number; height: number; fps: number };
  /** the job's folder: the plan, the director, and each take in raw\<clip id> */
  jobDir: string;
  hlaeExe: string;
  hookDll: string;
  cs2Exe: string;
  /** HLAE.exe and its arguments: exactly what the launch runs */
  argv: string[];
  /** argv quoted for a Windows command prompt */
  commandLine: string;
  /** written into CS2's cfg folder at launch: game\csgo\cfg\<cfgFile> */
  cfgFile: string;
  cfgText: string;
  directorFile: string;
  demos: { path: string; tickRate: number; clips: { id: string; steamid: string; start: number; end: number; reason: string }[] }[];
  outputs: { id: string; take: string; finished: string; reason: string; durationS: number }[];
  request: JobRequest;
}

/** The request for these moments: each with its demo's file name (state.ts demoSource). */
export function jobRequest(clips: { id: string; demo: string; player: string; startTick: number; endTick: number; tickRate: number; reason: string }[], hlae: string): JobRequest {
  return { hlae, clips: clips.map((c) => ({ id: c.id, demo: c.demo, steamid: c.player, startTick: c.startTick, endTick: c.endTick, tickRate: c.tickRate, reason: c.reason })) };
}
