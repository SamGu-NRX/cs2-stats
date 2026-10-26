// Why the scoreboard definitions are what they are: scores each candidate against HLTV on every joined
// pro map (exact matches for counts, within 0.5 for ADR as HLTV displays it), and prints the equipment
// bands of HLTV's round buy labels over all HLTV maps.   pnpm scoreboard-variants
import { derive, hitDamage } from "../src/stats/derive";
import type { KillFact } from "../src/stats/facts";
import { hltvMaps, hltvRound1, joinHltv } from "./hltv";
import { WINPROB, proMaps } from "./node-read";

const score: Record<string, number> = {};
let n = 0;
const ok = (k: string, hit: boolean) => { if (hit) score[k] = (score[k] ?? 0) + 1; };

/** Traded deaths under a window and a pairing: every death the trade kill avenged, or only the earliest. */
function traded(list: KillFact[], tickRate: number, window: number, pairing: "all" | "earliest"): Set<KillFact> {
  const out = new Set<KillFact>();
  for (const later of list) {
    if (!later.enemy) continue;
    const c = list.filter((e) => e !== later && e.enemy && e.killer === later.victim && e.victimSide === later.killerSide && e.tick <= later.tick && later.tick - e.tick <= window * tickRate);
    if (pairing === "all") c.forEach((e) => out.add(e)); else if (c.length) out.add(c[0]);
  }
  return out;
}

for await (const { t } of proMaps([])) {
  const f = derive(t, WINPROB);
  const j = joinHltv(f, hltvMaps());
  if (!j) continue;
  const R = f.match.nRounds;
  const byRound = f.rounds.map((r) => f.kills.filter((k) => k.ri === r.ri));
  const rules = { "5 s, every avenged death": [5, "all"], "5 s, earliest only": [5, "earliest"], "5.4 s, every avenged death": [5.4, "all"], "5.4 s, earliest only": [5.4, "earliest"] } as const;
  const tradedBy = Object.fromEntries(Object.entries(rules).map(([name, [w, p]]) => [name, byRound.map((l) => traded(l, f.match.tickRate, w, p))]));
  // enemy damage per (round, attacker, victim) up to each tick, for damage-threshold assists
  const hits = t.damages;
  const hitsOf = new Map<string, [number, number][]>();
  for (let i = 0; i < hits.n; i++) {
    if (hits.attacker_steamid[i] === null || hits.is_team_damage[i] || hits.is_self[i]) continue;
    const key = `${hits.round[i]}|${hits.attacker_steamid[i]}|${hits.victim_steamid[i]}`;
    let l = hitsOf.get(key);
    if (!l) hitsOf.set(key, (l = []));
    l.push([hits.tick[i], hitDamage(t, i)]);
  }
  const dmgBefore = (ri: number, a: number, v: number, tick: number) =>
    (hitsOf.get(`${f.rounds[ri].number}|${f.players[a].id}|${f.players[v].id}`) ?? []).reduce((x, [tk, d]) => (tk <= tick ? x + d : x), 0);
  for (const [pi, h] of j.player) {
    const id = f.players[pi].id;
    n++;
    // ADR: health removed (the game's scoreboard) against the hurt event's damage capped at health (HLTV)
    let removed = 0, reported = 0;
    for (let i = 0; i < t.damages.n; i++) {
      if (t.damages.attacker_steamid[i] !== id || t.damages.is_self[i] || t.damages.is_team_damage[i]) continue;
      removed += t.damages.dmg_health_capped[i];
      reported += hitDamage(t, i);
    }
    const adr = (x: number) => hltvRound1(x / R);
    ok("ADR: health removed", Math.abs(adr(removed) - h.total.adr) <= 0.5 + 1e-9);
    ok("ADR: reported damage capped at health", Math.abs(adr(reported) - h.total.adr) <= 0.5 + 1e-9);
    // deaths: every death in the tables, against dropping suicides after the round ended
    let all = 0, kept = 0;
    for (let i = 0; i < t.kills.n; i++) {
      if (t.kills.victim_steamid[i] !== id) continue;
      all++;
      const ri = f.rounds.find((r) => r.number === t.kills.round[i]);
      if (!(t.kills.is_suicide[i] && ri && t.kills.tick[i] > ri.endTick)) kept++;
    }
    ok("deaths: every death", all === h.total.d);
    ok("deaths: post-round suicides dropped", kept === h.total.d);
    // traded deaths and KAST under each trade rule; KAST with and without flash assists
    for (const [name, sets] of Object.entries(tradedBy)) {
      const td = byRound.reduce((s, l, ri) => s + l.filter((k) => k.victim === pi && sets[ri].has(k)).length, 0);
      ok(`traded deaths, ${name}`, td === h.total.td);
      for (const flash of [false, true]) {
        let kast = 0;
        byRound.forEach((l, ri) => {
          if (!f.pr.some((r) => r.ri === ri && r.pi === pi)) return;
          let died = false, ev = false;
          for (const k of l) {
            if (k.enemy && (k.killer === pi || (k.assister === pi && (flash || !k.flashAssist)))) ev = true;
            if (k.victim === pi) { died = true; if (sets[ri].has(k)) ev = true; }
          }
          if (ev || !died) kast++;
        });
        ok(`KAST, ${name}, ${flash ? "with" : "without"} flash assists`, hltvRound1((100 * kast) / R) === h.total.kast);
      }
      if (name !== "5.4 s, earliest only") continue;
      // the assist: the game's (non-flash) assister, a teammate with 40+ or 41+ enemy damage on the
      // victim before the kill, or either; and whether team kills and suicides count as deaths
      const variants = { "game assist": [0, false, true], "40+ damage": [40, true, true], "41+ damage": [41, true, true], "game assist or 40+ damage": [40, false, true], "game assist, team kills and suicides not deaths": [0, false, false] } as const;
      for (const [vname, [thr, dmgOnly, worldDeaths]] of Object.entries(variants)) {
        let kast = 0;
        byRound.forEach((l, ri) => {
          if (!f.pr.some((r) => r.ri === ri && r.pi === pi)) return;
          let died = false, ev = false;
          for (const k of l) {
            const game = k.assister === pi && !k.flashAssist;
            const byDmg = thr > 0 && k.enemy && k.killer !== pi && k.victimSide !== null && f.pr.some((r) => r.ri === ri && r.pi === pi && r.side !== k.victimSide) && dmgBefore(ri, pi, k.victim, k.tick) >= thr;
            if (k.enemy && (k.killer === pi || (dmgOnly ? byDmg : game || byDmg))) ev = true;
            if (k.victim === pi && (worldDeaths || k.enemy)) { died = true; if (sets[ri].has(k)) ev = true; }
          }
          if (ev || !died) kast++;
        });
        ok(`KAST assist rule: ${vname}`, hltvRound1((100 * kast) / R) === h.total.kast);
      }
    }
  }
}
console.log(`${n} player-maps on joined maps`);
for (const [k, v] of Object.entries(score).sort()) console.log(`  ${String(v).padStart(5)}  ${k}`);

// HLTV's buy labels: the equipment range of each label over every HLTV map
const bands: Record<string, number[]> = {};
for (const h of hltvMaps()) for (const r of h.equip) for (const e of r ?? []) (bands[e.label] ??= []).push(e.value);
console.log("\nHLTV round buy labels, team equipment:");
for (const [label, v] of Object.entries(bands)) console.log(`  ${label.padEnd(7)} ${v.length} team-rounds, $${Math.min(...v)} to $${Math.max(...v)}`);
