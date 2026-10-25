// The metrics, measure and identity helpers added to bring back main's Profile, Playstyle and Home
// elements (REMOVALS.md, E20): each against a hand-computed answer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { botPopulation, compassOf } from "../worker/ranking";
import { CAREER_MIN_ROUNDS } from "./compare";
import { derive } from "./derive";
import type { Measures } from "./facts";
import { styleLabel, styleZone, stylePoint } from "./identity";
import { METRIC, METRICS } from "./metrics";
import { CS2RB } from "./model-params";
import { pluginToTables } from "./plugin/adapter";
import { decodeMatch } from "./plugin/decode";
import { rating3Of } from "./rating3";
import { emptySummary, rollup, type Summary } from "./rollup";
import { oneRound } from "./testing/match";
import { at } from "./testing/summary";

const SAMPLE = path.resolve(import.meta.dirname, "../../public/samples/synthetic-demo.json.gz");

const withMeasures = (m: Partial<Measures>): Summary => {
  const s = emptySummary();
  Object.assign(s.m, m);
  return s;
};

it("defines the restored metrics over their measures", () => {
  // fails if a restored row divides by the wrong count or weights clutches wrongly
  const s = withMeasures({
    rounds: 40, kills: 20, assists: 10, tradeKills: 5, openingKills: 8, openingWins: 6, perfectKills: 15, failedTrades: 4, baitKills: 6,
    flashAssists: 3, clutchWon1: 2, clutchWon2: 1, clutchWon3: 1, spacingSamples: 4, nearestDistSum: 2000,
  });
  const v = (id: string) => METRIC[id].value(s);
  expect(v("openingWinPct")).toBe(75);
  expect(v("perfectKillsPct")).toBe(75);
  expect(v("failedTradesPR")).toBe(0.1);
  expect(v("baitKillsPR")).toBe(0.15);
  expect(v("flashAssistsPR")).toBe(0.075);
  // 2×1 + 1×2 + 1×3 = 7 clutch points over 40 rounds
  expect(v("clutchPointsPR")).toBe(7 / 40);
  // (5 trade kills + 10 assists) / (20 kills + 10 assists)
  expect(v("tradeAssistShare")).toBe(50);
  expect(v("teamDistance")).toBe(500);
  expect(METRIC.teamDistance.value(withMeasures({ rounds: 10 }))).toBeNull();
});

it("gives eco-adjusted KPR as Rating 3.0's own input", () => {
  // fails if the Firepower row computes eco-adjusted kills a second way that can disagree with the rating's breakdown
  const s = at({ kpr_eco: 0.81, adr_eco: 80, dpr_eco: 0.6, kast_eco: 72, mk: 15, swing: 1.5 }, 100);
  expect(METRIC.ecoKpr.value(s)).toBeCloseTo(0.81, 12);
  expect(METRIC.ecoKpr.value(s)).toBe(rating3Of(s).inputs!.kpr_eco);
  expect(METRIC.ecoKpr.value(emptySummary())).toBeNull();
  expect(METRIC.ecoKpr.why!(emptySummary())).toBe(rating3Of(emptySummary()).reason);
});

it("pairs each share metric with the measures its value divides", async () => {
  // fails if How good's "x of y" counts name measures other than the ones the rate is computed from
  const m = await decodeMatch(readFileSync(SAMPLE), "synthetic-demo.json.gz");
  const facts = derive(pluginToTables(m), CS2RB);
  const withOf = METRICS.filter((x) => x.of);
  let checked = 0;
  for (const p of facts.players) {
    const s = rollup([facts], { player: p.id });
    for (const x of withOf) {
      const [a, b] = x.of!;
      const v = x.value(s);
      expect(v, `${x.id} ${p.id}`).toBe(s.m[b] > 0 ? (100 * s.m[a]) / s.m[b] : null);
      if (v !== null) checked++;
    }
  }
  expect(checked).toBeGreaterThan(10);
});

it("sums the distance to the nearest teammate over the spacing samples", () => {
  // fails if nearestDistSum counts another distance than the one ADNT ranks, or counts a sample twice
  // five T players on a line at x = 0, 100, 300, 600, 1000, seen only at the first spacing sample (10 s after freeze end)
  const xs = [0, 100, 300, 600, 1000];
  const players: Record<string, "CT" | "T"> = { c1: "CT", t0: "T", t1: "T", t2: "T", t3: "T", t4: "T" };
  const f = oneRound({ players, positions: xs.map((x, i) => ({ tick: 640 + 10 * 64, steamid: `t${i}`, x, y: 0 })) });
  const dist = (id: string) => METRIC.teamDistance.value(rollup([f], { player: id }));
  expect(["t0", "t1", "t2", "t3", "t4"].map(dist)).toEqual([100, 100, 200, 300, 400]);
});

it("places a compass point in its zone at the thresholds, inclusive", () => {
  // fails if a player exactly on the 25% or 45% line falls in the wrong zone, or an AWPer is labelled as a rifler flavour
  expect(styleZone(25, 45)).toBe("Entry and support");
  expect(styleZone(24.9, 45)).toBe("Support");
  expect(styleZone(25, 44.9)).toBe("Entry");
  expect(styleZone(24.9, 44.9)).toBe("Rifler");
  expect(styleLabel("rifler", "Entry")).toBe("Rifler (Entry)");
  expect(styleLabel("rifler", "Rifler")).toBe("Rifler");
  expect(styleLabel("awper", "Entry and support")).toBe("AWPer");
});

it("puts you and the bots the style ranks against on the compass: careers once 8 qualify, else single matches", () => {
  // fails if the compass plots another population than the style scores rank against, a career under
  // the round minimum is plotted, or the axes swap
  const s = (rounds: number, openings: number, tradeKills: number, assists: number, kills: number) => withMeasures({ rounds, openingKills: openings, kills, tradeKills, assists });
  const sided = (x: Summary) => ({ both: x, CT: x, T: x });
  const big = s(CAREER_MIN_ROUNDS, 45, 30, 20, 80);
  const small = s(CAREER_MIN_ROUNDS - 1, 10, 10, 10, 40);
  const one = s(16, 2, 1, 1, 9);
  const matches = Array.from({ length: 8 }, () => ({ name: "Match", s: one }));
  const you = withMeasures({ rounds: 200, openingKills: 30, openingDeaths: 20, kills: 100, tradeKills: 10, assists: 20 });
  const careers = [...Array.from({ length: 8 }, (_, i) => ({ name: `Big${i}`, s: big })), { name: "Small", s: small }];
  const r = compassOf(you, careers, matches, botPopulation(careers.map((c) => sided(c.s)), matches.map((m) => sided(m.s)), "x"));
  expect(r.careers.unit).toBe("careers");
  expect(r.bots.length).toBe(8);
  expect(r.bots[0]).toEqual({ name: "Big0", rounds: CAREER_MIN_ROUNDS, x: 30, y: 50, label: "Rifler (Entry and support)" });
  expect(r.you).toEqual({ name: "You", rounds: 200, x: 25, y: 25, label: "Rifler (Entry)" });

  // one career qualifies: the style ranks against single bot matches, and so does the compass
  const few = compassOf(you, careers.slice(7), matches, botPopulation(careers.slice(7).map((c) => sided(c.s)), matches.map((m) => sided(m.s)), "x"));
  expect(few.careers.unit).toBe("matches");
  expect(few.bots.map((b) => [b.name, b.rounds, b.x, b.y])).toEqual(matches.map(() => ["Match", 16, 12.5, 20]));
  expect(stylePoint("none", emptySummary())).toBeNull();
});
