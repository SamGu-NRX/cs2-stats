// Face validity on the pro maps for every metric without ground truth: per-player p10 / p50 / p90,
// AWPers against riflers, the players at the top of selected identity metrics, pooled reaction and
// time-to-shot against the 150 to 400 ms human range, radar spotting against mesh line of sight, and
// the size of the cached facts.
//   pnpm family-check [--min-rounds 60]
import { roleOf } from "../src/stats/compare";
import { derive } from "../src/stats/derive";
import type { MatchFacts } from "../src/stats/facts";
import { METRICS, type Metric } from "../src/stats/metrics";
import { rollup, type Summary } from "../src/stats/rollup";
import { WINPROB, proMaps } from "./node-read";

const i = process.argv.indexOf("--min-rounds");
const MIN_ROUNDS = i > 0 ? Number(process.argv[i + 1]) : 60;
const TOP = ["openingAttempts", "entryAttempts", "pushDepth", "smokesPR", "crosshairPlacement", "counterStrafe", "firstSpotPct"];

const facts: MatchFacts[] = [];
let spottedSecs = 0, sightSecs = 0;
for await (const { t } of proMaps()) {
  const f = derive(t, WINPROB);
  facts.push(f);
  const T = t.engagement_ticks;
  if (T && f.match.visibility === "ok" && t.spotted) {
    let n = 0;
    for (let k = 0; k < T.n; k++) if (T.mesh_visible[k] === true && T.smoke_blocked[k] === false) n++;
    sightSecs += n / f.match.tickRate;
    spottedSecs += f.information.reduce((s, x) => s + x.spotSecs, 0);
  }
}
// cached facts per map (IndexedDB holds them as JSON): whole facts, the presence part, and the median of
// each part, in KB
{
  const kb = (x: unknown) => JSON.stringify(x).length / 1024;
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const all = facts.map(kb), pres = facts.map((f) => kb(f.presence));
  console.log(`facts per map: median ${med(all).toFixed(0)} KB, max ${Math.max(...all).toFixed(0)} KB; presence median ${med(pres).toFixed(0)} KB, max ${Math.max(...pres).toFixed(0)} KB`);
  const parts = Object.keys(facts[0]) as (keyof MatchFacts)[];
  console.log(`  median KB per part: ${parts.map((k) => `${k} ${med(facts.map((f) => kb(f[k]))).toFixed(0)}`).join(", ")}`);
}
const names = new Map<string, string>();
for (const f of facts) for (const p of f.players) if (!p.bot) names.set(p.id, p.name);
const players: { name: string; role: string; s: Summary }[] = [];
for (const [id, name] of names) {
  const s = rollup(facts, { player: id });
  if (s.m.rounds >= MIN_ROUNDS) players.push({ name, role: roleOf(s), s });
}
const q = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]; };
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
const vals = (m: Metric, role?: string) => players.filter((p) => !role || p.role === role).map((p) => m.value(p.s)).filter((x): x is number => x !== null);

console.log(`${facts.length} maps, ${players.length} players with ${MIN_ROUNDS}+ rounds (${players.filter((p) => p.role === "awper").length} AWPers)`);
console.log("metric".padEnd(22), "players", "p10 / p50 / p90".padEnd(24), "AWPer p50 / rifler p50");
for (const m of METRICS) {
  if (m.status === "unavailable") continue;
  const v = vals(m);
  if (v.length < 8) continue;
  const aw = vals(m, "awper"), rf = vals(m, "rifler");
  console.log(m.id.padEnd(22), String(v.length).padStart(7), `${fmt(q(v, 0.1))} / ${fmt(q(v, 0.5))} / ${fmt(q(v, 0.9))}`.padEnd(24), aw.length && rf.length ? `${fmt(q(aw, 0.5))} / ${fmt(q(rf, 0.5))}` : "");
}
for (const id of TOP) {
  const m = METRICS.find((x) => x.id === id)!;
  const ranked = players.map((p) => ({ name: p.name, v: m.value(p.s) })).filter((x) => x.v !== null).sort((a, b) => (m.lowerIsBetter ? a.v! - b.v! : b.v! - a.v!));
  console.log(`top ${id}: ${ranked.slice(0, 5).map((x) => `${x.name} ${fmt(x.v!)}`).join(", ")}`);
}
const pooled = rollup(facts, { player: [...names.keys()] });
const within = (xs: number[]) => `${xs.length} samples, ${((100 * xs.filter((x) => x >= 0.15 && x <= 0.4).length) / xs.length).toFixed(1)}% within 150-400 ms, ${((100 * xs.filter((x) => x < 0.15).length) / xs.length).toFixed(1)}% under`;
console.log(`pooled reaction: median ${(1000 * q(pooled.aim.react, 0.5)).toFixed(0)} ms, ${within(pooled.aim.react)}`);
console.log(`pooled time to first shot: median ${(1000 * q(pooled.aim.shot, 0.5)).toFixed(0)} ms, ${within(pooled.aim.shot)}`);
console.log(`radar spotted seconds ${spottedSecs.toFixed(0)} against mesh line-of-sight seconds ${sightSecs.toFixed(0)} (maps with both)`);
