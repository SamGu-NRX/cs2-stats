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
  /** SHA-256 of overrides\botprofile.vpk, sent back with a difficulty change; null when there is none */
  activeProfile: string | null;
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
  /**
   * ready: the supervisor holds the lease and is about to ask Steam; cannotSee: the process list
   * cannot be read; closing: Bot Mode could not be turned off yet. Show the message for both.
   */
  state: "starting" | "ready" | "waiting" | "running" | "cannotSee" | "closing" | "done" | "failed";
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

/** The Bot Mode session, from botmode.session(). Poll it while a session runs. */
export interface SessionView {
  /** whether a supervisor process holds the session lease right now */
  supervised: boolean;
  status: SessionStatus | null;
  /** what session cleanup last said, e.g. that it turned off Bot Mode another tool left on */
  notice: string | null;
}

/** Show this with Bot Mode: the one case a session cannot protect. */
export const UNPROTECTED_NOTICE =
  "Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.";

export interface AppSettings { launchOptions: string }

/** The installed BotRandomizer's cosmetic_catalog.json, as botmode_catalog reads it. */
export interface Catalog {
  /** the ids br_player_music_kit accepts; a name only when the build ships musicKitNames */
  musicKits: { id: number; name: string | null }[];
  /** item definition indexes of the knives a dropped knife can get a finish on */
  knives: number[];
  /** the finish weights br_dropped_knife_premium squares */
  knifeFinishes: { finish: string; weight: number }[];
}

/** `bot_aim` (BotAimImprover); the plugin's default is mixed. */
export type BotAim = "head" | "body" | "mixed";
/** `bot_nades` (NadeSystem); the plugin's default is normal. */
export type BotNades = "off" | "less" | "normal" | "more" | "max";

/** This app's knife-drop bind: `key` spawns `knives` (item definition indexes) with subclass_create. */
export interface KnifeBind { key: string; knives: number[] }

/** Everything this app sets in cfg\gamemode_competitive_server.cfg, from botmode_server_cfg. */
export interface ServerSettings {
  cosmetics: Cosmetics;
  /** null: no line sets it, so the plugin's default applies */
  botAim: BotAim | null;
  botNades: BotNades | null;
  /** null: no bind of this app's; the mod's own knife bind applies */
  knifeBind: KnifeBind | null;
}

/** One change to the server cfg; a field left out keeps what the cfg has. */
export interface ServerPatch { cosmetics?: Cosmetics; botAim?: BotAim; botNades?: BotNades; knifeBind?: KnifeBind }

/** A CS2 of this install running now, judged by its command line (monitor.rs Running). */
export type RunningCs2 =
  | { vac: "off"; pid: number; commandLine: string }
  | { vac: "on"; pid: number; why: string }
  | { vac: "unknown"; pid: number; why: string };

/** One entry of overlay.json as botmode_overlay_plan previews it. */
export interface PlannedEntry { name: string; target: string; files: string[]; repo: string; reference: string }
/** What overlay.json would copy, and the manifest's hash to send back with the confirmation. */
export interface OverlayPlan { sha256: string; entries: PlannedEntry[] }

/** Starts the error of a read that gave up (commands.rs READ_LIMIT). */
export const UNREACHABLE = "Library unreachable";

/** Overrides Steam detection with a game\csgo folder. */
export interface Target { game?: string }

/** How a call reaches the backend: Tauri's invoke, or a stand-in (mock.ts). */
export type Call = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The Bot Mode commands over `call`. */
export function botmodeOver(call: Call) {
  return {
    status: (t: Target = {}) => call<Status>("botmode_status", { ...t }),
    releases: () => call<GithubRelease[]>("botmode_releases"),
    /** Downloads and verifies a release into the app folder; does not touch the game. */
    download: (tag: string, asset?: string, t: Target = {}) => call<ReleaseIndex>("botmode_download", { ...t, tag, asset }),
    install: (tag: string, asset?: string, t: Target = {}) => call<InstallReport>("botmode_install", { ...t, tag, asset }),
    /** Applies %APPDATA%\BotMatchStats\botmode\overlay.json, or `manifest`. */
    /** `previewed`: the plan's sha256; a manifest changed since the preview is refused. */
    overlay: (manifest?: string, previewed?: string, t: Target = {}) => call<OverlayReport>("botmode_overlay", { ...t, manifest, previewed }),
    /** Undoes the newest change; `id` must name that change when given. */
    rollback: (id?: string, t: Target = {}) => call<RollbackReport>("botmode_rollback", { ...t, id }),
    backups: (t: Target = {}) => call<Change[]>("botmode_backups", { ...t }),
    /**
     * Starts a session supervisor process, which turns Bot Mode on, starts CS2 through Steam,
     * watches it until it exits (ending any CS2 of this install without -insecure) and turns
     * Bot Mode off. Resolves once Steam has been asked; closing the app does not end the session.
     */
    launch: (t: Target = {}) => call<SessionView>("botmode_launch", { ...t }),
    session: (t: Target = {}) => call<SessionView>("botmode_session", { ...t }),
    /** `seen`: the active profile's hash as the caller showed it (Status.activeProfile); refused when it has changed. */
    setDifficulty: (level: Difficulty, seen?: { sha256: string | null }, t: Target = {}) => call<Change>("botmode_set_difficulty", { ...t, level, seen }),
    /**
     * Writes all three convars into cfg\gamemode_competitive_server.cfg, keeping every other line.
     * With `seen`, the values this caller read, it writes nothing when the cfg no longer holds them.
     */
    setCosmetics: (cosmetics: Cosmetics, seen?: Cosmetics, t: Target = {}) => call<Change>("botmode_set_cosmetics", { ...t, cosmetics, seen }),
    /** `seen`: the options as the caller showed them; refused when they have changed. */
    setLaunchOptions: (options: string, seen?: string, t: Target = {}) => call<AppSettings>("botmode_set_launch_options", { ...t, options, seen }),
    /** null when BotRandomizer has no catalog in the game folder. */
    catalog: (t: Target = {}) => call<Catalog | null>("botmode_catalog", { ...t }),
    serverCfg: (t: Target = {}) => call<ServerSettings>("botmode_server_cfg", { ...t }),
    /** One change to the server cfg; refused, writing nothing, when it no longer holds `seen`. */
    setServerCfg: (patch: ServerPatch, seen: ServerSettings, t: Target = {}) => call<Change>("botmode_set_server_cfg", { ...t, patch, seen }),
    /** Each CS2 of this install running now, with its VAC state. Reads only; never ends one. */
    running: (t: Target = {}) => call<RunningCs2[]>("botmode_running", { ...t }),
    overlayPlan: (manifest?: string, t: Target = {}) => call<OverlayPlan>("botmode_overlay_plan", { ...t, manifest }),
    /** The game files a recorded change wrote. */
    changeFiles: (id: string, t: Target = {}) => call<string[]>("botmode_change_files", { ...t, id }),
    /** The mod's Commands.txt at `tag`, from GitHub. */
    modCommands: (tag: string) => call<string>("botmode_mod_commands", { tag }),
  };
}

export type BotModeApi = ReturnType<typeof botmodeOver>;

export const botmode: BotModeApi = botmodeOver(invoke);
