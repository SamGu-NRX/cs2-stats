// Builds the anonymous pro baselines from the pro tables:
//   pnpm baselines [--out public/baselines.json] [--named <path>]
// Writes 21 quantiles per metric for each pool (all, rifler, awper, map:<name>) and side, with no
// names or ids. The optional named pack (default: <data>/derived/baselines-named.json, outside the
// repo) holds each pro's own metric values per side for "plays like" comparisons; it never ships.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { QUANTILES, roleOf, type Baselines, type SideKey } from "../src/stats/compare";
import { derive } from "../src/stats/derive";
import type { MatchFacts } from "../src/stats/facts";
import { METRICS } from "../src/stats/metrics";
import { rollup, type Summary } from "../src/stats/rollup";
import { DATA_DIR, loadDir, proMapDirs } from "./node-read";

/** Rounds a player needs, over all maps, to count in the player pools; per side, half of it. */
export const MIN_ROUNDS = 40;
/** Rounds a player needs on one map to count in that map's pool. */
export const MAP_MIN_ROUNDS = 16;
/** Units with a value a metric needs in a pool before its quantiles are written. */
export const MIN_UNITS = 8;

const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = path.resolve(arg("--out", "public/baselines.json"));
const NAMED = path.resolve(arg("--named", path.join(DATA_DIR, "derived", "baselines-named.json")));
const SIDES: SideKey[] = ["both", "CT", "T"];

const dirs = proMapDirs();
if (!dirs.length) throw new Error(`no pro tables under ${DATA_DIR}/demos (set CS2_STATS_DATA)`);
const facts: MatchFacts[] = [];
for (const d of dirs) facts.push(derive(await loadDir(d)));

const players = new Map<string, string>();
for (const f of facts) for (const p of f.players) if (!p.bot) players.set(p.id, p.name);

const sideFilter = (s: SideKey) => (s === "both" ? undefined : [s as "CT" | "T"]);
const values = (s: Summary) => Object.fromEntries(METRICS.map((m) => [m.id, m.value(s)]));
const round4 = (x: number) => Number(x.toPrecision(4));

function quantiles(xs: number[]): number[] {
  const v = [...xs].sort((a, b) => a - b);
  return QUANTILES.map((q) => {
    const pos = (q / 100) * (v.length - 1);
    const lo = Math.floor(pos);
    return round4(v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo));
  });
}

type Unit = { pool: string[]; side: SideKey; vals: Record<string, number | null> };
const units: Unit[] = [];
const named: { name: string; role: string; rounds: number; sides: Partial<Record<SideKey, Record<string, number | null>>> }[] = [];

for (const [id, name] of players) {
  const both = rollup(facts, { player: id });
  if (both.m.rounds < MIN_ROUNDS) continue;
  const role = roleOf(both);
  const entry: (typeof named)[number] = { name, role, rounds: both.m.rounds, sides: {} };
  for (const side of SIDES) {
    const s = side === "both" ? both : rollup(facts, { player: id, sides: sideFilter(side) });
    if (s.m.rounds < (side === "both" ? MIN_ROUNDS : MIN_ROUNDS / 2)) continue;
    const vals = values(s);
    units.push({ pool: ["all", role], side, vals });
    entry.sides[side] = vals;
  }
  named.push(entry);
}
const maps = [...new Set(facts.map((f) => f.match.map))];
for (const map of maps) {
  const onMap = facts.filter((f) => f.match.map === map);
  for (const f of onMap) for (const p of f.players) {
    if (p.bot) continue;
    for (const side of SIDES) {
      const s = rollup([f], { player: p.id, sides: sideFilter(side) });
      if (s.m.rounds < (side === "both" ? MAP_MIN_ROUNDS : MAP_MIN_ROUNDS / 2)) continue;
      units.push({ pool: [`map:${map}`], side, vals: values(s) });
    }
  }
}

const b: Baselines = {
  version: 1, built: new Date().toISOString().slice(0, 10),
  source: `${facts.length} pro maps from HLTV demos, ${named.length} players with ${MIN_ROUNDS}+ rounds; map pools use player-maps with ${MAP_MIN_ROUNDS}+ rounds`,
  n: {}, pools: {},
};
const poolNames = new Set(units.flatMap((u) => u.pool));
for (const pool of poolNames) {
  b.pools[pool] = {};
  b.n[pool] = {};
  for (const side of SIDES) {
    const us = units.filter((u) => u.side === side && u.pool.includes(pool));
    if (!us.length) continue;
    b.n[pool][side] = us.length;
    const out: Record<string, number[] | null> = {};
    for (const m of METRICS) {
      const xs = us.map((u) => u.vals[m.id]).filter((x): x is number => x !== null && Number.isFinite(x));
      out[m.id] = xs.length >= MIN_UNITS ? quantiles(xs) : null;
    }
    b.pools[pool][side] = out;
  }
}
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(b));
mkdirSync(path.dirname(NAMED), { recursive: true });
writeFileSync(NAMED, JSON.stringify({ built: b.built, source: b.source, players: named }));
console.log(`${OUT}: ${(JSON.stringify(b).length / 1024).toFixed(0)} KB; pools ${[...poolNames].join(", ")}`);
for (const [pool, n] of Object.entries(b.n)) console.log(`  ${pool}: ${JSON.stringify(n)}`);
console.log(`${NAMED}: ${named.length} players (private, not shipped)`);
