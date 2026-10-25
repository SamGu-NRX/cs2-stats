// Utility usage per player, split by side. CS Demo Manager defines utility damage (grenade-type
// weapons) and flash assists; the rest follow HLTV's and Leetify's public descriptions:
// - a flash is "effective" when it blinds at least one enemy for 2.0 s or more;
// - a flash "leads to a kill" when an enemy it blinded dies to your team while still blind.
// Plugin 1.0.0 adds links that make this exact: throws (grenades thrown, not just detonated),
// blinds.flash (which flash blinded whom), damage.nade (which HE did the damage), rounds.utilSpent and
// kills.vUtil. Older files fall back: detonations stand in for throws, and blinds from one flash are
// grouped by their shared detonation tick.
import { sameSide, type MatchCtx } from "./context";
import { CT, UTIL_ORDER, type Side } from "./schema";
import { PRICE } from "./weapons";

export const EFFECTIVE_FLASH_MS = 2000;

export interface UtilSlice {
  rounds: number;
  flashes: number;
  smokes: number;
  hes: number;
  molotovs: number;
  decoys: number;
  enemiesFlashed: number;
  enemyBlindMs: number;
  effectiveFlashes: number;
  flashKills: number;
  flashAssists: number;
  teamFlashed: number;
  teamBlindMs: number;
  selfFlashed: number;
  heDmg: number;
  heHits: number;
  heTeamDmg: number;
  fireDmg: number;
  utilDmg: number;
  utilKills: number;
  /** rounds where utility purchases were recorded, and their total (needs plugin data) */
  spentRounds: number;
  spent: number;
  /** deaths where held utility was recorded, and its value (needs plugin data) */
  heldDeaths: number;
  heldValue: number;
}

export const emptyUtil = (): UtilSlice => ({
  rounds: 0, flashes: 0, smokes: 0, hes: 0, molotovs: 0, decoys: 0, enemiesFlashed: 0, enemyBlindMs: 0,
  effectiveFlashes: 0, flashKills: 0, flashAssists: 0, teamFlashed: 0, teamBlindMs: 0, selfFlashed: 0, heDmg: 0,
  heHits: 0, heTeamDmg: 0, fireDmg: 0, utilDmg: 0, utilKills: 0, spentRounds: 0, spent: 0, heldDeaths: 0, heldValue: 0,
});

const FIRE = new Set(["inferno", "molotov", "incgrenade"]);
const GRENADE = new Set(["hegrenade", "flashbang", "smokegrenade", "decoy", ...FIRE]);

/** Adds round ri's utility for every player into out[pi][side]. */
export function countUtility(ctx: MatchCtx, ri: number, out: { t: UtilSlice; ct: UtilSlice }[]) {
  const m = ctx.m;
  const slot = (pi: number): UtilSlice | null => {
    const s = ctx.side(ri, pi);
    return s === null ? null : s === CT ? out[pi].ct : out[pi].t;
  };
  for (let pi = 0; pi < ctx.nPlayers; pi++) { const u = slot(pi); if (u) u.rounds++; }

  // Thrown grenades: the throws table when present, otherwise detonations.
  const g = m.throws ?? m.grenades;
  for (let j = 0; j < g.ri.length; j++) {
    if (g.ri[j] !== ri || g.thrower[j] === null) continue;
    const u = slot(g.thrower[j]!);
    if (!u) continue;
    const type = g.type[j];
    if (type === "flash") u.flashes++;
    else if (type === "smoke") u.smokes++;
    else if (type === "he") u.hes++;
    else if (type === "molotov" || type === "incgrenade") u.molotovs++;
    else if (type === "decoy") u.decoys++;
  }

  // Money spent on grenades (plugin 1.0.0).
  const spent = m.rounds.utilSpent?.[ri];
  if (spent) for (let pi = 0; pi < ctx.nPlayers; pi++) {
    const u = slot(pi);
    if (u && spent[pi] !== null) { u.spentRounds++; u.spent += spent[pi]!; }
  }

  const kills = ctx.killsByRound.get(ri) ?? [];
  const b = m.blinds;
  const flashEffective = new Set<string>();
  for (let j = 0; j < b.ri.length; j++) {
    const a = b.attacker[j];
    if (b.ri[j] !== ri || a === null || b.ms[j] <= 0) continue;
    const u = slot(a);
    if (!u) continue;
    const v = b.victim[j];
    const sa = ctx.side(ri, a);
    if (v === a) { u.selfFlashed++; continue; }
    if (ctx.side(ri, v) === sa) { u.teamFlashed++; u.teamBlindMs += b.ms[j]; continue; }
    u.enemiesFlashed++;
    u.enemyBlindMs += b.ms[j];
    // per flash: the linked detonation row when present, else the shared detonation tick
    const flashKey = b.flash?.[j] != null ? `f${b.flash[j]}` : `t${b.tick[j]}`;
    if (b.ms[j] >= EFFECTIVE_FLASH_MS) flashEffective.add(`${a}:${flashKey}`);
    const until = b.tick[j] + (b.ms[j] / 1000) * ctx.tickrate;
    const k = kills.find((x) => x.victim === v && x.tick >= b.tick[j] && x.tick <= until && x.killer !== null && ctx.side(ri, x.killer) === sa);
    if (k) u.flashKills++;
  }
  for (const key of flashEffective) slot(+key.split(":")[0])!.effectiveFlashes++;

  const vUtil = m.kills.vUtil;
  for (const k of kills) {
    if (k.flashAssister !== null && !sameSide(k)) { const u = slot(k.flashAssister); if (u) u.flashAssists++; }
    if (k.killer !== null && !sameSide(k) && !k.killerBot && GRENADE.has(k.weapon)) { const u = slot(k.killer); if (u) u.utilKills++; }
    // grenades still held at death (plugin 1.0.0)
    const held = vUtil?.[k.i];
    if (held) {
      const u = slot(k.victim);
      if (u) { u.heldDeaths++; u.heldValue += held.reduce((a, n, t) => a + n * PRICE[UTIL_ORDER[t]], 0); }
    }
  }

  const d = m.damage;
  const heHit = new Set<string>();
  for (let j = 0; j < d.ri.length; j++) {
    const a = d.attacker[j];
    if (d.ri[j] !== ri || a === null) continue;
    const w = m.weapons[d.weapon[j]] ?? "";
    if (!GRENADE.has(w)) continue;
    const u = slot(a);
    const v = d.victim[j];
    if (!u || v === a) continue;
    const enemy = ctx.side(ri, v) !== ctx.side(ri, a);
    if (w === "hegrenade") {
      // one HE: the linked detonation row when present, else the damage tick
      const nade = d.nade?.[j] != null ? `n${d.nade[j]}` : `t${d.tick[j]}`;
      if (enemy) { u.heDmg += d.dmg[j]; heHit.add(`${a}:${nade}:${v}`); } else u.heTeamDmg += d.dmg[j];
    }
    if (!enemy) continue;
    if (FIRE.has(w)) u.fireDmg += d.dmg[j];
    u.utilDmg += d.dmg[j];
  }
  for (const key of heHit) slot(+key.split(":")[0])!.heHits++;
}

export const sideSlices = (u: { t: UtilSlice; ct: UtilSlice }, side: Side | "both"): UtilSlice => {
  if (side === 2) return u.t;
  if (side === 3) return u.ct;
  const s = emptyUtil();
  for (const k of Object.keys(s) as (keyof UtilSlice)[]) s[k] = u.t[k] + u.ct[k];
  return s;
};
