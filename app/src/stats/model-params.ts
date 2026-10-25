// The one loader for the rating model and the round win-probability source. The rating model is
// model/rating3/params.json (the rating, swing and duel blocks); the win-probability source is HLTV's
// lookup when the private pack %APPDATA%\BotMatchStats\packs\winprob-hltv.json is supplied, else the
// CS2RB round model in model/export. rating3.ts, swing.ts and winprob.ts read through this file; no
// constant is copied into TypeScript.
import raw from "../../../model/rating3/params.json";

export interface RatingParams {
  rating: {
    version: string;
    /** approximation, as params.json states it */
    status: string;
    /** which formula the coefficients belong to; rating3.ts implements only the basis it names */
    basis: string;
    features: string[];
    intercept: number;
    coefficients: Record<string, number>;
  };
  swing: {
    trade_window_seconds: number;
    round_end_remainder: { clutcher_weight: number; kill_swing_player_weight: number; defuser_weight: number; survivor_weight: number };
  };
  duel: { groups: string[]; strength: Record<string, number>; ct_edge: number; kill_points_scale: number };
}

export const PARAMS: RatingParams = raw;

/** One table of HLTV's lookup: P(T wins) by state key, the columns joined with "|". */
export interface LookupTable { columns: string[]; states: Record<string, { p_t: number; n: number }> }

export type WinProbSource =
  | { kind: "hltv"; label: string; tables: LookupTable[] }
  | { kind: "cs2rb"; label: string };

export const CS2RB: WinProbSource = { kind: "cs2rb", label: "CS2RB round model (model/export)" };

/**
 * The win-probability source from the pack's parsed JSON, or CS2RB when the pack is not installed
 * (null). A pack that is present but not a lookup throws, naming the file.
 */
export function winProbSource(pack: unknown): WinProbSource {
  if (pack === null) return CS2RB;
  const p = pack as { tables?: unknown; source_maps?: unknown };
  const ok = Array.isArray(p.tables) && p.tables.length > 0
    && p.tables.every((t: { columns?: unknown; states?: unknown }) => Array.isArray(t.columns) && typeof t.states === "object" && t.states !== null);
  if (!ok) throw new Error("winprob-hltv.json: expected { tables: [{ columns, states }] }");
  return { kind: "hltv", label: `HLTV win-probability lookup (${String(p.source_maps)} maps)`, tables: p.tables as LookupTable[] };
}
