// Typed calls to the Bot Mode commands in src-tauri/src/botmode/commands.rs. The types mirror
// the Rust structs' JSON. Every command finds CS2 through Steam unless `game` names the
// game\csgo folder. Every command that writes game files rejects while cs2.exe is running,
// backs up what it replaces, and can be undone with rollback().

import { invoke } from "@tauri-apps/api/core";

export type Difficulty = "low" | "medium" | "high";

export interface SourceLink {
  /** "https://github.com/owner/repo" */
  repo: string;
  /** branch or tag the build came from */
  reference: string;
  commit: string | null;
  /** the source at that commit (AGPL source link) */
  url: string;
}

export interface Change {
  seq: number;
  id: string;
  operation: string;
  /** UTC, ISO 8601 */
  created: string;
  /** inProgress and rollbackPending must be rolled back before any other change */
  status: "inProgress" | "complete" | "rolledBack" | "failed" | "rollbackPending";
  /** files written */
  files: number;
  error: string | null;
  /** folders Windows would not flush to disk */
  warnings: string[];
}

export interface Cosmetics {
  /** br_dropped_knife_skins */
  droppedKnifeSkins: boolean;
  /** br_dropped_knife_premium */
  droppedKnifePremium: boolean;
  /** br_player_music_kit: 0 off, -1 random per map, otherwise a kit id */
  musicKit: number;
}

export interface CosmeticsState extends Cosmetics {
  /** whether cfg\gamemode_competitive_server.cfg exists; missing values are the plugin defaults */
  cfgPresent: boolean;
}

export type ComponentState = "official" | "overlay" | "modified" | "notInRelease" | "unknown" | "missing";

export interface Component {
  name: string;
  state: ComponentState;
  /** combined SHA-256 of the files present */
  sha256: string | null;
  /** game path -> SHA-256 */
  files: Record<string, string>;
  differs: string[];
  missing: string[];
  overlay: SourceLink | null;
}

export interface InstalledRelease {
  tag: string;
  asset: string;
  installedAt: string;
  source: SourceLink;
}

export interface OverlayRecord {
  name: string;
  target: string;
  files: Record<string, string>;
  source: SourceLink;
  appliedAt: string;
}

export interface Status {
  csgo: string;
  steam: string | null;
  buildId: string | null;
  /** null when the process list could not be read (see warnings) */
  cs2Running: boolean | null;
  /** whether gameinfo.gi has the Bot Mode search paths */
  botMode: boolean | null;
  release: {
    installed: InstalledRelease | null;
    /** the release the files were compared with */
    reference: string | null;
    matching: number;
    total: number;
  };
  /** null when the active bot profile matches none of the three shipped levels */
  difficulty: Difficulty | null;
  cosmetics: CosmeticsState;
  steamLaunchOptions: string | null;
  launchOptions: string;
  components: Component[];
  /** protected user files -> SHA-256; never replaced */
  protected: Record<string, string>;
  overlays: OverlayRecord[];
  /** newest first */
  backups: Change[];
  /** an interrupted or partly undone change; offer rollback() before anything else */
  unfinished: Change | null;
  warnings: string[];
}

/** GitHub's release JSON, as the API returns it. */
export interface GithubRelease {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: { name: string; size: number; digest: string | null; browser_download_url: string }[];
}

export interface Skipped { path: string; reason: string }

export interface ReleaseIndex {
  tag: string;
  asset: string;
  sha256: string;
  source: SourceLink;
  files: Record<string, string>;
  skipped: Skipped[];
  botSearchPaths: string[];
}

export interface InstallReport {
  change: Change;
  tag: string;
  asset: string;
  source: SourceLink;
  written: number;
  unchanged: number;
  skipped: Skipped[];
  kept: string[];
  merged: string[];
  /** my_bot_*_config.cfg files installed with the user's own convar values kept */
  userValuesKept: string[];
  botModeEnabled: boolean;
  difficultyKept: Difficulty | null;
  /** overlays the release replaced; overlay() puts them back */
  overlaysReplaced: string[];
}

export interface OverlayReport {
  manifest: string;
  change: Change;
  entries: { name: string; target: string; files: number; written: number; source: SourceLink; warnings: string[] }[];
}

export interface RollbackReport { id: string; operation: string; restored: number; removed: number; unchanged: number; warnings: string[] }

export interface LaunchPlan {
  steamExe: string;
  /** always starts with -applaunch 730 -insecure */
  args: string[];
  botModeChange: Change | null;
}

/** One CS2 process the post-launch check looked at. */
export type Checked =
  | { verdict: "safe"; pid: number; commandLine: string }
  | { verdict: "ended"; pid: number; why: string; ended: { Ok: null } | { Err: string } }
  | { verdict: "otherInstall"; pid: number; image: string };

export type Outcome =
  | { outcome: "safe"; checked: Checked[] }
  | { outcome: "unsafe"; checked: Checked[] }
  | { outcome: "timedOut"; lastError: string | null }
  | { outcome: "stopped" };

/** The post-launch check, from botmode.launchCheck() or the LAUNCH_CHECK_EVENT event. */
export interface LaunchCheck {
  phase: "waiting" | "done";
  /** e.g. "waiting for CS2 to start (Steam may be updating)" */
  message: string;
  outcome: Outcome | null;
}

/** Event emitted by the app as the post-launch check progresses; the payload is a LaunchCheck. */
export const LAUNCH_CHECK_EVENT = "botmode-launch-check";

export interface AppSettings { launchOptions: string }

/** Overrides Steam detection with a game\csgo folder. */
export interface Target { game?: string }

export const botmode = {
  status: (t: Target = {}) => invoke<Status>("botmode_status", { ...t }),
  releases: () => invoke<GithubRelease[]>("botmode_releases"),
  /** Downloads and verifies a release into the app folder; does not touch the game. */
  download: (tag: string, asset?: string, t: Target = {}) => invoke<ReleaseIndex>("botmode_download", { ...t, tag, asset }),
  install: (tag: string, asset?: string, t: Target = {}) => invoke<InstallReport>("botmode_install", { ...t, tag, asset }),
  /** Applies %APPDATA%\BotMatchStats\botmode\overlay.json, or `manifest`. */
  overlay: (manifest?: string, t: Target = {}) => invoke<OverlayReport>("botmode_overlay", { ...t, manifest }),
  /** Undoes the newest change; `id` must name that change when given. */
  rollback: (id?: string, t: Target = {}) => invoke<RollbackReport>("botmode_rollback", { ...t, id }),
  backups: (t: Target = {}) => invoke<Change[]>("botmode_backups", { ...t }),
  /**
   * Asks Steam to start CS2 and resolves at once. The app then checks every new CS2 of this
   * install, with no time limit, and ends any without -insecure; follow it with launchCheck()
   * or the LAUNCH_CHECK_EVENT event.
   */
  launch: (t: Target = {}) => invoke<LaunchPlan>("botmode_launch", { ...t }),
  /** The latest post-launch check, or null before the first launch. */
  launchCheck: () => invoke<LaunchCheck | null>("botmode_launch_check"),
  setDifficulty: (level: Difficulty, t: Target = {}) => invoke<Change>("botmode_set_difficulty", { ...t, level }),
  /** Writes all three convars into cfg\gamemode_competitive_server.cfg, keeping every other line. */
  setCosmetics: (cosmetics: Cosmetics, t: Target = {}) => invoke<Change>("botmode_set_cosmetics", { ...t, cosmetics }),
  setLaunchOptions: (options: string, t: Target = {}) => invoke<AppSettings>("botmode_set_launch_options", { ...t, options }),
};
