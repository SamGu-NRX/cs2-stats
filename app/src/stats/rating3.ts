// "Rating 3.0 (approx.)", HLTV's Rating 3.02 as the rating agent reconstructed it
// (model/rating3/SPEC.md). Every constant comes from model/rating3/params.json; this file holds the
// formulas only. Show it as RATING3_LABEL.
//
// Inputs per player: eco-adjusted kills, damage and deaths per round, eco-adjusted KAST, multi-kill
// rounds (raw, as HLTV's map cards expose no eco version) and round swing. Each is z-scored with the
// fit's means and SDs, and the rating is a degree-two polynomial in those z-scores.
import params from "../../../model/rating3/params.json";
import { enemyHit, hitDamage, type Ctx } from "./derive";
import type { Measures } from "./facts";
import type { Side } from "./tables";
import { classFromDisplay } from "./weapons";

export const RATING3_LABEL = "Rating 3.0 (approx.)";

// ---- economy groups and the duel model ------------------------------------------------------------

export const ECO_GROUPS = params.duel.groups as EcoGroup[];
export type EcoGroup = "sniper" | "rifle1" | "rifle2" | "smg" | "pistolPlus" | "pistol";

const GROUP_OF: Record<string, EcoGroup> = {};
const put = (g: EcoGroup, names: string[]) => names.forEach((n) => (GROUP_OF[n] = g));
// The SSG 08 costs what a tier-2 rifle costs and is grouped with them; the AWP and both autosnipers are "sniper".
put("sniper", ["awp", "g3sg1", "scar20"]);
put("rifle1", ["ak47", "m4a1", "m4a1_silencer", "aug", "sg556"]);
put("rifle2", ["galilar", "famas", "ssg08"]);
put("smg", ["mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon", "nova", "xm1014", "sawedoff", "mag7", "m249", "negev"]);
put("pistolPlus", ["deagle", "revolver", "p250", "fiveseven", "tec9", "cz75a", "elite"]);
put("pistol", ["glock", "hkp2000", "usp_silencer"]);

/** Economy group of a weapon class name; null for knives, grenades, the Zeus and unknown names. */
export const weaponGroup = (cls: string): EcoGroup | null => GROUP_OF[cls] ?? null;

/**
 * Group from equipment value when the player holds no primary. params.json has no bands yet, so they
 * live here: each starts at the cheapest loadout of its group with kevlar and the $200 pistol (Galil +
 * kevlar $2,650; MAC-10 + kevlar $1,900; kevlar alone $850). Without a primary only the pistol groups
 * and armor are possible, so only the last two bands apply in practice.
 */
