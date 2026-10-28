// Rating 3.0's inputs and its coverage gate, on hand-built summaries and rounds.
import { expect, it } from "vitest";
import { compare, type Baselines } from "./compare";
import { METRIC, METRICS } from "./metrics";
import { FEATURES, rating3Of, roundRating3, sideRating3, type R3Inputs } from "./rating3";
import { rollup } from "./rollup";
import { derive } from "./derive";
import type { WinProbSource } from "./model-params";
import { at, combine } from "./testing/summary";
import { FREEZE_END, oneRound, oneRoundTables } from "./testing/match";

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

it("takes the total rating from the sides, weighted by their rated rounds", () => {
  // fails if the total and side ratings disagree: 100 CT rounds with 50 rated and 100 T rounds with 100
  // rated must total (50 x CT + 100 x T) / 150, as HLTV's map total is the sides' round-weighted mean
  const qCT = { kpr_eco: 0.5, adr_eco: 60, dpr_eco: 0.8, kast_eco: 60, mk: 10, swing: -3 };
  const qT = { kpr_eco: 1.1, adr_eco: 110, dpr_eco: 0.4, kast_eco: 85, mk: 30, swing: 6 };
  const side = (s: "CT" | "T", rounds: number, rated: number, q: typeof qCT) => at(q, rated, s, rounds);
  const CT = side("CT", 100, 50, qCT), T = side("T", 100, 100, qT);
  const [ct, t] = [rating3Of(CT).value!, rating3Of(T).value!];
  const both = rating3Of(combine(CT, T));
  expect(both.value).toBeCloseTo((50 * ct + 100 * t) / 150, 12);
  // a side with no rating (CT rated on 40 of 100 rounds) adds nothing: the total is T's alone
  const thin = side("CT", 100, 40, qCT);
  expect(rating3Of(thin).value).toBeNull();
  expect(rating3Of(combine(thin, T)).value).toBeCloseTo(t, 12);
  // one rated side covering under half of all rounds is no total
  const r = rating3Of(combine(thin, side("T", 300, 160, qT)));
  expect([r.value, r.reason]).toEqual([null, "the sides with half their own rounds rated cover 160 of 400 rounds; the rating needs half"]);
});

it("gives a breakdown whose base and terms add up to the rating", () => {
  // fails if the total's base or terms are not the sides' round-weighted ones, so a shown breakdown
  // would not sum to the shown rating
  const q = { kpr_eco: 0.7, adr_eco: 80, dpr_eco: 0.6, kast_eco: 72, mk: 18, swing: 1.5 };
  const r = rating3Of(combine(at(q, 40, "CT"), at({ ...q, swing: -2 }, 60, "T")));
  expect(FEATURES.reduce((a, f) => a + r.terms![f], r.base!)).toBeCloseTo(r.value!, 12);
});

it("rates a side as model/rating3/side_rating_fit.py does", () => {
  // fails if the curves, the CT offset or the 2K-5K weights are read differently from the Python fit
  // that produced params.json; the expected values are side_rating_fit.side_rating on the same inputs
  for (const [q, side, expected] of GOLDEN) expect(sideRating3(q, side).value).toBeCloseTo(expected, 12);
});

it("splits a side's rating over its rated rounds so the rounds average to it", () => {
  // fails if a round's share is its inputs put through the curves alone: the curves bend, so those
  // would not average to the side's rating
  const rounds: R3Inputs[] = [
    { kpr_eco: 2.1, adr_eco: 180, dpr_eco: 0, kast_eco: 100, mk: 100, swing: 22, k2: 100, k3: 0, k4: 0, k5: 0 },
    { kpr_eco: 0, adr_eco: 12, dpr_eco: 1, kast_eco: 0, mk: 0, swing: -14, k2: 0, k3: 0, k4: 0, k5: 0 },
    { kpr_eco: 1, adr_eco: 64, dpr_eco: 0.9, kast_eco: 100, mk: 0, swing: 3, k2: 0, k3: 0, k4: 0, k5: 0 },
  ];
  const keys = Object.keys(rounds[0]) as (keyof R3Inputs)[];
  const mean = Object.fromEntries(keys.map((k) => [k, rounds.reduce((a, r) => a + r[k], 0) / rounds.length])) as R3Inputs;
  const side = sideRating3(mean, "T").value;
  expect(rounds.reduce((a, r) => a + roundRating3(mean, "T", r).value, 0) / rounds.length).toBeCloseTo(side, 12);
});

/** Inputs, side and side_rating_fit.side_rating's value with the committed params.json. */
const GOLDEN: [R3Inputs, "CT" | "T", number][] = [
  [{kpr_eco: 0.25, adr_eco: 40, dpr_eco: 0.85, kast_eco: 50, swing: -8, k2: 4, k3: 0, k4: 0, k5: 0, mk: 4}, "CT", 0.33122479136268834],
  [{kpr_eco: 0.72, adr_eco: 76, dpr_eco: 0.62, kast_eco: 72, swing: 0.5, k2: 12, k3: 4, k4: 1, k5: 0, mk: 17}, "T", 1.1614074947872601],
  [{kpr_eco: 1.35, adr_eco: 130, dpr_eco: 0.35, kast_eco: 95, swing: 12, k2: 20, k3: 10, k4: 5, k5: 2, mk: 37}, "CT", 2.5286685691903834],
];
