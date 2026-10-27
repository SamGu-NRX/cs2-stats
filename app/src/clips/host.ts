// Typed calls to the clips commands in src-tauri/src/clips/mod.rs; the types mirror the Rust structs'
// JSON. The web view sends typed requests only: clip ids, demo file names, ticks and the lower third's
// text; the host builds every command and path. Only the desktop app has these: the browser build
// lists moments but cannot check demos or render.
import { isTauri } from "../host/host";
import type { JobRequest, RenderPlan } from "./plan";

/** Where a tool is, or why it was not found. */
export interface Found { path: string | null; error: string | null }
export interface ClipsEnv { clipsDir: string; cs2: Found; replays: Found; hlae: Found; ffmpeg: Found; font: string | null }
export interface DemoOnDisk { name: string; path: string | null; size: number }
export interface Finished { id: string; path: string; size: number; mtime: number }
export interface Take { id: string; job: string; video: string; audio: string | null; mtime: number }
export interface ClipsScan { finished: Finished[]; takes: Take[]; reels: Finished[] }
export interface Launched { pid: number; cfg: string; ffmpegIni: string | null }
/** An FFmpeg run: its exit code, the end of what it wrote to stderr when it failed, and the file it wrote. */
export interface FfmpegRun { code: number | null; error: string | null; output: string }
/** A take to finish: the clip, the job that recorded it, the lower third's two lines (personal info already hidden when the setting is on) and the clip's length. */
export interface FinishRequest { id: string; job: string; reason: string; subline: string; durationS: number }

export interface ClipsHost {
  /** `hlae`: the HLAE.exe the user chose, if any */
  env(hlae: string | null): Promise<ClipsEnv>;
  demos(names: string[]): Promise<DemoOnDisk[]>;
  scan(): Promise<ClipsScan>;
  /** builds the job for the chosen clips; with `write`, saves it as a new job folder. Touches nothing outside the clips folder. */
  plan(request: JobRequest, write: boolean): Promise<RenderPlan>;
  /** starts CS2 through HLAE for a saved job: only after the user confirms */
  launch(job: string): Promise<Launched>;
  finish(r: FinishRequest, hlae: string | null): Promise<FfmpegRun>;
  /** joins finished clips, in order, into a new reel */
  reel(ids: string[], hlae: string | null): Promise<FfmpegRun>;
}

async function tauriClips(): Promise<ClipsHost> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    env: (hlae) => invoke("clips_env", { hlae }),
    demos: (names) => invoke("clips_demos", { names }),
    scan: () => invoke("clips_scan"),
    plan: (request, write) => invoke("clips_plan", { request, write }),
    launch: (job) => invoke("clips_launch", { job }),
    finish: (r, hlae) => invoke("clips_finish", { id: r.id, job: r.job, reason: r.reason, subline: r.subline, durationS: r.durationS, hlae }),
    reel: (ids, hlae) => invoke("clips_reel", { ids, hlae }),
  };
}

/** The desktop app's clips commands; null in the browser. */
export const clipsHost = (): Promise<ClipsHost | null> => (isTauri() ? tauriClips() : Promise.resolve(null));

const HLAE_KEY = "cs2stats.hlae";
/** The HLAE.exe the user chose last; null when none was saved or storage is blocked. */
export function savedHlae(): string | null {
  try { return localStorage.getItem(HLAE_KEY) || null; } catch { return null; }
}
export function saveHlae(path: string): void {
  try { localStorage.setItem(HLAE_KEY, path); } catch { /* kept for this session only */ }
}
