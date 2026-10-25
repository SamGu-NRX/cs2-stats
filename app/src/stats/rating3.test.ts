// Rating 3.0's inputs and its coverage gate, on hand-built summaries and rounds.
import { expect, it } from "vitest";
import { compare, type Baselines } from "./compare";
import { METRIC, METRICS } from "./metrics";
import { PARAMS } from "./model-params";
import { rating3Of, ratingFromSides, type R3Inputs } from "./rating3";
import { emptySummary, rollup } from "./rollup";
import { derive } from "./derive";
import type { WinProbSource } from "./model-params";
import { FREEZE_END, oneRound, oneRoundTables } from "./testing/match";

/** A summary of `rounds` rounds whose six inputs (over valued rounds) are `q`. */
function at(q: R3Inputs, rounds = 100) {
  const s = emptySummary();
  Object.assign(s.m, {
    rounds, swingRounds: rounds, ecoRounds: rounds, ratedRounds: rounds, vEcoKills: q.kpr_eco * rounds, vEcoDmg: q.adr_eco * rounds, vEcoDeaths: q.dpr_eco * rounds,
    vEcoKast: (q.kast_eco * rounds) / 100, vMultiKillRounds: (q.mk * rounds) / 100, swing: (q.swing * rounds) / 100, vSwing: (q.swing * rounds) / 100,
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

it("rates only over rounds whose eco values are known, and gives a reason when too few are", () => {
  // fails if a kill whose economy groups are unknown counts at its raw value (the old ?? 1), so a
  // rating is built from unadjusted rounds: the lookup values a round without equipment, the eco
  // adjustment cannot
  const byAlive: WinProbSource = {
    kind: "hltv", label: "test lookup", hash: "t",
    tables: [{ columns: ["alive_t", "alive_ct"], states: { "1|1": { p_t: 0.5, n: 1 }, "0|1": { p_t: 0, n: 1 } } }],
  };
  const players = { a: "CT", b: "T" } as const;
  const kill = [{ tick: FREEZE_END + 300, killer: "a", victim: "b" }];
  const known = derive(oneRoundTables({ players, kills: kill, player_rounds: { a: { equip_value_game: 4000 }, b: { equip_value_game: 1000 } } }), byAlive);
  const unknown = derive(oneRoundTables({ players, kills: kill }), byAlive);
  expect(rollup([unknown], { player: "a" }).m.swingRounds).toBe(1);
  const one = rating3Of(rollup([known], { player: "a" })).value;
  expect(one).not.toBeNull();
  // half the rounds rated: the rating is the known round's, not a mix with the raw one
  expect(rating3Of(rollup([known, unknown], { player: "a" })).value).toBeCloseTo(one!, 9);
  const thin = rating3Of(rollup([known, unknown, unknown], { player: "a" }));
  const why = "both the round's win probability and every eco value known for 1 of 3 rounds; the rating needs half";
  expect([thin.value, thin.reason]).toEqual([null, why]);
  const s = rollup([known, unknown, unknown], { player: "a" });
  const pool: Baselines = { version: 1, built: "x", source: "test", model: s.models[0], n: {}, pools: {} };
  expect(compare(s, pool, { pool: "all" }).rating3.reason).toBe(`No value: ${why}`);
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

it("takes the total rating from the sides, weighted by their valued rounds", () => {
  // fails if the total and side ratings disagree: Astra's case, 100 CT rounds with 50 valued at 1.00
  // and 100 T rounds with 100 valued at 3.00, must total (50 x 1 + 100 x 3) / 150
  const k = PARAMS.rating.coefficients.eKPR, b = PARAMS.rating.intercept;
  const side = (rounds: number, valued: number, rating: number) => {
    const s = at({ kpr_eco: (rating - b) / k, adr_eco: 0, dpr_eco: 0, kast_eco: 0, mk: 0, swing: 0 }, valued);
    s.m.rounds = rounds;
    s.covered = { nRounds: rounds, roundsPlayed: rounds };
    return s;
  };
  const CT = side(100, 50, 1), T = side(100, 100, 3);
  expect([rating3Of(CT).value, rating3Of(T).value]).toEqual([expect.closeTo(1, 9), expect.closeTo(3, 9)]);
  const both = emptySummary();
  for (const [key, v] of Object.entries(CT.m)) both.m[key as keyof typeof both.m] = v + T.m[key as keyof typeof T.m];
  both.matches = 1;
  both.covered = { nRounds: 200, roundsPlayed: 200 };
  expect(ratingFromSides(both, { CT, T }).value).toBeCloseTo(350 / 150, 9);
  // a side with no rating (CT valued on 40 of 100 rounds) adds nothing: the total is T's 3.00, not a
  // pooled mix with rounds the CT rating rejected
  const thin = side(100, 40, 1);
  const both2 = emptySummary();
  for (const [key, v] of Object.entries(thin.m)) both2.m[key as keyof typeof both2.m] = v + T.m[key as keyof typeof T.m];
  both2.matches = 1;
  both2.covered = { nRounds: 200, roundsPlayed: 200 };
  expect(rating3Of(thin).value).toBeNull();
  expect(ratingFromSides(both2, { CT: thin, T }).value).toBeCloseTo(3, 9);
});
