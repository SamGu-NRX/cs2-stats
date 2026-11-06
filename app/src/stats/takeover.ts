// Takeover credit on measures: what the views' "You" credit (ui/data/credit.ts) moves. A human's
// kills, headshot kills, deaths and enemy damage in a bot's body count for the bot as derived, and
// derive counts them once more on both players (facts.ts takeover* on the driver, driven* on the
// body). Under "You" they leave the body's measures and join the driver's. Every other measure is
// the game's: the per-round model (Rating 3.0, KAST, openings, trades, clutches, multi-kills) assumes
// one life per round, and "You" can give a player two deaths in one.
import type { Measures } from "./facts";
import type { Summary } from "./rollup";

/** What "You" adds to one player's measures: their play in bots' bodies, less a human's play in theirs. */
export interface Shift { kills: number; hsKills: number; deaths: number; dmg: number }

const at = (m: Partial<Measures>, k: keyof Measures) => m[k] ?? 0;

export function shiftOf(m: Partial<Measures>): Shift {
  return {
    kills: at(m, "takeoverKills") - at(m, "drivenKills"),
    hsKills: at(m, "takeoverHsKills") - at(m, "drivenHsKills"),
    deaths: at(m, "takeoverDeaths") - at(m, "drivenDeaths"),
    dmg: at(m, "takeoverDmg") - at(m, "drivenDmg"),
  };
}

/** Whether "You" changes any of these measures. */
export function moved(m: Partial<Measures>): boolean {
  const s = shiftOf(m);
  return s.kills !== 0 || s.hsKills !== 0 || s.deaths !== 0 || s.dmg !== 0;
}

/** The measures under "You": the moved counts applied, every other measure as it was. */
export function youMeasures(m: Measures): Measures {
  const s = shiftOf(m);
  return { ...m, kills: m.kills + s.kills, hsKills: m.hsKills + s.hsKills, deaths: m.deaths + s.deaths, dmg: m.dmg + s.dmg };
}

/** A summary under "You": its measures, and each side's, with the moved counts applied. */
export const youSummary = (s: Summary): Summary => ({ ...s, m: youMeasures(s.m), sides: { CT: youMeasures(s.sides.CT), T: youMeasures(s.sides.T) } });

/**
 * The figures "You" moves, by id: the counts it moves (career-lists.ts BEST_COUNTS kills, hsKills, dmg)
 * and the metrics that are ratios of moved counts to rounds or to each other (metrics.ts kpr, dpr, adr,
 * hs, netKills24). Personal bests (career.ts addBests) and a player's own comparisons (career.ts
 * metricDeltas: this match against recent ones, a period against the one before) read them under both
 * credits. A metric that mixes a moved count with one that stays (net damage takes damage taken, which
 * stays with the body; the trade and opening shares divide unmoved counts by kills or deaths) keeps the
 * game's credit, because under "You" it would divide one credit by the other.
 */
export const YOU_MOVES: ReadonlySet<string> = new Set(["kills", "hsKills", "dmg", "kpr", "dpr", "adr", "hs", "netKills24"]);
