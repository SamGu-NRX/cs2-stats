// Where a match came from, and what that source can and cannot support. Four sources exist:
// - recorded: written by the capture plugin (aim, movement positions, economy, utility purchases);
// - converted: an older console log converted by tools/convert-legacy.ts (no aim, no movement;
//   rounds held as totals only are left out);
// - synthetic: the generated demo match (?demo=synthetic);
// - valve: one of the user's Valve matchmaking demos, extracted by extractor/valve_import.py
//   (match.source "valve").
import type { MatchEntry } from "./match";

export type SourceId = "recorded" | "converted" | "synthetic" | "valve";

export interface SourceInfo {
  id: SourceId;
  label: string;
  /** what the source lacks, shown next to the label */
  missing: string[];
}

export const SOURCE_LABEL: Record<SourceId, string> = { recorded: "Recorded", converted: "Converted log", synthetic: "Synthetic", valve: "Valve" };

/** From the match's source (a Valve demo), else the plugin's own label for the file (env.plugin), and whether it holds shots and positions. */
export function sourceOf(e: Pick<MatchEntry, "origin" | "hasAim" | "hasPos" | "match">): SourceInfo {
  const id: SourceId = e.match.source === "valve" ? "valve" : e.origin === "legacy-convert" ? "converted" : e.origin === "synthetic-demo" ? "synthetic" : "recorded";
  if (id === "converted") return { id, label: SOURCE_LABEL[id], missing: ["aim", "movement"] };
  const missing: string[] = [];
  if (!e.hasAim) missing.push("aim");
  if (!e.hasPos) missing.push("movement");
  return { id, label: SOURCE_LABEL[id], missing };
}

/** Which stats each source supports, for the Data page. */
export const SUPPORT: { stat: string; recorded: boolean; converted: boolean | "partial" }[] = [
  { stat: "Scoreboard: K, D, A, ADR, KAST, rating", recorded: true, converted: true },
  { stat: "Round swing", recorded: true, converted: "partial" },
  { stat: "Kill-by-kill rounds", recorded: true, converted: "partial" },
  { stat: "Economy and buy types", recorded: true, converted: true },
  { stat: "Utility thrown and flashes", recorded: true, converted: true },
  { stat: "Kill and death positions", recorded: true, converted: true },
  { stat: "Accuracy and first bullet", recorded: true, converted: false },
  { stat: "Time to damage, reaction, crosshair", recorded: false, converted: false },
];

export const SUPPORT_NOTE: Record<string, string> = {
  "Round swing": "Converted logs have swing where every player's equipment is known.",
  "Kill-by-kill rounds": "Rounds a converted log holds only as the game's totals are left out of every number.",
  "Time to damage, reaction, crosshair": "These need view angles and mesh line of sight, which plugin files do not carry.",
};
