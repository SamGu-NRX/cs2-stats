// "Rating 3.0 (approx.)", HLTV's Rating 3.02 as the rating agent reconstructed it
// (model/rating3/SPEC.md). Every constant comes from model/rating3/params.json; this file holds the
// formulas only. Show it as RATING3_LABEL.
//
// Inputs per player: eco-adjusted kills, damage and deaths per round, eco-adjusted KAST, multi-kill
// rounds (raw, as HLTV's map cards expose no eco version) and round swing. The rating is params.json's
// linear model in those six inputs.
import { PARAMS as params } from "./model-params";
import { enemyHit, hitDamage, loadouts, type Ctx } from "./derive";
import type { MatchFacts, Measures } from "./facts";
import { coveredEnough } from "./coverage";
import { rollup, type Filter, type Summary } from "./rollup";
import type { Side } from "./tables";
import { classFromDisplay } from "./weapons";

export const RATING3_LABEL = "Rating 3.0 (approx.)";

// ---- economy groups and the duel model ------------------------------------------------------------

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
const weaponGroup = (cls: string): EcoGroup | null => GROUP_OF[cls] ?? null;

/**
 * Group from equipment value when the player holds no primary. params.json has no bands yet, so they
 * live here: each starts at the cheapest loadout of its group with kevlar and the $200 pistol (Galil +
 * kevlar $2,650; MAC-10 + kevlar $1,900; kevlar alone $850). Without a primary only the pistol groups
 * and armor are possible, so only the last two bands apply in practice.
 */
