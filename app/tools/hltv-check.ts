// Compares the engine's scoreboard with HLTV's on every pro map that joins. Prints each mismatch and
// a per-column tally. Usage: pnpm hltv-check [--sides]
import { derive } from "../src/stats/derive";
import { rollup } from "../src/stats/rollup";
import { hltvMaps, hltvRound1, joinHltv, type HltvLine } from "./hltv";
import { WINPROB, mapLabel, proMaps } from "./node-read";

const sides = process.argv.includes("--sides");
const cols = ["k", "d", "a", "fa", "td", "hs", "kast", "adr", "opK", "opD", "mks", "clutches"] as const;
const tally = Object.fromEntries(cols.map((c) => [c, { ok: 0, bad: 0 }]));
let joined = 0;
const misses: string[] = [];
const GATE = new Set(["k", "d", "kast", "adr"]);
const perMap = new Map<string, number>();

for await (const { dir, t } of proMaps([])) {
  const facts = derive(t, WINPROB);
  const j = joinHltv(facts, hltvMaps());
  const name = mapLabel(dir);
  if (!j) { misses.push(`${name}: no HLTV map joins`); continue; }
  joined++;
  perMap.set(name, j.unmatched.length);
  if (j.unmatched.length) misses.push(`${name}: HLTV players not joined: ${j.unmatched.join(", ")}`);
  for (const [pi, hp] of j.player) {
    for (const side of sides ? (["CT", "T"] as const) : [null]) {
      const want: HltvLine | null = side === null ? hp.total : side === "CT" ? hp.ct : hp.t;
      if (!want) continue;
      const s = rollup([facts], { player: facts.players[pi].id, sides: side ? [side] : undefined }).m;
      const got: Record<(typeof cols)[number], number> = {
        k: s.kills, d: s.deaths, a: s.assists, fa: s.flashAssists, td: s.tradedDeaths, hs: s.hsKills,
        kast: hltvRound1((100 * s.kast) / s.rounds), adr: hltvRound1(s.dmg / s.rounds),
        opK: s.openingKills, opD: s.openingDeaths, mks: s.multiKillRounds, clutches: NaN,
      };
      for (const c of cols) {
        if (Number.isNaN(got[c])) continue;
        const ok = c === "adr" ? Math.abs(got[c] - want[c]) <= 0.5 : got[c] === want[c];
        tally[c][ok ? "ok" : "bad"]++;
        if (!ok && GATE.has(c) && side === null) perMap.set(name, (perMap.get(name) ?? 0) + 1);
        if (!ok) misses.push(`${name} ${j.hltv.file} ${hp.nick}${side ? " " + side : ""} ${c}: ours ${got[c]}, HLTV ${want[c]}`);
      }
    }
  }
}
const exactMaps: string[] = [];
for (const [name, bad] of perMap) if (bad === 0) exactMaps.push(name);
for (const m of misses) console.log(m);
console.log(`
maps with every player exact on K, D, KAST and ADR within 0.5: ${exactMaps.length} of ${joined}`);
for (const m of exactMaps) console.log("  " + m);
console.log(`\njoined ${joined} maps`);
for (const c of cols) console.log(`${c.padEnd(9)} ok ${tally[c].ok}  mismatched ${tally[c].bad}`);
