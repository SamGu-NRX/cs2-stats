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
  /** session: a session turning Bot Mode on or off; rollback() never takes a finished one off */
  kind: "normal" | "session";
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
  /** whether a live Bot Mode session is watching CS2 */
  supervised: boolean;
  /** UNPROTECTED_NOTICE */
  notice: string;
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
}

/** One CS2 process the session watch looked at. */
export type Checked =
  | { verdict: "safe"; pid: number; commandLine: string }
  | { verdict: "ended"; pid: number; why: string }
  /** unsafe, and ending it failed; tried again on every poll while it runs */
  | { verdict: "endFailed"; pid: number; why: string; error: string }
  /** its identity could not be checked, so it was not ended: show "close CS2 now" */
  | { verdict: "unverified"; pid: number; why: string };

export type Outcome =
  /** CS2 ran and has exited */
  | { outcome: "exited"; checked: Checked[] }
  | { outcome: "noStart"; lastError: string | null }
  | { outcome: "stopped"; cs2Running: boolean; checked: Checked[] };

/** What the session supervisor reports in its status file. */
export interface SessionStatus {
  runId: string;
  mode: "launch" | "adopt";
  /** cannotSee: the process list cannot be read; show the message ("close CS2 now") */
  state: "starting" | "waiting" | "running" | "cannotSee" | "done" | "failed";
  message: string;
  verdicts: Checked[];
  errors: string[];
  /** Unix seconds of the supervisor's last poll */
  heartbeat: number;
  outcome: Outcome | null;
  botModeOn: Change | null;
  botModeOff: Change | null;
  /** why Bot Mode was left on at the end, if it was */
  leftOn: string | null;
}

/**
 * A Bot Mode session of this app died with Bot Mode on. CS2 Stats cannot tell whether the current
 * gameinfo.gi is that session's or another tool's (the Bot-Improver Panel keeps Bot Mode on by
 * editing the same file), so it changes nothing and asks. Answer with botmode.recover().
 */
export interface Recovery {
  /** the prompt to show; it says that "Leave it on" keeps another tool's setting */
  message: string;
  /** gameinfo.gi, the one file "off" writes */
  file: string;
  /** the lines "off" removes, as they read now, including any another tool added */
  lines: string[];
  /** gameinfo.gi's SHA-256 when the prompt was read; recover("off") refuses once the file differs */
  hash: string;
}

/** What botmode.recover() did. */
export interface Recovered {
  /** the change that turned Bot Mode off; null when nothing was written */
  change: Change | null;
  message: string;
}

/** The Bot Mode session, from botmode.session(). Poll it while a session runs. */
export interface SessionView {
  /** whether a supervisor process holds the session lease right now */
  supervised: boolean;
  status: SessionStatus | null;
  /** what session cleanup last said, e.g. that Bot Mode is managed by another tool */
  notice: string | null;
  /** the recovery prompt, read from the files on every call; null when there is nothing to ask */
  recovery: Recovery | null;
}

/** An answer to the recovery prompt: "off" names the hash the prompt carried. */
export type RecoverAnswer = { action: "off"; expectHash: string } | { action: "leave" };

/** Show this with Bot Mode: the one case a session cannot protect. */
export const UNPROTECTED_NOTICE =
  "Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.";

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
   * Starts a session supervisor process, which turns Bot Mode on, starts CS2 through Steam,
   * watches it until it exits (ending any CS2 of this install without -insecure) and turns
   * Bot Mode off. Resolves once Steam has been asked; closing the app does not end the session.
   */
  launch: (t: Target = {}) => invoke<SessionView>("botmode_launch", { ...t }),
  session: (t: Target = {}) => invoke<SessionView>("botmode_session", { ...t }),
  /**
   * Answers the recovery prompt. "off" turns Bot Mode off only while gameinfo.gi still has
   * `expectHash`; "leave" changes nothing. Either stops the prompt. Rejects while CS2 is running.
   */
  recover: (answer: RecoverAnswer, t: Target = {}) => invoke<Recovered>("botmode_recover", { ...t, ...answer }),
  setDifficulty: (level: Difficulty, t: Target = {}) => invoke<Change>("botmode_set_difficulty", { ...t, level }),
  /** Writes all three convars into cfg\gamemode_competitive_server.cfg, keeping every other line. */
  setCosmetics: (cosmetics: Cosmetics, t: Target = {}) => invoke<Change>("botmode_set_cosmetics", { ...t, cosmetics }),
  setLaunchOptions: (options: string, t: Target = {}) => invoke<AppSettings>("botmode_set_launch_options", { ...t, options }),
};
