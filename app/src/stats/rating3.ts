// "Rating 3.0 (approx.)", HLTV's Rating 3.02 as the rating agent reconstructed it
// (model/rating3/SPEC.md). Every constant comes from model/rating3/params.json; this file holds the
// formulas only. Show it as RATING3_LABEL.
//
// Inputs per player and side: eco-adjusted kills, damage and deaths per round, eco-adjusted KAST, the
// 2K to 5K rounds (raw, as HLTV's map cards expose no eco version) and round swing. Each side is rated
// by params.json's per-side curves; the total is the sides' round-weighted mean (sideRating3, rating3Of).
import { liveLeaves, survives } from "./rules";
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
    const left = new Set(liveLeaves(c.rounds[ri]).map((l) => l.pi));
    for (const p of c.pr[ri]) {
      if (!p || unknown.has(p.pi)) continue;
      const m = p.m;
      m.ecoRounds = 1;
      m.ecoDmg = dmg.get(p.pi) ?? 0;
      // A round's eco-adjusted KAST is the most its kills, assists, survival or trade are worth: a kill
      // or an assist at the kill's eco value, uncapped; survival and a traded death at 1. Survival counts
      // only in a won round: fitted on HLTV's side eKAST, a survived lost round (a save) weighs 0.007 and
      // a survived won round 1.07 (pnpm rating-dump rows, 7,060 player-map sides), and the rule takes
      // the engine's side eKAST error from 6.58 to 5.20 points.
      let kast = 0;
      for (const kf of c.kills[ri]) {
        if (kf.enemy && kf.killer === p.pi) {
          m.ecoKills += kf.ecoPoints!;
          kast = Math.max(kast, kf.ecoPoints!);
        }
        if (kf.enemy && kf.assister === p.pi && !kf.flashAssist) kast = Math.max(kast, kf.ecoPoints!);
        if (kf.victim === p.pi) {
          if (kf.enemy) m.ecoDeaths += kf.ecoPoints!;
          if (kf.traded) kast = Math.max(kast, 1);
        }
      }
      // survival as the scoreboard's KAST reads it (rules.ts survives): a disconnect is no survival
      if (p.won && survives(c.kills[ri], p.pi, left.has(p.pi))) kast = Math.max(kast, 1);
      m.ecoKast += kast;
    }
  }
}

// ---- the rating ------------------------------------------------------------------------------------

export const FEATURES = ["kpr_eco", "adr_eco", "dpr_eco", "kast_eco", "mk", "swing"] as const;
export type Feature = (typeof FEATURES)[number];
/** The 2K to 5K rounds, each as a percent of rated rounds: exactly 2, 3 or 4 kills, and 5. mk is their sum. */
export const KILL_ROUNDS = ["k2", "k3", "k4", "k5"] as const;
export type KillRounds = (typeof KILL_ROUNDS)[number];
export type R3Inputs = Record<Feature | KillRounds, number>;

/**
 * Copies the inputs of every player-round both swing and the eco adjustment could value (swingRounds 1
 * and ecoRounds 1) into the v* measures and counts it in ratedRounds, so Rating 3.0's inputs average
 * over one set of rounds. Runs after swing.
 */
