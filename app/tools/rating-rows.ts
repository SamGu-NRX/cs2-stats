// The kill and hit rows the rating dump writes (rating-dump.ts), from one derived map and its HLTV join. Each row
// carries the economy groups derive used for its eco value (KillFact.aGroup/vGroup, PlayerRound.ecoGroup), so the
// duel fit (model/rating3/eco_fit.py) trains on the app's own groups, with no second definition to drift.
import { enemyHit, hitDamage } from "../src/stats/derive";
import type { MatchFacts } from "../src/stats/facts";
import { rosterTables } from "../src/stats/roster";
import type { MatchTables } from "../src/stats/tables";
import type { HltvJoin } from "./hltv";

/** One row per enemy kill the kills table holds, with both players' economy state and the swing credits. */
export function killRows(f: MatchFacts, t: MatchTables, j: HltvJoin): Record<string, unknown>[] {
  const pid = (pi: number | null) => (pi === null ? null : j.player.get(pi)?.pid ?? null);
  const k = rosterTables(t).kills;
  const at = new Map<string, number>();
  for (let i = 0; i < k.n; i++) at.set(`${k.tick[i]}:${k.victim_steamid[i]}`, i);
  const out: Record<string, unknown>[] = [];
  for (const kf of f.kills) {
    const i = at.get(`${kf.tick}:${f.players[kf.victim].id}`);
    if (i === undefined) continue;
    out.push({
      hltv: j.hltv.file, ri: kf.ri, tick: kf.tick, t: kf.t, killer: pid(kf.killer), victim: pid(kf.victim), assister: pid(kf.assister),
      flashAssist: kf.flashAssist, enemy: kf.enemy, killerSide: kf.killerSide, victimSide: kf.victimSide, weapon: kf.weapon,
      opening: kf.opening, traded: kf.traded, tradeKill: kf.tradeKill, ecoPoints: kf.ecoPoints, aGroup: kf.aGroup, vGroup: kf.vGroup,
      headshot: kf.headshot, aPrimary: k.a_best_primary[i], vPrimary: k.v_best_primary[i], aEquip: k.a_equip_value_game[i],
      vEquip: k.v_equip_value_game[i], aHealth: k.a_health[i], vActive: k.v_active_weapon[i], aActive: k.a_active_weapon[i],
      aArmor: k.a_armor[i], vArmor: k.v_armor[i], aHelmet: k.a_helmet[i], vHelmet: k.v_helmet[i],
      postEnd: kf.tick > f.rounds[kf.ri].endTick,
      credits: kf.credits.map(([p, v]) => [pid(p), v]),
    });
  }
  return out;
}

/** One row per enemy hit (damage per hit), with both players' freeze-end economy groups. */
export function hitRows(f: MatchFacts, t: MatchTables, j: HltvJoin): Record<string, unknown>[] {
  const pid = (pi: number | null) => (pi === null ? null : j.player.get(pi)?.pid ?? null);
  const rt = rosterTables(t);
  const d = rt.damages;
  const riOf = new Map(f.rounds.map((r) => [r.number, r.ri]));
  const idx = new Map(f.players.map((p, i) => [p.id, i]));
  const freeze = new Map(f.pr.map((r) => [r.ri * 1024 + r.pi, r.ecoGroup]));
  const groupOf = (ri: number, pi: number | null) => (pi === null ? null : freeze.get(ri * 1024 + pi) ?? null);
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < d.n; i++) {
    if (!enemyHit(rt, i)) continue;
    const ri = riOf.get(d.round[i]);
    if (ri === undefined) continue;
    const a = idx.get(d.attacker_steamid[i]!) ?? null, v = idx.get(d.victim_steamid[i]) ?? null;
    out.push({
      hltv: j.hltv.file, ri, tick: d.tick[i], attacker: pid(a), victim: pid(v),
      dmg: hitDamage(rt, i), hpBefore: d.health_before[i], weapon: d.weapon[i], aSide: d.a_side[i], postEnd: d.tick[i] > f.rounds[ri].endTick,
      aGroup: groupOf(ri, a), vGroup: groupOf(ri, v),
    });
  }
  return out;
}
