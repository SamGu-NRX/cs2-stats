// Per player, round and weapon: shots, damaging hits on enemies, damage, kills, and deaths with the
// weapon in hand. Accuracy by gun and gun proficiency are sums of these rows.
import { enemyHit, hitDamage, type Ctx } from "./derive";
import type { WeaponFact } from "./facts";
import { classFromDisplay, isUtility, weaponClass } from "./weapons";

/** Guns only: knives, grenades, the Zeus and the bomb are left out. */
export const isGun = (w: string) => ["pistol", "smg", "heavy", "rifle", "sniper"].includes(weaponClass(w));

export function guns(c: Ctx): WeaponFact[] {
  const out = new Map<string, WeaponFact>();
  const fact = (ri: number, pi: number, weapon: string): WeaponFact => {
    const key = `${ri}:${pi}:${weapon}`;
    let f = out.get(key);
    if (!f) out.set(key, (f = { ri, pi, weapon, shots: 0, hits: 0, headHits: 0, dmg: 0, kills: 0, hsKills: 0, deaths: 0 }));
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
    for (const i of c.byRound("damages")[ri]) {
      const w = d.weapon[i];
      if (!w || !enemyHit(c.t, i) || !isGun(w) || isUtility(w)) continue;
      const p = c.idOf(d.attacker_steamid[i])!;
      if (!rows[p]) continue;
      const f = fact(ri, p, w);
      f.hits++;
      if (d.hitgroup[i] === "head") f.headHits++;
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