export function valuedRounds(c: Ctx): void {
  for (const rows of c.pr) for (const p of rows) {
    if (!p || !p.m.swingRounds || !p.m.ecoRounds) continue;
    const m = p.m;
    m.ratedRounds = 1;
    m.vEcoKills = m.ecoKills; m.vEcoDeaths = m.ecoDeaths; m.vEcoDmg = m.ecoDmg; m.vEcoKast = m.ecoKast;
    m.vMultiKillRounds = m.multiKillRounds; m.vK3Rounds = m.k3Rounds; m.vK4Rounds = m.k4Rounds; m.vK5Rounds = m.k5Rounds;
    m.vSwing = m.swing;
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

/** The inputs of measures summed over `n` rated rounds: KAST, MK and the 2K-5K rounds in percent, swing in percentage points per round. */
function inputsOf(m: Partial<Measures>, n: number): R3Inputs {
  const v = (k: keyof Measures) => (m[k] ?? 0) / n;
  return {
    kpr_eco: v("vEcoKills"), adr_eco: v("vEcoDmg"), dpr_eco: v("vEcoDeaths"), kast_eco: 100 * v("vEcoKast"),
    mk: 100 * v("vMultiKillRounds"), swing: 100 * v("vSwing"),
    k2: 100 * (v("vMultiKillRounds") - v("vK3Rounds")), k3: 100 * (v("vK3Rounds") - v("vK4Rounds")), k4: 100 * (v("vK4Rounds") - v("vK5Rounds")), k5: 100 * v("vK5Rounds"),
  };
}

/** The inputs over the rated rounds (ratedRounds). Null when r3Gap gives a reason. */
export function r3Inputs(m: Measures): R3Inputs | null {
  return r3Gap(m) !== null ? null : inputsOf(m, m.ratedRounds);
}

/** The inputs over the rated rounds however few they are (no r3Gap): where a round's split is taken (roundRating3). Null with no rated round. */
export function ratedInputs(m: Measures): R3Inputs | null {
  return m.ratedRounds > 0 ? inputsOf(m, m.ratedRounds) : null;
}

/** One rated round's inputs from its measures; null unless the round is rated. */
export function roundInputs(m: Partial<Measures>): R3Inputs | null {
  return m.ratedRounds ? inputsOf(m, 1) : null;
}

/** The basis this file implements; a params.json with another basis is an error, so a new formula cannot be read with this one's code. */
const BASIS = "per_side_piecewise_linear";
if (params.rating.basis !== BASIS) throw new Error(`rating3: params.json rating.basis "${params.rating.basis}" is not implemented in rating3.ts`);

type Curve = { slope: number; knots: number[]; slope_changes: number[] };
/** params.json's curve for each curved input */
const CURVE_OF: Record<Exclude<Feature, "mk">, Curve> = {
  kpr_eco: params.rating.curves.eKPR, adr_eco: params.rating.curves.eADR, dpr_eco: params.rating.curves.eDPR,
  kast_eco: params.rating.curves.eKAST, swing: params.rating.curves.Swing,
};
const KILL_WEIGHT: Record<KillRounds, number> = { k2: params.rating.kill_rounds.K2, k3: params.rating.kill_rounds.K3, k4: params.rating.kill_rounds.K4, k5: params.rating.kill_rounds.K5 };
for (const [f, c] of Object.entries(CURVE_OF)) {
  if (!c || c.knots.length !== c.slope_changes.length) throw new Error(`rating3: params.json curve for ${f} is missing or has unmatched knots and slope changes`);
}
for (const [k, w] of Object.entries(KILL_WEIGHT)) if (typeof w !== "number") throw new Error(`rating3: params.json has no weight for ${k}`);

/** A curve's value at x: its slope times x, plus each slope change times how far x is past its knot. */
const curveAt = (c: Curve, x: number) => c.knots.reduce((v, k, i) => v + c.slope_changes[i] * Math.max(0, x - k), c.slope * x);
/** A curve's slope at x, taking the slope to the right of a knot x sits on. */
const slopeAt = (c: Curve, x: number) => c.knots.reduce((v, k, i) => v + (x >= k ? c.slope_changes[i] : 0), c.slope);

/** A rating split: the base (intercept, plus the CT offset on CT), each input's contribution, and their sum. */
export interface R3Split { value: number; base: number; terms: Record<Feature, number> }

const baseOf = (side: Side) => params.rating.intercept + (side === "CT" ? params.rating.ct_offset : 0);
const mkTerm = (q: R3Inputs) => KILL_ROUNDS.reduce((a, k) => a + (KILL_WEIGHT[k] * q[k]) / 100, 0);
const split = (base: number, terms: Record<Feature, number>): R3Split => ({ value: FEATURES.reduce((a, f) => a + terms[f], base), base, terms });

/**
 * Rating 3.02 of one side's inputs (model/rating3/SPEC.md): the base, each curved input's curve
 * value, and the 2K-5K rounds' weights. HLTV rates each side this way; a total is the sides' mean
 * weighted by rounds (rating3Of).
 */
export function sideRating3(q: R3Inputs, side: Side): R3Split {
  const terms = Object.fromEntries(FEATURES.map((f) => [f, f === "mk" ? mkTerm(q) : curveAt(CURVE_OF[f], q[f])])) as Record<Feature, number>;
  return split(baseOf(side), terms);
}

/**
 * One rated round's share of its side's rating: each curve's value at the side's inputs plus its
 * slope there times how far the round's input is from them, and the round's own 2K-5K weight. Over the
 * side's rated rounds these average to the side's rating exactly; the curves bend, so a round's inputs
 * put through them alone would not.
 */
export function roundRating3(sideInputs: R3Inputs, side: Side, round: R3Inputs): R3Split {
  const terms = Object.fromEntries(FEATURES.map((f) => {
    if (f === "mk") return [f, mkTerm(round)];
    const c = CURVE_OF[f];
    return [f, curveAt(c, sideInputs[f]) + slopeAt(c, sideInputs[f]) * (round[f] - sideInputs[f])];
  })) as Record<Feature, number>;
  return split(baseOf(side), terms);
}

export interface Rating3 {
  label: typeof RATING3_LABEL;
  value: number | null;
  /** the inputs over the rated rounds, the sides' weighted by their rated rounds (for display; the rating is per side) */
  inputs: R3Inputs | null;
  /** the base and each input's contribution, the rated sides' weighted by their rated rounds: base plus the terms is value */
  base: number | null;
  terms: Record<Feature, number> | null;
  /** the rated rounds the inputs average over (the rated sides' ratedRounds) */
  rounds: number;
  /** params.json's own word for the model's state ("approximation") */
  status: string;
  /** why value is null (r3Gap, a thin side, or the coverage gate); null when there is a rating */
  reason: string | null;
}

export const RATING3_STATUS: string = params.rating.status;

/** Where the weights come from, for Settings: params.json's fit and dataset. */
export const RATING3_WEIGHTS = `${params.rating.fit.method.replaceAll("_", " ")} on HLTV's displayed side inputs, ${params.rating.dataset.maps} maps (${params.rating.dataset.player_maps.toLocaleString("en")} player-maps, ${params.rating.dataset.date}); held-out mean error ${params.rating.fit.held_out_mae.toFixed(3)}`;

/** The coverage gate's reason (coverage.ts), or null when the summary passes it. */
const coverageGap = (s: Summary) =>
  coveredEnough(s.covered) ? null : `the kill-by-kill log covers ${s.covered.nRounds} of ${s.covered.roundsPlayed} rounds; the rating needs half`;

const SIDES = ["CT", "T"] as const;

/**
 * Rating 3.0 of a summary, the one definition every rating the app shows uses: the rating metric, so
 * its percentile and "Work on", the breakdown's inputs, scoreboard lines and the side table.
 *
 * Each side is rated over its own rounds (sideRating3 of r3Inputs of Summary.sides), and the total is
 * the side ratings weighted by each side's rated rounds, as HLTV's map total is. A side under half its
 * rounds rated adds nothing, so a total always lies between the side ratings shown beside it. Null,
 * with a reason, when the kept matches' facts cover under half their rounds (coverage.ts) or the rated
 * sides' rounds are under MIN_VALUED_SHARE of all rounds.
 */
export function rating3Of(s: Summary): Rating3 {
  const none = (reason: string): Rating3 => ({ label: RATING3_LABEL, value: null, inputs: null, base: null, terms: null, rounds: 0, status: RATING3_STATUS, reason });
  const gap = coverageGap(s);
  if (gap) return none(gap);
  const parts = SIDES.flatMap((side) => {
    const q = r3Inputs(s.sides[side]);
    return q ? [{ q, n: s.sides[side].ratedRounds, r: sideRating3(q, side) }] : [];
  });
  const n = parts.reduce((a, p) => a + p.n, 0);
  if (!parts.length || n < MIN_VALUED_SHARE * s.m.rounds) {
    return none(r3Gap(s.m) ?? `the sides with half their own rounds rated cover ${n} of ${s.m.rounds} rounds; the rating needs half`);
  }
  const mean = (get: (p: (typeof parts)[number]) => number) => parts.reduce((a, p) => a + p.n * get(p), 0) / n;
  const inputs = Object.fromEntries([...FEATURES, ...KILL_ROUNDS].map((f) => [f, mean((p) => p.q[f])])) as R3Inputs;
  const terms = Object.fromEntries(FEATURES.map((f) => [f, mean((p) => p.r.terms[f])])) as Record<Feature, number>;
  return { label: RATING3_LABEL, value: mean((p) => p.r.value), inputs, base: mean((p) => p.r.base), terms, rounds: n, status: RATING3_STATUS, reason: null };
}

/** Five seconds: SPEC.md's trade-denial and failed-trade window (params.swing.trade_window_seconds). */
export const SWING_TRADE_WINDOW_S = params.swing.trade_window_seconds;

/** Rating 3.0 for both sides and for each side (rating3Of of each slice). */
export function rating3BySide(facts: MatchFacts[], filter: Filter): Record<"both" | "CT" | "T", Rating3> {
  return {
    both: rating3Of(rollup(facts, filter)), CT: rating3Of(rollup(facts, { ...filter, sides: ["CT"] })), T: rating3Of(rollup(facts, { ...filter, sides: ["T"] })),
  };
}
