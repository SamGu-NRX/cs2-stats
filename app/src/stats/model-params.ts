// The one loader for the rating model and the round win-probability source. The rating model is
// model/rating3/params.json (the rating, swing and duel blocks); the win-probability source is HLTV's
// lookup when the private pack %APPDATA%\BotMatchStats\packs\winprob-hltv.json is supplied, else the
// CS2RB round model in model/export. rating3.ts, swing.ts and winprob.ts read through this file; no
// constant is copied into TypeScript.
import cs2rbModel from "../../../model/export/model.json";
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
    /** what the coefficients were fitted on */
    dataset: { maps: number; player_maps: number; date: string };
    fit: { method: string; held_out_mae: number };
  };
  swing: {
    trade_window_seconds: number;
    /** the weights a kill's credit and charge are shared by (SPEC.md "Swing credits") */
    event_credit: { kill_weight: number; flash_weight: number; trade_weight: number; victim_weight: number; failed_trade_weight: number; trade_window_seconds: number };
  };
  duel: { groups: string[]; strength: Record<string, number>; ct_edge: number; kill_points_scale: number };
}

export const PARAMS: RatingParams = raw;

/** One table of HLTV's lookup: P(T wins) by state key, the columns joined with "|". */
export interface LookupTable { columns: string[]; states: Record<string, { p_t: number; n: number }> }

/** `hash` is a content hash of the source's parameters, so a refitted pack or model is a different source. */
export type WinProbSource =
  | { kind: "hltv"; label: string; hash: string; tables: LookupTable[] }
  | { kind: "cs2rb"; label: string; hash: string };

/** FNV-1a over a string, hex: a content fingerprint, not a security hash. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export const CS2RB: WinProbSource = { kind: "cs2rb", label: "CS2RB round model (model/export)", hash: contentHash(JSON.stringify(cs2rbModel)) };

const PARAMS_HASH = contentHash(JSON.stringify(raw));

/**
 * Everything derived facts depend on beyond the tables and DERIVE_VERSION: the rating parameters and
 * the win-probability source, by content. Facts and baselines record it; a percentile of a
 * model-dependent metric needs the two to match, and caches are keyed by it.
 */
export const modelFingerprint = (wp: WinProbSource) => `${wp.kind}-${wp.hash}-p${PARAMS_HASH}`;

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
  return { kind: "hltv", label: `HLTV win-probability lookup (${String(p.source_maps)} maps)`, hash: contentHash(JSON.stringify(p.tables)), tables: p.tables as LookupTable[] };
}
