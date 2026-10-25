// design/identity.md: the user's style is ranked against the bot careers in their matches, never
// against pros; performance is ranked against pros.
import { readFileSync } from "node:fs";
import path from "node:path";
import { CS2RB } from "../stats/model-params";
import { expect, it } from "vitest";
import type { Baselines } from "../stats/compare";
import { derive } from "../stats/derive";
import { METRIC, METRICS } from "../stats/metrics";
import { pluginToTables } from "../stats/plugin/adapter";
import { decodeMatch } from "../stats/plugin/decode";
import { emptySummary, rollup } from "../stats/rollup";
import { ATTRIBUTE_ORDER } from "../ui/data/proPack";
import { botPopulation, careersFor, rankingCalls } from "./ranking";

const SAMPLE = path.resolve(import.meta.dirname, "../../public/samples/synthetic-demo.json.gz");

/** Baselines whose every quantile is `q`: a real value sits at 0 against a huge q and at 100 against a tiny one. */
const flat = (q: number): Baselines => {
  const side = Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(q)]));
  const pool = { both: side, CT: side, T: side };
  return { version: 1, built: "x", source: "test", n: { all: { both: 20 }, rifler: { both: 20 }, awper: { both: 20 } }, pools: { all: pool, rifler: pool, awper: pool } };
};

it("ranks the user's style against the bot careers and performance against the pros", async () => {
  // fails if the user's style scores, identity rows or "plays like" read the pro baselines, or a
  // pro percentile is offered for an identity metric
  const m = await decodeMatch(readFileSync(SAMPLE), "synthetic-demo.json.gz");
  const facts = derive(pluginToTables(m), CS2RB);
  const calls = rankingCalls({
    summary: async (q) => rollup([facts], q.filter),
    pros: async () => flat(1e9),
    careers: async () => ({
      baselines: flat(-1e9), unit: { all: { both: "careers", T: "careers", CT: "careers" }, rifler: { both: "careers", T: "careers", CT: "careers" }, awper: { both: "careers", T: "careers", CT: "careers" } },
      counts: { botMatches: 40, qualified: 6, needed: 15, minRounds: 150, minPool: 8 },
    }),
    mapRounds: async () => ({}),
  });
  const q = { files: ["synthetic-demo.json.gz"], filter: { player: facts.match.pov! } };

  const style = await calls.style(q, {});
  const scored = style.scores.filter((a) => a.score !== null);
  expect(scored.length).toBeGreaterThanOrEqual(4);
  for (const a of scored) expect(a.score, a.id).toBe(100);
  const rows = Object.values(style.p).filter((x) => x.pct !== null);
  expect(rows.length).toBeGreaterThan(0);
  for (const x of rows) expect(x.pct, x.id).toBe(100);
  expect(style.careers).toMatchObject({ provisional: true, qualified: 6 });

  // your scores all sit at 100 against the bots: a pro high on every attribute has the same shape
  const pro = (slug: string, v: number) => ({ slug, both: ATTRIBUTE_ORDER.map(() => v), ct: ATTRIBUTE_ORDER.map(() => v), t: ATTRIBUTE_ORDER.map(() => v) });
  const like = await calls.playsLike(q, [pro("low", 10), pro("high", 90)]);
  expect(like.ranked.map((x) => x.slug)).toEqual(["high", "low"]);

  const perf = await calls.compare(q, {});
  expect(Object.keys(perf.p).length).toBeGreaterThan(0);
  expect(Object.keys(perf.p).filter((id) => METRIC[id].kind === "identity")).toEqual([]);
});

