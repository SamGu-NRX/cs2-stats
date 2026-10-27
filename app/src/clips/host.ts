// Typed calls to the clips commands in src-tauri/src/clips.rs; the types mirror the Rust structs'
// JSON. Only the desktop app has them: the browser build lists moments but cannot check demos or render.
import { isTauri } from "../host/host";

/** Where a tool is, or why it was not found. */
export interface Found { path: string | null; error: string | null }
export interface ClipsEnv { clipsDir: string; cs2: Found; replays: Found; hlae: Found; ffmpeg: Found; font: string | null }
export interface DemoOnDisk { name: string; path: string | null; size: number }
export interface Finished { id: string; path: string; size: number; mtime: number }
export interface Take { id: string; job: string; video: string; audio: string | null; mtime: number }
export interface ClipsScan { finished: Finished[]; takes: Take[]; reels: Finished[] }
export interface Launched { pid: number; cfg: string; ffmpegIni: string | null }
export interface FfmpegRun { code: number | null; error: string | null }
export interface NamedText { name: string; text: string }

export interface ClipsHost {
  /** `hlae`: the HLAE.exe the user chose, if any */
  env(hlae: string | null): Promise<ClipsEnv>;
  demos(names: string[]): Promise<DemoOnDisk[]>;
  scan(): Promise<ClipsScan>;
  /** writes plan.json and director.js into jobs\<job>; touches nothing outside the clips folder */
  saveJob(job: string, files: NamedText[]): Promise<string>;
  /** starts CS2 through HLAE for a saved job: only after the user confirms */
  launch(job: string): Promise<Launched>;
  ffmpeg(args: string[], texts: NamedText[], hlae: string | null): Promise<FfmpegRun>;
}

async function tauriClips(): Promise<ClipsHost> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    env: (hlae) => invoke("clips_env", { hlae }),
    demos: (names) => invoke("clips_demos", { names }),
    scan: () => invoke("clips_scan"),
    saveJob: (job, files) => invoke("clips_save_job", { job, files }),
    launch: (job) => invoke("clips_launch", { job }),
    ffmpeg: (args, texts, hlae) => invoke("clips_ffmpeg", { args, texts, hlae }),
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
