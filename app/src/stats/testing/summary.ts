// Hand-built summaries for the rating and ranking tests: measures set directly, not rolled up from facts.
import type { Measures } from "../facts";
import type { R3Inputs } from "../rating3";
import { emptySummary, type Summary } from "../rollup";
import type { Side } from "../tables";

/**
 * A summary of one side's `rounds` rounds, `rated` of them rated, whose six inputs over the rated
 * rounds are `q`; its coverage gate passes.
 */
export function at(q: R3Inputs, rated = 100, side: Side = "CT", rounds = rated): Summary {
  const s = emptySummary();
  const m: Partial<Measures> = {
    rounds, swingRounds: rated, ecoRounds: rated, ratedRounds: rated, vEcoKills: q.kpr_eco * rated, vEcoDmg: q.adr_eco * rated, vEcoDeaths: q.dpr_eco * rated,
    vEcoKast: (q.kast_eco * rated) / 100, vMultiKillRounds: (q.mk * rated) / 100, swing: (q.swing * rated) / 100, vSwing: (q.swing * rated) / 100,
  };
  Object.assign(s.m, m);
  Object.assign(s.sides[side], m);
  s.matches = 1;
  s.covered = { nRounds: rounds, roundsPlayed: rounds };
  return s;
}

/** Two summaries as one: measures, side measures and coverage added. */
export function combine(a: Summary, b: Summary): Summary {
  const s = emptySummary();
  const add = (into: Measures, x: Measures, y: Measures) => { for (const k of Object.keys(into) as (keyof Measures)[]) into[k] = x[k] + y[k]; };
  add(s.m, a.m, b.m);
  add(s.sides.CT, a.sides.CT, b.sides.CT);
  add(s.sides.T, a.sides.T, b.sides.T);
  s.matches = a.matches + b.matches;
  s.covered = { nRounds: a.covered.nRounds + b.covered.nRounds, roundsPlayed: a.covered.roundsPlayed + b.covered.roundsPlayed };
  return s;
}
