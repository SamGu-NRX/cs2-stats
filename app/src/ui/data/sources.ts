// Where a match came from, and what that source can and cannot support. These sources exist:
// - recorded: written by the capture plugin (aim, movement positions, economy, utility purchases);
// - converted: an older console log converted to the plugin format (no aim, no movement;
//   rounds held as totals only are left out);
// - pro: a pro match demo, extracted to tables: a map from the pro match library folder the user picks
//   in Data & settings ("pro/..." paths, host.ts), or in `vite dev` a folder of CS2_DEV_MATCHES
//   ("dev/<folder>"). They open from Matches' Pro view like any match, with no recording player, and
//   are never part of the user's career (data/engine.ts isOwn);
// - synthetic: the generated demo match (?demo=synthetic);
// - valve: one of the user's Valve matchmaking demos, extracted by extractor/valve_import.py
//   (match.source "valve");
// - local: a demo CS2 recorded during one of the user's Bot Mode matches, extracted by
//   extractor/local_import.py ("local/<demo id>/<version>" paths, host.ts). Its tables say source
//   "local", as the plugin adapter's do, so the path decides. When it pairs with a plugin file
//   (data/local.ts), it is the match and the plugin file drops out of career views (engine.ts).
import type { MatchEntry } from "./match";
import { CACHE_TOO_NEW } from "../../worker/protocol";

export type SourceId = "recorded" | "converted" | "pro" | "synthetic" | "valve" | "local";

export interface SourceInfo {
  id: SourceId;
  label: string;
  /** what the source lacks, shown next to the label */
  missing: string[];
}

/**
 * A pro demo: an extracted map from the pro match library (host.ts, "pro/<archive>/<map>...") or a
 * dev match folder ("dev/<folder>"). Nobody recorded it, so it has no recording player (MatchEntry.you).
 */
export const isProFile = (file: string) => file.startsWith("pro/") || file.startsWith("dev/");

/** A recorded demo's tables: local_import.py's output as host.ts lists it. */
export const isLocalFile = (file: string) => file.startsWith("local/");

export const SOURCE_LABEL: Record<SourceId, string> = { recorded: "Recorded", converted: "Converted log", pro: "Pro demo", synthetic: "Synthetic", valve: "Valve", local: "Recorded demo" };

/** From the file's path (a pro or recorded demo), the match's source (a Valve demo), the plugin's own label for the file (env.plugin), and whether it holds shots and positions. */
export function sourceOf(e: Pick<MatchEntry, "file" | "origin" | "hasAim" | "hasPos" | "match">): SourceInfo {
  if (isProFile(e.file)) return { id: "pro", label: SOURCE_LABEL.pro, missing: [] };
  if (isLocalFile(e.file)) {
    if (e.match.source !== "local") throw new Error(`${e.file}: a recorded demo's folder holds a "${e.match.source}" match`);
    return { id: "local", label: SOURCE_LABEL.local, missing: [] };
  }
  const id: SourceId = e.match.source === "valve" ? "valve" : e.origin === "legacy-convert" ? "converted" : e.origin === "synthetic-demo" ? "synthetic" : "recorded";
  if (id === "converted") return { id, label: SOURCE_LABEL[id], missing: ["aim", "movement"] };
  const missing: string[] = [];
  if (!e.hasAim) missing.push("aim");
  if (!e.hasPos) missing.push("movement");
  return { id, label: SOURCE_LABEL[id], missing };
}

/** Which stats each source supports, for Data & settings. A string is a partial yes, and says what is missing. */
export const SUPPORT: { stat: string; recorded: boolean | string; converted: boolean | string; pro: boolean | string; local: boolean | string }[] = [
  { stat: "Scoreboard: kills, deaths, assists, ADR, KAST, rating", recorded: true, converted: true, pro: true, local: true },
  { stat: "Round swing", recorded: true, converted: "Only rounds where every player's equipment is known", pro: true, local: true },
  { stat: "Kill-by-kill rounds", recorded: true, converted: "Rounds the log holds only as the game's totals are left out of every number", pro: true, local: true },
  { stat: "Economy and buy types", recorded: true, converted: true, pro: true, local: true },
  { stat: "Utility thrown and flashes", recorded: true, converted: true, pro: true, local: true },
  { stat: "Kill and death positions", recorded: true, converted: true, pro: true, local: true },
  { stat: "Accuracy and first bullet", recorded: true, converted: false, pro: true, local: true },
  // plugin files carry no view angles or mesh line of sight, which these timings need
  { stat: "Time to damage, reaction and crosshair placement", recorded: false, converted: false, pro: true, local: true },
];

/** Notes on rows, shown as footnotes under the support table. */
export const SUPPORT_NOTE: Record<string, string> = {
  "Time to damage, reaction and crosshair placement": "These need view angles and the map's line of sight, which recorded and converted files do not carry.",
};

/**
 * A failed scan in plain words, with what to do; the raw error stays available for a details
 * disclosure. Reads Node's and Rust's error codes for the common causes.
 */
export function scanErrorText(raw: string): string {
  if (raw === CACHE_TOO_NEW) return raw;
  const path = /'([^']+)'/.exec(raw)?.[1] ?? /"([^"]+)"/.exec(raw)?.[1] ?? null;
  const at = path ? `: ${path}` : "";
  if (/ENOTDIR|not a directory/i.test(raw)) return `The match folder is a file, not a folder${at}. Move or rename that file, then try again.`;
  if (/ENOENT|cannot find the path|no such file/i.test(raw)) return `The match folder does not exist${at}. It appears after your first recorded match; or import match files from Data & settings.`;
  if (/EACCES|EPERM|access is denied|permission denied/i.test(raw)) return `The app is not allowed to read the match folder${at}. Check the folder's permissions, then try again.`;
  return "The match folder could not be read. Try again; if it keeps failing, the details below say why.";
}
