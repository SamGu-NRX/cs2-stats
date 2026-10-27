// The pure parts of the worker's breakdown calls, on hand-built summaries and a bundled log.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { derive } from "../stats/derive";
import { CS2RB } from "../stats/model-params";
import { vsOpponentsOf } from "../stats/opponents";
import { pluginToTables } from "../stats/plugin/adapter";
import { decodeMatch } from "../stats/plugin/decode";
import { emptySummary } from "../stats/rollup";
import { matchWon, winCorrelationOf } from "../stats/trends";
import { oneRound } from "../stats/testing/match";
import { compare, percentileOf, type Baselines } from "../stats/compare";
import { METRICS } from "../stats/metrics";
import { FEATURES } from "../stats/rating3";
import { at, combine } from "../stats/testing/summary";
import { entryOf, ratingsOf, valuesOf } from "./views";

it("ranks the player among the opponents with lower-is-better metrics turned around", () => {
  // fails if fewer deaths ranks worse, or an identity metric gets a rank
  const s = (rounds: number, deaths: number) => { const x = emptySummary(); x.m.rounds = rounds; x.m.deaths = deaths; return x; };
  const r = Object.fromEntries(vsOpponentsOf(s(10, 4), [s(10, 6), s(10, 8)]).map((x) => [x.id, x]));
  expect(r.dpr).toMatchObject({ rank: 1, of: 3, opponents: 0.7 });
  expect(r.openingAttempts.rank).toBeNull();
});

it("correlates a metric with winning over decided matches only, and needs three", () => {
  // fails if undecided matches count or two points give an r
  expect(winCorrelationOf([{ value: 1, won: true }, { value: 0, won: false }, { value: 5, won: null }])).toEqual({ r: null, n: 2, reason: "few" });
  expect(winCorrelationOf([{ value: 2, won: true }, { value: 1, won: false }, { value: 3, won: true }])!.r).toBeGreaterThan(0.8);
});

it("gives each scoreboard line its eco-adjusted values from the rating's own inputs", async () => {
  // fails if eK-eD, eADR or eKAST on the scoreboard disagree with the inputs Rating 3.0 used
  const file = "20261024T223834Z_de_dust2_abe5d91c.json.gz";
  const m = await decodeMatch(readFileSync(path.resolve(import.meta.dirname, "../../public/samples", file)), file);
  const e = entryOf(file, "", derive(pluginToTables(m), CS2RB));
  const l = e.line;
  if (!l) throw new Error("a recording has the recording player's line");
  expect(l.eco).not.toBeNull();
  expect(l.eco!.ek).toBeCloseTo(l.m.vEcoKills, 9);
  expect(l.eco!.eadr).toBeCloseTo(l.m.vEcoDmg / l.m.ratedRounds, 9);
});

it("counts only finished, decided matches as wins or losses for the win correlation", () => {
  // fails if a tie counts as a loss or an unfinished match counts at all
  const base = oneRound({ players: { a: "CT", b: "T" } });
  const as = (score: [number, number], complete: boolean) => ({ ...base, match: { ...base.match, score, complete } });
  const me = new Set(["a"]);
  expect([matchWon(as([13, 9], true), me), matchWon(as([9, 13], true), me), matchWon(as([12, 12], true), me), matchWon(as([5, 2], false), me)]).toEqual([true, false, null, null]);
});

it("shows the rating it ranks when one side is too thin to rate", () => {
  // fails if the rating3 metric, and so its percentile, pools both sides' rounds while the views weight
  // the rated sides: CT is rated on 40 of 100 rounds (no CT rating), T on all 100 at a higher level
  const q = { kpr_eco: 0.5, adr_eco: 60, dpr_eco: 0.7, kast_eco: 65, mk: 10, swing: -1 };
  const CT = at(q, 40, "CT", 100), T = at({ ...q, kpr_eco: 1.1, adr_eco: 95, swing: 3 }, 100, "T");
  const both = combine(CT, T);
  const shown = ratingsOf({ both, CT, T }).both;
  expect(shown.value).not.toBeNull();
  expect(shown.value).toBeCloseTo(ratingsOf({ both: T, CT, T }).T.value!, 9);
  const quantiles = Array.from({ length: 21 }, (_, i) => i / 5);
  const pool: Baselines = { version: 1, built: "x", source: "test", model: "m", n: {}, pools: { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, quantiles])) } } };
  const ranked = compare(both, pool, { pool: "all" }).rating3;
  expect([valuesOf(both).rating3, ranked.value, ranked.pct]).toEqual([shown.value, shown.value, percentileOf(quantiles, shown.value!)]);
  expect(FEATURES.reduce((a, f) => a + shown.terms![f], shown.base!)).toBeCloseTo(shown.value!, 9);
});
