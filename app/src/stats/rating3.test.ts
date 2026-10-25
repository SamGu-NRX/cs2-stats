// Rating 3.0's inputs and its coverage gate, on hand-built summaries and rounds.
import { expect, it } from "vitest";
import { compare, type Baselines } from "./compare";
import { METRIC, METRICS } from "./metrics";
import { rating3Of, type R3Inputs } from "./rating3";
import { emptySummary, rollup } from "./rollup";
import { FREEZE_END, oneRound } from "./testing/match";

/** A summary of `rounds` rounds whose six inputs (over valued rounds) are `q`. */
function at(q: R3Inputs, rounds = 100) {
  const s = emptySummary();
  Object.assign(s.m, {
    rounds, swingRounds: rounds, vEcoKills: q.kpr_eco * rounds, vEcoDmg: q.adr_eco * rounds, vEcoDeaths: q.dpr_eco * rounds,
    vEcoKast: (q.kast_eco * rounds) / 100, vMultiKillRounds: (q.mk * rounds) / 100, swing: (q.swing * rounds) / 100,
  });
  s.matches = 1;
  s.covered = { nRounds: rounds, roundsPlayed: rounds };
  return s;
}
const MEAN = { kpr_eco: 0.66, adr_eco: 72, dpr_eco: 0.66, kast_eco: 69, mk: 16, swing: -0.02 };

it("rates only over the rounds swing valued, and not at all when under half are", () => {
  // fails if the six inputs average over different rounds (swing over valued rounds, the rest over all),
  // or a summary with swing on few rounds gets a rating with swing counted as 0
  const players = { a: "CT", b: "T" } as const;
  const v = oneRound({ players, kills: [{ tick: FREEZE_END + 300, killer: "a", victim: "b" }], player_rounds: { a: { equip_value_game: 4000 }, b: { equip_value_game: 4000 } } });
  const u = oneRound({ players, kills: [{ tick: FREEZE_END + 300, killer: "b", victim: "a" }] });
  expect(rollup([u], { player: "a" }).m.swingRounds ?? 0).toBe(0);
  const one = rating3Of(rollup([v], { player: "a" })).value;
  expect(one).not.toBeNull();
  expect(rating3Of(rollup([v, u], { player: "a" })).value).toBeCloseTo(one!, 9);
  expect(rating3Of(rollup([v, u, u], { player: "a" })).value).toBeNull();
});

it("gates the rating, its percentile and so Work on through one coverage rule", () => {
  // fails if a summary covering under half its matches' rounds gets a rating or a rating percentile
  const s = at(MEAN);
  s.covered = { nRounds: 10, roundsPlayed: 24 };
  const flat: Baselines = { version: 1, built: "x", source: "test", model: undefined, n: {}, pools: { rifler: { both: Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(0)])) } } };
  expect(rating3Of(s).value).toBeNull();
  expect(METRIC.rating3.value(s)).toBeNull();
  expect(compare(s, flat).rating3.pct).toBeNull();
});
