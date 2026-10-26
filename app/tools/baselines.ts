// Builds the anonymous pro baselines from the pro tables:
//   pnpm baselines [--out <file>] [--named <path>]
// On the public CS2RB model (no HLTV pack, or CS2_WINPROB_PACK=none) the default output is the
// committed public/baselines.json. With the private HLTV pack it is the user's own pool,
// %APPDATA%\BotMatchStats\packs\baselines.local.json, which the app ranks against instead
// (worker/baselines-pool.ts); a pack-built pool never goes to public/.
// Writes 21 quantiles per metric for each pool (all, rifler, awper, map:<name>) and side, with no
// names or ids. The optional named pack (default: <data>/derived/baselines-named.json, outside the
// repo) holds each pro's own metric values per side for "plays like" comparisons; it never ships.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { attributes, buildPools, roleOf, type Baselines, type PoolUnit, type SideKey } from "../src/stats/compare";
import { performanceScores, styleScores, type PackPlayer } from "../src/stats/identity";
import { derive } from "../src/stats/derive";
import { modelFingerprint } from "../src/stats/model-params";
import type { MatchFacts } from "../src/stats/facts";
import { rollup, type Summary } from "../src/stats/rollup";
import { LOCAL_BASELINES } from "../src/worker/baselines-pool";
import { DATA_DIR, MAP_MIN_ROUNDS, MIN_ROUNDS, WINPROB, proMapDirs, proMaps } from "./node-read";

const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const PUBLIC = path.resolve("public/baselines.json");
const LOCAL = process.env.APPDATA ? path.join(process.env.APPDATA, "BotMatchStats", "packs", LOCAL_BASELINES) : null;
if (WINPROB.kind !== "cs2rb" && !LOCAL && !process.argv.includes("--out")) throw new Error("APPDATA is not set, so there is no packs folder for baselines.local.json: pass --out");
const OUT = path.resolve(arg("--out", WINPROB.kind === "cs2rb" ? PUBLIC : LOCAL!));
const NAMED = path.resolve(arg("--named", path.join(DATA_DIR, "derived", "baselines-named.json")));
const SIDES: SideKey[] = ["both", "CT", "T"];

if (!proMapDirs().length) throw new Error(`no pro tables under ${DATA_DIR}/demos (set CS2_STATS_DATA)`);
// The committed file ships with the app, so it is built only on the public CS2RB model: swing from the
// private HLTV win-probability lookup must not leave the machine, even as quantiles. A build with
// the pack goes to the user's own baselines.local.json, and nothing pack-built goes under public/.
if (WINPROB.kind !== "cs2rb" && OUT.startsWith(path.dirname(PUBLIC) + path.sep)) {
  throw new Error(`refusing to write public/baselines.json from the ${WINPROB.label}: set CS2_WINPROB_PACK=none to build on CS2RB, or pass --out outside public/`);
}
const facts: MatchFacts[] = [];
for await (const { t } of proMaps()) facts.push(derive(t, WINPROB));

const players = new Map<string, string>();
for (const f of facts) for (const p of f.players) if (!p.bot) players.set(p.id, p.name);

const sideFilter = (s: SideKey) => (s === "both" ? undefined : [s as "CT" | "T"]);
const units: PoolUnit[] = [];
const kept: { id: string; name: string; role: string; rounds: number; sides: Partial<Record<SideKey, Summary>> }[] = [];

for (const [id, name] of players) {
  const both = rollup(facts, { player: id });
  if (both.m.rounds < MIN_ROUNDS) continue;
  const role = roleOf(both);
  const entry: (typeof kept)[number] = { id, name, role, rounds: both.m.rounds, sides: {} };
  for (const side of SIDES) {
    const s = side === "both" ? both : rollup(facts, { player: id, sides: sideFilter(side) });
    if (s.m.rounds < (side === "both" ? MIN_ROUNDS : MIN_ROUNDS / 2)) continue;
    units.push({ pools: ["all", role], side, s });
    entry.sides[side] = s;
  }
  kept.push(entry);
}
const maps = [...new Set(facts.map((f) => f.match.map))];
for (const map of maps) {
  const onMap = facts.filter((f) => f.match.map === map);
  for (const f of onMap) for (const p of f.players) {
    if (p.bot) continue;
    for (const side of SIDES) {
      const s = rollup([f], { player: p.id, sides: sideFilter(side) });
      if (s.m.rounds < (side === "both" ? MAP_MIN_ROUNDS : MAP_MIN_ROUNDS / 2)) continue;
      units.push({ pools: [`map:${map}`], side, s });
    }
  }
}

const b: Baselines = {
  version: 1, built: new Date().toISOString().slice(0, 10),
  source: `${facts.length} maps from public pro match demos, ${kept.length} players with ${MIN_ROUNDS}+ rounds; map pools use player-maps with ${MAP_MIN_ROUNDS}+ rounds; swing from the ${WINPROB.label}`,
  model: modelFingerprint(WINPROB),
  ...buildPools(units),
};
// The named pack: each pro's style and performance scores per side, against the pools just built.
const named: (PackPlayer & { role: string; rounds: number })[] = kept.map((k) => ({
  name: k.name, role: k.role, rounds: k.rounds,
  sides: Object.fromEntries(Object.entries(k.sides).map(([side, s]) => [side, {
    style: styleScores(attributes(s, b, { side: side as SideKey })), performance: performanceScores(s, b, { side: side as SideKey }),
  }])),
}));
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(b));
mkdirSync(path.dirname(NAMED), { recursive: true });
writeFileSync(NAMED, JSON.stringify({ built: b.built, source: b.source, players: named }));
console.log(`${OUT}: ${(JSON.stringify(b).length / 1024).toFixed(0)} KB; pools ${Object.keys(b.pools).join(", ")}`);
for (const [pool, n] of Object.entries(b.n)) console.log(`  ${pool}: ${JSON.stringify(n)}`);
console.log(`${NAMED}: ${named.length} players (private, not shipped)`);
