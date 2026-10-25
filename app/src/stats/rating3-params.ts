// The one place the engine reads model/rating3/params.json, the rating agent's parameter file
// (branch feat/rating3-fit): win-probability tables, swing rules, duel model and rating terms.
// rating3.ts, winprob.ts and swing.ts read it through these typed views; no constant is copied.
import raw from "../../../model/rating3/params.json";

export interface Rating3Params {
  winProbability: { tables: { columns: string[]; states: Record<string, { p_t: number; n: number }> }[] };
  rating: {
    /** which formula the terms belong to; rating3.ts implements only the bases it names */
    basis: string;
    fit_status?: string;
    standardisation: { means: Record<string, number>; sds: Record<string, number> };
    terms: Record<string, number>;
  };
  swing: {
    trade_window_seconds: number;
    round_end_remainder: { clutcher_weight: number; kill_swing_player_weight: number; defuser_weight: number; survivor_weight: number };
  };
  duel: { groups: string[]; strength: Record<string, number>; ct_edge: number; kill_points_scale: number };
}

export const PARAMS = raw as unknown as Rating3Params;
