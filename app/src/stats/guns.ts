// Per player, round and weapon: shots, damaging hits on enemies by body part, damage, kills, and deaths with the
// weapon in hand. Accuracy by gun and gun proficiency are sums of these rows.
import { enemyHit, hitDamage, type Ctx } from "./derive";
import { HIT_GROUPS, type WeaponFact } from "./facts";
import type { Summary } from "./rollup";
import { classFromDisplay, isUtility, weaponClass } from "./weapons";

/** Guns only: knives, grenades, the Zeus and the bomb are left out. */
export const isGun = (w: string) => ["pistol", "smg", "heavy", "rifle", "sniper"].includes(weaponClass(w));

export function guns(c: Ctx): WeaponFact[] {
  const out = new Map<string, WeaponFact>();
  const fact = (ri: number, pi: number, weapon: string): WeaponFact => {
    const key = `${ri}:${pi}:${weapon}`;
    let f = out.get(key);
    if (!f) out.set(key, (f = { ri, pi, weapon, shots: 0, hits: 0, groups: HIT_GROUPS.map(() => 0), dmg: 0, kills: 0, hsKills: 0, deaths: 0 }));
    return f;
  };
  const s = c.t.shots;
  const d = c.t.damages;
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rows = c.pr[ri];
    if (s) for (const i of c.byRound("shots")[ri]) {
      const p = c.idOf(s.steamid[i]);
      if (p !== null && rows[p] && isGun(s.weapon[i])) fact(ri, p, s.weapon[i]).shots++;
    }
    // damages.weapon names the M4A1-S "m4a1" and the USP-S "hkp2000"; the shot on the same tick names
    // the gun correctly (every gun hit lands on its shot's tick).
    const shotGun = new Map<string, string>();
    if (s) for (const i of c.byRound("shots")[ri]) shotGun.set(`${s.steamid[i]}:${s.tick[i]}`, s.weapon[i]);
    for (const i of c.byRound("damages")[ri]) {
      // A rebuilt hit (damages.source = health) names no weapon; the same-tick shot names the gun.
      const named = d.weapon[i];
      const w = named === null || isGun(named) ? shotGun.get(`${d.attacker_steamid[i]}:${d.tick[i]}`) ?? named : named;
      if (!w || !enemyHit(c.t, i) || !isGun(w) || isUtility(w)) continue;
      const p = c.idOf(d.attacker_steamid[i])!;
      if (!rows[p]) continue;
      const f = fact(ri, p, w);
      f.hits++;
      const g = HIT_GROUPS.indexOf(d.hitgroup[i] as (typeof HIT_GROUPS)[number]);
      if (g >= 0) f.groups[g]++;
      f.dmg += hitDamage(c.t, i);
    }
    for (const k of c.kills[ri]) {
      if (!k.enemy) continue;
      if (isGun(k.weapon) && rows[k.killer!]) { const f = fact(ri, k.killer!, k.weapon); f.kills++; if (k.headshot) f.hsKills++; }
      const held = k.victimWeapon === null ? null : classFromDisplay(k.victimWeapon);
      if (held && isGun(held) && rows[k.victim]) fact(ri, k.victim, held).deaths++;
    }
  }
  return [...out.values()];
}

// ---- per-gun proficiency ----------------------------------------------------------------------------
// How much a player uses a gun and how steady they are with it; not how good the numbers are. Kills
// and damage stay with the performance metrics.

/** Rounds of use at which familiarity reaches 1. Ours, no fit: about four full matches with one gun. */
export const FAMILIAR_ROUNDS = 100;
/** Shots with a gun in a match for that match's accuracy to count toward consistency. Ours, no fit. */
export const MIN_SHOTS_PER_MATCH = 20;
/** Matches with MIN_SHOTS_PER_MATCH needed before consistency is shown. Ours, no fit. */
export const MIN_MATCHES = 3;

export interface GunProficiency {
  weapon: string;
  /** rounds the player fired the gun, and that as a share of rounds played */
  roundsUsed: number;
  usage: number;
  /** min(1, roundsUsed / FAMILIAR_ROUNDS) */
  familiarity: number;
  /** 1 minus the coefficient of variation of per-match accuracy; null with too few matches */
  consistency: number | null;
  /** 100 x familiarity x consistency; null while consistency is */
  proficiency: number | null;
  evidence: string;
}

/**
 * Proficiency per gun, most used first, from the rollup over the kept matches and each match's own
 * rollup (consistency compares matches). A caller streaming matches builds both in one pass.
 */
export function gunProficiency(all: Summary, perMatch: Summary["weapons"][]): GunProficiency[] {
  return Object.entries(all.weapons)
    .filter(([w, t]) => isGun(w) && t.shots > 0)
    .map(([weapon, t]) => {
      const acc = perMatch.map((w) => w[weapon]).filter((x) => x && x.shots >= MIN_SHOTS_PER_MATCH).map((x) => x!.hits / x!.shots);
      const mean = acc.reduce((s, v) => s + v, 0) / (acc.length || 1);
      const sd = Math.sqrt(acc.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, acc.length - 1));
      const consistency = acc.length >= MIN_MATCHES && mean > 0 ? Math.max(0, 1 - sd / mean) : null;
      const familiarity = Math.min(1, t.rounds / FAMILIAR_ROUNDS);
      const usage = all.m.rounds ? t.rounds / all.m.rounds : 0;
      return {
        weapon, roundsUsed: t.rounds, usage, familiarity, consistency,
        proficiency: consistency === null ? null : 100 * familiarity * consistency,
        evidence: `Fired in ${t.rounds} of ${all.m.rounds} rounds; accuracy ${consistency === null ? `measured in ${acc.length} of ${MIN_MATCHES} matches needed` : `varies by ${Math.round(100 * (1 - consistency))}% between matches`}.`,
      };
    })
    .sort((a, b) => b.roundsUsed - a.roundsUsed);
}
