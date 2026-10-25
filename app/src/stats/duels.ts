// Opening and trading context: when in the round a player first fights, how many gun attacks they
// make, and whether a teammate was close enough to trade their death (positions needed).
import { enemyHit, type Ctx } from "./derive";
import { TRADE_WINDOW_S } from "./rules";
import { isGun } from "./guns";

/** A teammate within this 2D distance (world units) of a death could have traded it. See TRADE_DISTANCE's evidence in METRICS.md. */
export const TRADE_DISTANCE = 1000;


export function duels(c: Ctx): void {
  const d = c.t.damages;
  const s = c.t.shots;
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rf = c.rounds[ri];
    const rows = c.pr[ri];

    // first duel: each player's first enemy damage dealt or taken; rank among teammates who dueled
    const first = new Map<number, number>();
    for (const i of c.byRound("damages")[ri]) {
      if (!enemyHit(c.t, i)) continue;
      for (const p of [c.idOf(d.attacker_steamid[i])!, c.pi.get(d.victim_steamid[i])!]) {
        if (!first.has(p) || d.tick[i] < first.get(p)!) first.set(p, d.tick[i]);
      }
    }
    for (const p of rows) {
      if (!p || !first.has(p.pi)) continue;
      const t0 = first.get(p.pi)!;
      const rank = 1 + rows.filter((q) => q && q.side === p.side && q.pi !== p.pi && first.has(q.pi) && first.get(q.pi)! < t0).length;
      p.m.duelRounds = 1;
      p.m.duelRankSum = rank;
      if (rf.freezeEndTick !== null) p.m.duelTimeSum = (t0 - rf.freezeEndTick) / c.tickRate;
    }

    if (s) for (const i of c.byRound("shots")[ri]) {
      const p = c.idOf(s.steamid[i]);
      const row = p === null ? null : rows[p];
      if (row && isGun(s.weapon[i])) row.m.gunShots++;
    }

    if (!c.t.positions) continue;
    for (const p of rows) if (p) p.m.posRounds = 1;
    const window = TRADE_WINDOW_S * c.tickRate;
    for (const k of c.kills[ri]) {
      if (!k.enemy || k.vpos === null) continue;
      const victim = rows[k.victim];
      if (!victim) continue;
      victim.m.deathsPos++;
      let tradeable = false;
      for (const mate of rows) {
        if (!mate || mate.pi === k.victim || mate.side !== victim.side) continue;
        const at = c.posAt(ri, mate.pi, k.tick);
        if (!at || Math.hypot(at[0] - k.vpos[0], at[1] - k.vpos[1]) > TRADE_DISTANCE) continue;
        tradeable = true;
        mate.m.tradeOpps++;
        if (c.kills[ri].some((x) => x.enemy && x.killer === mate.pi && x.victim === k.killer && x.tick >= k.tick && x.tick - k.tick <= window)) mate.m.tradeOppsTaken++;
      }
      if (!tradeable) continue;
      victim.m.tradeableDeaths++;
      if (k.traded) victim.m.tradeableTraded++;
    }
  }
}