const EQUIP_BANDS: readonly [number, EcoGroup][] = [[2400, "rifle2"], [1600, "smg"], [800, "pistolPlus"], [0, "pistol"]];
function groupFromEquip(equip: number): EcoGroup {
  for (const [min, g] of EQUIP_BANDS) if (equip >= min) return g;
  return "pistol";
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const strength = params.duel.strength as Record<EcoGroup, number>;

/** P(the killer's side of the duel wins) for a killer in group a against a victim in group b. */
function duelWinProb(a: EcoGroup, b: EcoGroup, killerSide: Side): number {
  const edge = killerSide === "CT" ? params.duel.ct_edge : -params.duel.ct_edge;
  return sigmoid(strength[a] - strength[b] + edge);
}

/** Eco-adjusted value of a kill; the death is charged the same value. */
export const killPoints = (a: EcoGroup, b: EcoGroup, killerSide: Side) => params.duel.kill_points_scale * (1 - duelWinProb(a, b, killerSide));

/**
 * Kill points on every kill, and the eco-adjusted measures (ecoKills, ecoDeaths, ecoDmg, ecoKast) on
 * the player-rounds where every eco value they need is known (ecoRounds 1). A player's group at a kill
 * comes from the best primary they held then (kills.a_/v_best_primary), else their equipment value;
 * damage uses the freeze-end groups. A kill, assist, death or hit whose groups are unknown leaves the
 * player-round out of every eco measure instead of counting it at its raw value, so each eco input is
 * a sum over ecoRounds divided by ecoRounds (rating3.ts valuedRounds).
 */
export function ecoAdjust(c: Ctx): void {
  const k = c.t.kills;
  const pr = c.t.player_rounds;
  const freeze = new Map<number, EcoGroup>();
  for (let i = 0; i < pr.n; i++) {
    const p = c.pi.get(pr.steamid[i])!;
    const prim = pr.best_primary[i] === null ? null : weaponGroup(classFromDisplay(pr.best_primary[i]!));
    const g = prim ?? (pr.equip_value_game[i] === null ? null : groupFromEquip(pr.equip_value_game[i]!));
    const ri = c.riOf(pr.round[i]);
    if (g && ri !== undefined) freeze.set(ri * 1024 + p, g);
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

  const known = loadouts(c);
  for (let ri = 0; ri < c.nRounds; ri++) {
    // Players with an eco event this round whose value cannot be computed. An eco value counts as known
    // when both economy groups can be worked out, from the weapon or else the equipment value; it does
    // not need both loadouts recorded. That stricter rule would null every plugin match's rating
    // (plugin files record no loadouts) and remove a metric the user relies on. The stricter rule
    // gates only the comparison with pros (INPUT_COVERAGE.eco, the `both` count below), so plugin
    // ratings keep a value and get no percentile.
    const unknown = new Set<number>();
    for (const kf of c.kills[ri]) {
      if (!kf.enemy) continue;
      // percentile coverage only: both players' loadouts recorded (INPUT_COVERAGE.eco)
      const both = !!known.get(ri * 1024 + kf.killer!) && !!known.get(ri * 1024 + kf.victim);
      for (const pl of [kf.killer!, kf.victim]) {
        const r = c.pr[ri][pl];
        if (r) { r.m.ecoEvents++; if (both) r.m.ecoEventsKnown++; }
      }
      const i = row.get(`${kf.tick}:${c.players[kf.victim].id}`)!;
      const ga = groupAt(ri, kf.killer!, k.a_best_primary[i], k.a_equip_value_game[i]);
      const gb = groupAt(ri, kf.victim, k.v_best_primary[i], k.v_equip_value_game[i]);
      kf.ecoPoints = ga && gb ? killPoints(ga, gb, kf.killerSide!) : null;
      if (kf.ecoPoints === null) {
        unknown.add(kf.killer!).add(kf.victim);
        if (kf.assister !== null && !kf.flashAssist) unknown.add(kf.assister);
      }
    }
    const dmg = new Map<number, number>();
    for (const i of c.byRound("damages")[ri]) {
      if (!enemyHit(c.t, i)) continue;
      const a = c.idOf(c.t.damages.attacker_steamid[i]);
      const v = c.pi.get(c.t.damages.victim_steamid[i])!;
      const side = c.side[ri][a ?? -1];
      if (a === null || !c.pr[ri][a] || !side) continue;
      const ga = freeze.get(ri * 1024 + a);
      const gb = freeze.get(ri * 1024 + v);
      if (ga && gb) dmg.set(a, (dmg.get(a) ?? 0) + hitDamage(c.t, i) * killPoints(ga, gb, side));
      else unknown.add(a);
    }
    for (const p of c.pr[ri]) {
      if (!p || unknown.has(p.pi)) continue;
      const m = p.m;
      m.ecoRounds = 1;
      m.ecoDmg = dmg.get(p.pi) ?? 0;
      let kast = 0;
      let died = false;
      for (const kf of c.kills[ri]) {
        if (kf.enemy && kf.killer === p.pi) {
          m.ecoKills += kf.ecoPoints!;
          kast = Math.max(kast, Math.min(1, kf.ecoPoints!));
        }
        if (kf.enemy && kf.assister === p.pi && !kf.flashAssist) kast = Math.max(kast, Math.min(1, kf.ecoPoints!));
        if (kf.victim === p.pi) {
          died = true;
          if (kf.enemy) m.ecoDeaths += kf.ecoPoints!;
          if (kf.traded) kast = 1;
        }
      }
      if (!died) kast = 1;
      m.ecoKast += kast;
    }
  }
}

// ---- the rating ------------------------------------------------------------------------------------

export const FEATURES = ["kpr_eco", "adr_eco", "dpr_eco", "kast_eco", "mk", "swing"] as const;
export type Feature = (typeof FEATURES)[number];
export type R3Inputs = Record<Feature, number>;

/**
 * Copies the inputs of every player-round both swing and the eco adjustment could value (swingRounds 1
 * and ecoRounds 1) into the v* measures and counts it in ratedRounds, so Rating 3.0's six inputs
 * average over one set of rounds. Runs after swing.
 */
export function valuedRounds(c: Ctx): void {
  for (const rows of c.pr) for (const p of rows) {
    if (!p || !p.m.swingRounds || !p.m.ecoRounds) continue;
    const m = p.m;
    m.ratedRounds = 1;
    m.vEcoKills = m.ecoKills; m.vEcoDeaths = m.ecoDeaths; m.vEcoDmg = m.ecoDmg; m.vEcoKast = m.ecoKast;
    m.vMultiKillRounds = m.multiKillRounds; m.vSwing = m.swing;
  }
}

/** Share of a summary's rounds that must be rated (ratedRounds) for a rating: below it the inputs are too thin. Ours, no fit. */
export const MIN_VALUED_SHARE = 0.5;

/** Why a set of rounds has no rating, or null when it has one. */
export function r3Gap(m: Measures): string | null {
  if (m.rounds <= 0) return "no rounds";
  if (m.ratedRounds >= MIN_VALUED_SHARE * m.rounds) return null;
  if (m.swingRounds < MIN_VALUED_SHARE * m.rounds) return `round win probability known for ${m.swingRounds} of ${m.rounds} rounds; the rating needs half`;
  return `both the round's win probability and every eco value known for ${m.ratedRounds} of ${m.rounds} rounds; the rating needs half`;
}

/**
 * The six inputs over the rated rounds (ratedRounds): KAST and MK in percent, swing in percentage
 * points per round. Null when r3Gap gives a reason.
 */
export function r3Inputs(m: Measures): R3Inputs | null {
  const n = m.ratedRounds;
  if (r3Gap(m) !== null) return null;
  return {
    kpr_eco: m.vEcoKills / n, adr_eco: m.vEcoDmg / n, dpr_eco: m.vEcoDeaths / n, kast_eco: (100 * m.vEcoKast) / n,
    mk: (100 * m.vMultiKillRounds) / n, swing: (100 * m.vSwing) / n,
  };
}

/** The basis this file implements; a params.json with another basis is an error, so a new formula cannot be read with this one's code. */
const LINEAR = "plain_linear_displayed_eco_inputs";
if (params.rating.basis !== LINEAR) throw new Error(`rating3: params.json rating.basis "${params.rating.basis}" is not implemented in rating3.ts`);

/** params.json's feature names, as the six inputs here are called. */
const INPUT_OF: Record<string, Feature> = { eKPR: "kpr_eco", eADR: "adr_eco", eDPR: "dpr_eco", eKAST: "kast_eco", MK: "mk", Swing: "swing" };
for (const f of params.rating.features) {
  if (!INPUT_OF[f] || typeof params.rating.coefficients[f] !== "number") throw new Error(`rating3: params.json feature "${f}" has no input or coefficient here`);
}

/** Rating 3.02 from its six inputs: params.json's intercept plus each coefficient times its input. */
export function rating3FromInputs(q: R3Inputs): number {
  return params.rating.features.reduce((r, f) => r + params.rating.coefficients[f] * q[INPUT_OF[f]], params.rating.intercept);
}

export interface Rating3 {
  label: typeof RATING3_LABEL;
  value: number | null;
  /** the six inputs value is computed from: value = rating3FromInputs(inputs) */
  inputs: R3Inputs | null;
  /** the rated rounds the inputs average over (the rated sides' ratedRounds) */
  rounds: number;
  /** params.json's own word for the model's state ("approximation") */
  status: string;
  /** why value is null (r3Gap, a thin side, or the coverage gate); null when there is a rating */
  reason: string | null;
}

export const RATING3_STATUS: string = params.rating.status;

/** The coverage gate's reason (coverage.ts), or null when the summary passes it. */
const coverageGap = (s: Summary) =>
  coveredEnough(s.covered) ? null : `the kill-by-kill log covers ${s.covered.nRounds} of ${s.covered.roundsPlayed} rounds; the rating needs half`;

const SIDES = ["CT", "T"] as const;

/**
 * Rating 3.0 of a summary, the one definition every rating the app shows uses: the rating metric, so
 * its percentile and "Work on", the breakdown's inputs, scoreboard lines and the side table.
 *
 * Each side is rated over its own rounds (r3Inputs of Summary.sides), and the total's inputs are the
 * side inputs weighted by each side's rated rounds; value is the rating of those inputs. The rating is
 * linear, so with both sides rated this equals the rating of the pooled rounds; a side under half its
 * rounds rated adds nothing, so a total always lies between the side ratings shown beside it. Null,
 * with a reason, when the kept matches' facts cover under half their rounds (coverage.ts) or the rated
 * sides' rounds are under MIN_VALUED_SHARE of all rounds.
 */
export function rating3Of(s: Summary): Rating3 {
  const none = (reason: string): Rating3 => ({ label: RATING3_LABEL, value: null, inputs: null, rounds: 0, status: RATING3_STATUS, reason });
  const gap = coverageGap(s);
  if (gap) return none(gap);
  const parts = SIDES.flatMap((side) => {
    const q = r3Inputs(s.sides[side]);
    return q ? [{ q, n: s.sides[side].ratedRounds }] : [];
  });
  const n = parts.reduce((a, p) => a + p.n, 0);
  if (!parts.length || n < MIN_VALUED_SHARE * s.m.rounds) {
    return none(r3Gap(s.m) ?? `the sides with half their own rounds rated cover ${n} of ${s.m.rounds} rounds; the rating needs half`);
  }
  const inputs = Object.fromEntries(FEATURES.map((f) => [f, parts.reduce((a, p) => a + p.n * p.q[f], 0) / n])) as R3Inputs;
  return { label: RATING3_LABEL, value: rating3FromInputs(inputs), inputs, rounds: n, status: RATING3_STATUS, reason: null };
}

/** Five seconds: SPEC.md's trade-denial and failed-trade window (params.swing.trade_window_seconds). */
export const SWING_TRADE_WINDOW_S = params.swing.trade_window_seconds;

/** Rating 3.0 for both sides and for each side (rating3Of of each slice). */
export function rating3BySide(facts: MatchFacts[], filter: Filter): Record<"both" | "CT" | "T", Rating3> {
  return {
    both: rating3Of(rollup(facts, filter)), CT: rating3Of(rollup(facts, { ...filter, sides: ["CT"] })), T: rating3Of(rollup(facts, { ...filter, sides: ["T"] })),
  };
}
