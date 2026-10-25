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
import { winCorrelationOf } from "../stats/trends";
import { entryOf } from "./views";

it("ranks the player among the opponents with lower-is-better metrics turned around", () => {
  // fails if fewer deaths ranks worse, or an identity metric gets a rank
  const s = (rounds: number, deaths: number) => { const x = emptySummary(); x.m.rounds = rounds; x.m.deaths = deaths; return x; };
  const r = Object.fromEntries(vsOpponentsOf(s(10, 4), [s(10, 6), s(10, 8)]).map((x) => [x.id, x]));
  expect(r.dpr).toMatchObject({ rank: 1, of: 3, opponents: 0.7 });
  expect(r.openingAttempts.rank).toBeNull();
});

it("correlates a metric with winning over decided matches only, and needs three", () => {
  // fails if undecided matches count or two points give an r
  expect(winCorrelationOf([{ value: 1, won: true }, { value: 0, won: false }, { value: 5, won: null }])).toBeNull();
  expect(winCorrelationOf([{ value: 2, won: true }, { value: 1, won: false }, { value: 3, won: true }])!.r).toBeGreaterThan(0.8);
});

it("gives each scoreboard line its eco-adjusted values from the rating's own inputs", async () => {
  // fails if eK-eD, eADR or eKAST on the scoreboard disagree with the inputs Rating 3.0 used
  const file = "20261024T223834Z_de_dust2_abe5d91c.json.gz";
  const m = await decodeMatch(readFileSync(path.resolve(import.meta.dirname, "../../public/samples", file)), file);
  const e = entryOf(file, "", derive(pluginToTables(m), CS2RB));
  const l = e.line;
  expect(l.eco).not.toBeNull();
  expect(l.eco!.ek).toBe(l.m.vEcoKills);
  expect(l.eco!.eadr).toBeCloseTo(l.m.vEcoDmg / l.m.swingRounds, 9);
});