const EQUIP_BANDS: readonly [number, EcoGroup][] = [[2400, "rifle2"], [1600, "smg"], [800, "pistolPlus"], [0, "pistol"]];
export function groupFromEquip(equip: number): EcoGroup {
  for (const [min, g] of EQUIP_BANDS) if (equip >= min) return g;
  return "pistol";
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const strength = params.duel.strength as Record<EcoGroup, number>;

/** P(the killer's side of the duel wins) for a killer in group a against a victim in group b. */
export function duelWinProb(a: EcoGroup, b: EcoGroup, killerSide: Side): number {
  const edge = killerSide === "CT" ? params.duel.ct_edge : -params.duel.ct_edge;
  return sigmoid(strength[a] - strength[b] + edge);
}

/** Eco-adjusted value of a kill; the death is charged the same value. */
export const killPoints = (a: EcoGroup, b: EcoGroup, killerSide: Side) => params.duel.kill_points_scale * (1 - duelWinProb(a, b, killerSide));

/**
 * Kill points on every kill, and the eco-adjusted measures (ecoKills, ecoDeaths, ecoDmg, ecoKast) on
 * every player-round. A player's group at a kill comes from the best primary they held then
 * (kills.a_/v_best_primary), else their freeze-end equipment value. Damage uses the freeze-end
 * primary. A kill whose groups are unknown counts its raw value and adds to ecoUnknown.
 */
export function ecoAdjust(c: Ctx): void {
  const k = c.t.kills;
  const pr = c.t.player_rounds;
  const freeze = new Map<number, EcoGroup>();
  for (let i = 0; i < pr.n; i++) {
    const p = c.pi.get(pr.steamid[i])!;
    const prim = pr.best_primary[i] === null ? null : weaponGroup(classFromDisplay(pr.best_primary[i]!));
    const g = prim ?? (pr.equip_value_game[i] === null ? null : groupFromEquip(pr.equip_value_game[i]!));
    if (g) freeze.set((pr.round[i] - 1) * 1024 + p, g);
  }
  const groupAt = (ri: number, p: number, primary: string | null, equip: number | null): EcoGroup | null => {
    const prim = primary === null ? null : weaponGroup(classFromDisplay(primary));
    if (prim) return prim;
    if (equip !== null) return groupFromEquip(equip);
    return freeze.get(ri * 1024 + p) ?? null;
  };
  // kill rows by (tick, victim) to read the kills table's state for each KillFact
  const row = new Map<string, number>();
  for (let i = 0; i < k.n; i++) row.set(`${k.tick[i]}:${k.victim_steamid[i]}`, i);

  for (let ri = 0; ri < c.nRounds; ri++) {
    for (const kf of c.kills[ri]) {
      if (!kf.enemy) continue;
      const i = row.get(`${kf.tick}:${c.players[kf.victim].id}`)!;
      const ga = groupAt(ri, kf.killer!, k.a_best_primary[i], k.a_equip_value_game[i]);
      const gb = groupAt(ri, kf.victim, k.v_best_primary[i], k.v_equip_value_game[i]);
      kf.ecoPoints = ga && gb ? killPoints(ga, gb, kf.killerSide!) : null;
    }
    for (const p of c.pr[ri]) {
      if (!p) continue;
      const m = p.m;
      let kast = 0;
      let died = false;
      for (const kf of c.kills[ri]) {
        const v = kf.ecoPoints ?? 1;
        if (kf.enemy && kf.killer === p.pi) {
          m.ecoKills += v;
          if (kf.ecoPoints === null) m.ecoUnknown++;
          kast = Math.max(kast, Math.min(1, v));
        }
        if (kf.enemy && kf.assister === p.pi && !kf.flashAssist) kast = Math.max(kast, Math.min(1, v));
        if (kf.victim === p.pi) {
          died = true;
          if (kf.enemy) m.ecoDeaths += v;
          if (kf.traded) kast = 1;
        }
      }
      if (!died) kast = 1;
      m.ecoKast += kast;
    }
    for (const i of c.byRound("damages")[ri]) {
      if (!enemyHit(c.t, i)) continue;
      const a = c.idOf(c.t.damages.attacker_steamid[i]);
      const v = c.pi.get(c.t.damages.victim_steamid[i])!;
      const side = c.side[ri][a ?? -1];
      const row = a === null ? null : c.pr[ri][a];
      if (!row || !side) continue;
      const ga = freeze.get(ri * 1024 + a!);
      const gb = freeze.get(ri * 1024 + v);
      row.m.ecoDmg += hitDamage(c.t, i) * (ga && gb ? killPoints(ga, gb, side) : 1);
    }
  }
}

// ---- the rating ------------------------------------------------------------------------------------

export const FEATURES = ["kpr_eco", "adr_eco", "dpr_eco", "kast_eco", "mk", "swing"] as const;
export type Feature = (typeof FEATURES)[number];
export type R3Inputs = Record<Feature, number>;

/** The six inputs from summed measures. KAST and MK in percent; swing in percentage points per round. */
export function r3Inputs(m: Measures): R3Inputs | null {
  if (m.rounds <= 0) return null;
  const n = m.rounds;
  return {
    kpr_eco: m.ecoKills / n, adr_eco: m.ecoDmg / n, dpr_eco: m.ecoDeaths / n, kast_eco: (100 * m.ecoKast) / n,
    mk: (100 * m.multiKillRounds) / n, swing: m.swingRounds ? (100 * m.swing) / m.swingRounds : 0,
  };
}

const terms = params.rating.terms as Record<string, number>;
const means = params.rating.standardisation.means as Record<Feature, number>;
const sds = params.rating.standardisation.sds as Record<Feature, number>;

/** Rating 3.02 from its six inputs (SPEC.md "Sub-ratings and final fit"). */
export function rating3FromInputs(q: R3Inputs): number {
  const z = Object.fromEntries(FEATURES.map((f) => [f, (q[f] - means[f]) / sds[f]])) as Record<Feature, number>;
  let r = terms["1"];
  FEATURES.forEach((f, i) => {
    r += terms[f] * z[f] + terms[`${f}^2`] * z[f] * z[f];
    for (const g of FEATURES.slice(i + 1)) r += terms[`${f} ${g}`] * z[f] * z[g];
  });
  return Math.max(0, r);
}

export interface Rating3 {
  label: typeof RATING3_LABEL;
  value: number | null;
  inputs: R3Inputs | null;
  /** the swing part follows SPEC.md's provisional round-end rule */
  provisional: boolean;
}

export function rating3(m: Measures): Rating3 {
  const inputs = r3Inputs(m);
  return { label: RATING3_LABEL, value: inputs ? rating3FromInputs(inputs) : null, inputs, provisional: true };
}

/** Five seconds: SPEC.md's trade-denial and failed-trade window (params.swing.trade_window_seconds). */
export const SWING_TRADE_WINDOW_S = params.swing.trade_window_seconds;
