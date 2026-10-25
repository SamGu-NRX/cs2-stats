// Where a match came from, and what that source can and cannot support. Three sources exist:
// - recorded: written by the capture plugin (aim, movement positions, economy, utility purchases);
// - converted: an older console log converted by tools/convert-legacy.ts (no aim, no movement,
//   early rounds may have totals only);
// - synthetic: the generated demo match (?demo=synthetic).
import type { MatchView } from "../../stats/derive";
import type { LightSummary } from "../../worker/protocol";

export type SourceId = "recorded" | "converted" | "synthetic";

export interface SourceInfo {
  id: SourceId;
  label: string;
  /** what the source lacks, shown next to the label */
  missing: string[];
}

const MISSING: Record<SourceId, string[]> = {
  recorded: [],
  converted: ["aim", "movement"],
  synthetic: [],
};

export const SOURCE_LABEL: Record<SourceId, string> = { recorded: "Recorded", converted: "Converted log", synthetic: "Synthetic" };

/** From the match file itself (env.plugin), when the full view is loaded. */
export function sourceOfView(v: Pick<MatchView, "env" | "hasAim" | "hasPos">): SourceInfo {
  const p = v.env.plugin ?? "";
  const id: SourceId = p === "legacy-convert" ? "converted" : p === "synthetic-demo" ? "synthetic" : "recorded";
  const missing = [...MISSING[id]];
  if (id === "recorded") {
    if (!v.hasAim) missing.push("aim");
    if (!v.hasPos) missing.push("movement");
  }
  return { id, label: SOURCE_LABEL[id], missing };
}

/**
 * From a cached summary. Summaries do not carry env.plugin, so this reads the file name (the demo)
 * and whether aim or positions were recorded. Interim: the engine is asked to add env.plugin to
 * MatchSummary, which makes this exact.
 */
export function sourceOfSummary(s: Pick<LightSummary, "file" | "aim" | "hasPos">): SourceInfo {
  if (/synthetic-demo/.test(s.file)) return { id: "synthetic", label: SOURCE_LABEL.synthetic, missing: [] };
  if (s.aim || s.hasPos) {
    const missing: string[] = [];
    if (!s.aim) missing.push("aim");
    if (!s.hasPos) missing.push("movement");
    return { id: "recorded", label: SOURCE_LABEL.recorded, missing };
  }
  return { id: "converted", label: SOURCE_LABEL.converted, missing: [...MISSING.converted] };
}

/** Which stats each source supports, for the Data page. */
export const SUPPORT: { stat: string; recorded: boolean; converted: boolean | "partial" }[] = [
  { stat: "Scoreboard: K, D, A, ADR, KAST, rating", recorded: true, converted: true },
  { stat: "Round swing", recorded: true, converted: "partial" },
  { stat: "Kill-by-kill rounds", recorded: true, converted: "partial" },
  { stat: "Economy and buy types", recorded: true, converted: true },
  { stat: "Utility thrown and flashes", recorded: true, converted: true },
  { stat: "Utility bought and held at death", recorded: true, converted: false },
  { stat: "Kill and death positions", recorded: true, converted: true },
  { stat: "Movement heatmap", recorded: true, converted: false },
  { stat: "Accuracy, spray, hit map", recorded: true, converted: false },
  { stat: "Time to damage, reaction, crosshair", recorded: true, converted: false },
];

export const SUPPORT_NOTE: Record<string, string> = {
  "Round swing": "Converted logs have swing where every player's equipment is known.",
  "Kill-by-kill rounds": "Converted logs may hold only the game's round totals for the first rounds.",
};
