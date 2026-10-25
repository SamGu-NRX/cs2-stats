// One aggressive-to-passive score from the four contact measures that describe how a player takes a
// fight (aim.ts CONTACT_METRICS). Each part becomes a z-score against the pro players' spread
// (`pnpm metric-evidence --fit` writes the means and standard deviations), signed so that higher is
// more aggressive, and the score is their mean. The signs are ours, not fitted: travelling further in a
// peek and firing first read as aggressive; a longer wait before the duel settles and a longer
// engagement distance read as passive. METRICS.md lists the parts' correlations with entry attempts.
import { CONTACT_METRICS } from "./aim";
import type { Summary } from "./rollup";

export const AGGRO_PARTS = ["peekTravel", "firedFirst", "duelExposure", "engageDistance"] as const;
/** +1: more of the part is more aggressive; -1: less of it is. Same order as AGGRO_PARTS. */
export const AGGRO_SIGNS = [1, 1, -1, -1] as const;

export interface AggroScale {
  parts: string[];
  /** per part, over pro players: the mean and standard deviation of the part's value */
  mean: number[];
  sd: number[];
  players: number;
  source: string;
}

/** The parts' values for a summary, AGGRO_PARTS order. */
export const aggroParts = (s: Summary): (number | null)[] =>
  AGGRO_PARTS.map((id) => CONTACT_METRICS.find((m) => m.id === id)!.value(s));

/** The mean of the four signed z-scores of part values (AGGRO_PARTS order); null unless every part has a value. */
export function scoreOf(v: (number | null)[], scale: AggroScale): number | null {
  if (scale.parts.join() !== AGGRO_PARTS.join()) throw new Error(`aggression scale is for [${scale.parts}], the engine combines [${AGGRO_PARTS}]`);
  if (v.some((x) => x === null)) return null;
  return v.reduce<number>((a, x, j) => a + (AGGRO_SIGNS[j] * (x! - scale.mean[j])) / scale.sd[j], 0) / v.length;
}

export const aggressionScore = (s: Summary, scale: AggroScale) => scoreOf(aggroParts(s), scale);