it("ranks each role's style against bot careers where 8 qualify in that role, else against single bot matches", () => {
  // fails if the choice is made once for every pool (riflers with 8 careers fall back with the AWPers),
  // or a pool with under 8 bot matches shows scores
  const bot = (rounds: number, kills: number, awpKills = 0) => {
    const s = emptySummary();
    s.m.rounds = rounds; s.m.kills = kills; s.m.awpKills = awpKills;
    return { both: s, CT: s, T: s };
  };
  const riflerCareers = Array.from({ length: 8 }, (_, i) => bot(150, 100 + i));
  const awperCareer = bot(150, 100, 60);
  const matches = [...Array.from({ length: 9 }, (_, i) => bot(24, 10 + i)), ...Array.from({ length: 9 }, (_, i) => bot(24, 12 + i, 8))];
  const p = botPopulation([...riflerCareers, awperCareer], matches, "x");
  expect(careersFor(p, "rifler", "both")).toMatchObject({ unit: "careers", qualified: 9 });
  expect(careersFor(p, "awper", "both")).toMatchObject({ unit: "matches", provisional: true });
  expect(p.baselines.pools.rifler.both!.kpr![0]).toBeCloseTo(100 / 150);
  expect(p.baselines.pools.awper.both!.kpr![0]).toBeCloseTo(12 / 24);
  expect(botPopulation([], matches.slice(0, 7), "x").baselines.pools.all.both!.kpr).toBeNull();
});

it("returns Firepower against the pros and the six style attributes against the bots in one call", async () => {
  // fails if the attribute block mixes populations or drops an attribute's metrics
  const m = await decodeMatch(readFileSync(SAMPLE), "synthetic-demo.json.gz");
  const facts = derive(pluginToTables(m), CS2RB);
  const all = { all: { both: "careers", T: "careers", CT: "careers" }, rifler: { both: "careers", T: "careers", CT: "careers" }, awper: { both: "careers", T: "careers", CT: "careers" } } as const;
  const { attributeBlock } = rankingCalls({
    summary: async (q) => rollup([facts], q.filter),
    pros: async () => flat(1e9),
    careers: async () => ({ baselines: flat(-1e9), unit: all, counts: { botMatches: 40, qualified: 9, needed: 15, minRounds: 150, minPool: 8 } }),
    mapRounds: async () => ({}),
  });
  const b = await attributeBlock({ files: ["x"], filter: { player: facts.match.pov! } }, { side: "T" });
  expect(b.firepower?.metrics.length).toBe(8);
  expect(b.firepower?.metrics.every((x) => x.pct === null || x.pct === 0)).toBe(true);
  expect(b.style.scores.map((a) => a.id)).toEqual(["entrying", "trading", "opening", "closing", "sniping", "utility"]);
  expect(b.style.scores.every((a) => a.metrics.length === 4 && a.metrics.every((x) => x.pct === null || x.pct === 100))).toBe(true);
});

it("gives the role over all rounds and per map, maps with the most rounds first", async () => {
  // fails if the overall role is not the rounds-weighted mix of the sides, or a map's role reads
  // another map's rounds. The second map is the same match under another name, played twice
  const m = await decodeMatch(readFileSync(SAMPLE), "synthetic-demo.json.gz");
  const facts = derive(pluginToTables(m), CS2RB);
  const other = { ...facts, match: { ...facts.match, map: "de_other" } };
  const all = [facts, other, other];
  const calls = rankingCalls({
    summary: async (q) => rollup(all, q.filter), pros: async () => flat(0), careers: async () => { throw new Error("not used"); },
    mapRounds: async () => ({ [facts.match.map]: 1, de_other: 2 }),
  });
  const q = { files: ["x"], filter: { player: facts.match.pov! } };
  const one = await calls.roles({ ...q, filter: { ...q.filter, maps: [facts.match.map] } });
  const byMap = await calls.rolesByMap(q);
  expect(byMap.map((r) => [r.map, r.T.rounds, r.CT.rounds])).toEqual([["de_other", 2 * one.T.rounds, 2 * one.CT.rounds], [facts.match.map, one.T.rounds, one.CT.rounds]]);
  const t = one.T.rounds, ct = one.CT.rounds;
  expect(one.T.blend).not.toBeNull();
  for (const [role, share] of Object.entries(one.T.blend!)) expect(one.all.blend![role]).toBeCloseTo((share * t) / (t + ct), 12);
});
