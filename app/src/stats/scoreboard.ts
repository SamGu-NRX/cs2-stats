// The scoreboard and the counts that need only kills and damage. Definitions that HLTV publishes as
// numbers (K, D, KAST, ADR, opening K-D, multi-kills, traded deaths) are checked against it in
// hltv-exact.test.ts and VALIDATION.md; the rest state their own definition.
import { enemyHit, hitDamage, type Ctx } from "./derive";
import { SWING_TRADE_WINDOW_S } from "./rating3";
import { kastRound } from "./rules";

/** "Saved a teammate": killing an enemy who had hit that teammate in the last 2 s, while the teammate lives. Our window. */
export const SAVE_WINDOW_S = 2;

export function scoreboard(c: Ctx): void {
  const tr = c.tickRate;
  for (let ri = 0; ri < c.nRounds; ri++) {
    const list = c.kills[ri];
    const dmgRows = c.byRound("damages")[ri].filter((i) => enemyHit(c.t, i));
    const d = c.t.damages;
    const dealt = new Map<number, number>();
    const taken = new Map<number, number>();
    for (const i of dmgRows) {
      const a = c.idOf(d.attacker_steamid[i])!;
      const v = c.pi.get(d.victim_steamid[i])!;
      const x = hitDamage(c.t, i);
      dealt.set(a, (dealt.get(a) ?? 0) + x);
      taken.set(v, (taken.get(v) ?? 0) + x);
    }
    // saved teammate: the victim of a kill had hit a teammate of the killer in the last 2 s, and that teammate lives
    const saved = new Map<number, Set<number>>();
    for (const k of list) {
      if (!k.enemy) continue;
      for (const i of dmgRows) {
        if (d.attacker_steamid[i] !== c.players[k.victim].id || d.tick[i] > k.tick || d.tick[i] < k.tick - SAVE_WINDOW_S * tr) continue;
        const mate = c.pi.get(d.victim_steamid[i])!;
        if (mate === k.killer || c.side[ri][mate] !== k.killerSide) continue;
        if (list.some((x) => x.victim === mate && x.tick <= k.tick)) continue;
        let s = saved.get(k.killer!);
        if (!s) saved.set(k.killer!, (s = new Set()));
        s.add(mate);
      }
    }
    const window = SWING_TRADE_WINDOW_S * tr;
    for (const p of c.pr[ri]) {
      if (!p) continue;
      const m = p.m;
      let lastKill: number | null = null;
      for (const k of list) {
        if (k.enemy && k.killer === p.pi) {
          m.kills++;
          if (k.headshot) m.hsKills++;
          if (k.tradeKill) m.tradeKills++;
          if (k.opening) { m.openingKills++; if (p.won) m.openingWins++; }
          if (k.assister !== null && c.side[ri][k.assister] === p.side) m.assistedKills++;
          // perfect kill: the victim had not hurt the killer earlier in the round
          if (!dmgRows.some((i) => d.attacker_steamid[i] === c.players[k.victim].id && d.victim_steamid[i] === c.players[p.pi].id && d.tick[i] <= k.tick)) m.perfectKills++;
          if (lastKill !== null && k.tick - lastKill < window) m.tradeDenials++;
          // bait kill (ours): a kill less than 5 s after a teammate died, on any enemy
          if (list.some((e) => e.victimSide === p.side && e.victim !== p.pi && e.tick <= k.tick && k.tick - e.tick < window)) m.baitKills++;
          lastKill = k.tick;
        }
        if (!k.enemy && k.killer === p.pi && k.victim !== p.pi) m.teamKills++;
        if (k.enemy && k.assister === p.pi) { m.assists++; if (k.flashAssist) m.flashAssists++; }
        if (k.victim === p.pi) {
          m.deaths++;
          if (k.traded) m.tradedDeaths++;
          if (k.opening) { m.openingDeaths++; if (k.traded) m.openingTraded++; }
          // failed trade: died less than 5 s after a teammate, to the same killer
          if (k.enemy && list.some((e) => e !== k && e.killer === k.killer && e.victimSide === p.side && e.tick <= k.tick && k.tick - e.tick < window)) m.failedTrades++;
        }
      }
      m.dmg = dealt.get(p.pi) ?? 0;
      m.dmgTaken = taken.get(p.pi) ?? 0;
      m.kast = kastRound(list, p.pi) ? 1 : 0;
      m.survived = list.some((k) => k.victim === p.pi) ? 0 : 1;
      if (m.kills > 0) m.killRounds = 1;
      if (m.kills >= 2) m.multiKillRounds = 1;
      if (m.kills >= 3) m.k3Rounds = 1;
      if (m.kills >= 4) m.k4Rounds = 1;
      if (m.kills >= 5) m.k5Rounds = 1;
      if (p.won) { m.killsInWins = m.kills; m.dmgInWins = m.dmg; }
      m.savedTeammate = saved.get(p.pi)?.size ?? 0;
      for (const s of saved.values()) if (s.has(p.pi)) m.savedByTeammate++;
    }
  }
}
