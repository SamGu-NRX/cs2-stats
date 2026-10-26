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
import { addSpawns, emptySpawns } from "./views";

const SAMPLE = path.resolve(import.meta.dirname, "../../public/samples/synthetic-demo.json.gz");
/** The synthetic sample's facts, decoded once. */
const sampleFacts = decodeMatch(readFileSync(SAMPLE), "synthetic-demo.json.gz").then((m) => derive(pluginToTables(m), CS2RB));

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
      from: {}, counts: { botMatches: 40, qualified: 6, needed: 15, minRounds: 150, minPool: 8 },
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
    careers: async () => ({ baselines: flat(-1e9), unit: all, from: {}, counts: { botMatches: 40, qualified: 9, needed: 15, minRounds: 150, minPool: 8 } }),
    mapRounds: async () => ({}),
  });
  const b = await attributeBlock({ files: ["x"], filter: { player: facts.match.pov! } }, { side: "T" });
  expect(b.firepower?.metrics.length).toBe(8);
  expect(b.firepower?.metrics.every((x) => x.pct === null || x.pct === 0)).toBe(true);
  expect(b.style.scores.map((a) => a.id)).toEqual(["entrying", "trading", "opening", "closing", "sniping", "utility"]);
  expect(b.style.scores.every((a) => a.metrics.length === 4 && a.metrics.every((x) => x.pct === null || x.pct === 100))).toBe(true);
  // fails if the bot-pool Firepower reads the pros, or is missing
  expect(b.style.firepower?.metrics.length).toBe(8);
  expect(b.style.firepower?.metrics.some((x) => x.pct === 100)).toBe(true);
  expect(b.style.firepower?.metrics.every((x) => x.pct === null || x.pct === 100)).toBe(true);
});

it("ranks AWPers against all bots when fewer than 8 AWPer bots are in the matches, and says so", () => {
  // fails if an AWPer gets no style scores because two bots in the matches AWPed, or the fallback is
  // not named. 9 rifler bot matches and 2 AWPer ones: the AWPer pool holds all 11
  const bot = (kills: number, awpKills = 0) => {
    const s = emptySummary();
    s.m.rounds = 24; s.m.kills = kills; s.m.awpKills = awpKills;
    return { both: s, CT: s, T: s };
  };
  const matches = [...Array.from({ length: 9 }, (_, i) => bot(10 + i)), bot(12, 8), bot(13, 8)];
  const p = botPopulation([], matches, "x");
  expect(careersFor(p, "awper", "both")).toMatchObject({ unit: "matches", pool: "all" });
  expect(careersFor(p, "rifler", "both").pool).toBe("rifler");
  expect(p.baselines.n.awper.both).toBe(11);
  expect(p.baselines.pools.awper.both!.kpr).toEqual(p.baselines.pools.all.both!.kpr);
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
  for (const [role, share] of Object.entries(one.T.blend!)) {
    const other = one.CT.blend?.[role] ?? 0;
    if (share === null || other === null) expect(one.all.blend![role]).toBeNull();
    else expect(one.all.blend![role]).toBeCloseTo(((share * t) + other * ct) / (t + ct), 12);
  }
  for (const [role, share] of Object.entries(one.CT.blend ?? {})) {
    const other = one.T.blend?.[role] ?? 0;
    if (share === null || other === null) expect(one.all.blend![role]).toBeNull();
    else expect(one.all.blend![role]).toBeCloseTo((other * t + share * ct) / (t + ct), 12);
  }
});

it("blends each spawn's role over that spawn's rounds on its own map", async () => {
  // fails if a spawn's blend mixes maps: the same match under a second map name gives every spawn a
  // row per map, and each row's blend must cover only that row's rounds
  const m = await decodeMatch(readFileSync(SAMPLE), "synthetic-demo.json.gz");
  const facts = derive(pluginToTables(m), CS2RB);
  const other = { ...facts, match: { ...facts.match, map: "de_other" } };
  const calls = rankingCalls({
    summary: async (q) => rollup([facts, other], q.filter), pros: async () => flat(0), careers: async () => { throw new Error("not used"); },
    spawns: async (q) => { const acc = emptySpawns(); for (const f of [facts, other]) addSpawns(acc, f, q.filter); return acc; },
  });
  const r = await calls.rolesBySpawn({ files: ["x"], filter: { player: facts.match.pov! } });
  const rows = [...r.T, ...r.CT];
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((x) => x.map))).toEqual(new Set([facts.match.map, "de_other"]));
  for (const row of rows) expect(row.blend.rounds, `${row.map} ${row.spawn}`).toBe(row.rounds);
});

it("compares the current period with the previous one, each over its own matches", async () => {
  // fails if a period's dates are ignored or swapped: the earlier match plays every round, the later one
  // only the first five, so each period's KPR is its own match's
  const m = await sampleFacts;
  // started at noon UTC: the same calendar day in any zone from UTC-12 to UTC+11, where the test machine's day is read
  const before = { ...m, match: { ...m.match, date: "2026-10-01", startedAt: "2026-10-01T12:00:00Z" } };
  const now = { ...m, match: { ...m.match, date: "2026-10-10", startedAt: "2026-10-10T12:00:00Z" }, pr: m.pr.filter((r) => r.ri < 5), kills: m.kills.filter((k) => k.ri < 5) };
  const calls = rankingCalls({ summary: async (q) => rollup([before, now], q.filter), pros: async () => flat(0), careers: async () => { throw new Error("not used"); } });
  const player = m.match.pov!;
  const rows = await calls.periodCompare({ files: ["x"], filter: { player } }, { from: "2026-10-05", to: "2026-10-31" }, { from: "2026-10-01", to: "2026-10-04" });
  const kpr = rows.find((r) => r.id === "kpr")!;
  expect([kpr.value, kpr.before]).toEqual([METRIC.kpr.value(rollup([now], { player })), METRIC.kpr.value(rollup([before], { player }))]);
  expect(kpr.value).not.toEqual(kpr.before);
});
