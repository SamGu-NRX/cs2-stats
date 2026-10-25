// "Rating 3.0 (approx.)": an approximation of HLTV's Rating 3.0 built from what HLTV has published
// about it. HLTV shows six inputs (KPR, ADR, DPR, KAST, multi-kill %, round swing) and adjusts kills,
// damage and deaths for the economy: a kill is worth more when the killer's equipment made the duel
// harder. The combination weights and intercept are parameters (R3Params); fit them with
// model/fit_rating3.py against HLTV's published values. Until a fit lands, the default weights are
// Rating 2.0's public approximation on the shared inputs and the result is flagged uncalibrated.
//
// Economy adjustment, as HLTV's article describes it: each player falls in an economy group from
// armor and the most expensive weapon; P(win) of a duel comes from a table by group and side; a kill
// is worth k·(1 − P(killer wins)), with k set so an average kill is worth about 1.
import { assistersOf, sameSide, type MatchCtx } from "./context";
import { isEnemyKill, TRADE_WINDOW_S, type Trades } from "./rules";
import { CT, type Side } from "./schema";
import type { SwingResult } from "./swing";
import { FITTED_R3 } from "./rating3-params";

export const RATING3_LABEL = "Rating 3.0 (approx.)";

// ---- economy groups ------------------------------------------------------------------------------

export const ECO_GROUPS = ["sniper", "rifle1", "rifle2", "smg", "pistolPlus", "pistol"] as const;
export type EcoGroup = (typeof ECO_GROUPS)[number];
export const ECO_GROUP_LABEL: Record<EcoGroup, string> = {
  sniper: "Sniper", rifle1: "Tier-1 rifle", rifle2: "Tier-2 rifle", smg: "SMG / shotgun", pistolPlus: "Upgraded pistol", pistol: "Starter pistol",
};

const GROUP_OF: Record<string, EcoGroup> = {};
const put = (g: EcoGroup, names: string[]) => names.forEach((n) => (GROUP_OF[n] = g));
// The SSG 08 costs what a tier-2 rifle costs and is grouped with them; the AWP and both autosnipers are "Sniper".
put("sniper", ["awp", "g3sg1", "scar20"]);
put("rifle1", ["ak47", "m4a1", "m4a1_silencer", "aug", "sg556"]);
put("rifle2", ["galilar", "famas", "ssg08"]);
put("smg", ["mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon", "nova", "xm1014", "sawedoff", "mag7", "m249", "negev"]);
put("pistolPlus", ["deagle", "revolver", "p250", "fiveseven", "tec9", "cz75a", "elite"]);
put("pistol", ["glock", "hkp2000", "usp_silencer"]);

/** Economy group of a weapon; null for knives, grenades, the Zeus and unknown names. */
export function weaponGroup(name: string): EcoGroup | null {
  return GROUP_OF[name] ?? null;
}

/** Stronger group first: lower index in ECO_GROUPS. */
export const stronger = (a: EcoGroup, b: EcoGroup): EcoGroup => (ECO_GROUPS.indexOf(a) <= ECO_GROUPS.indexOf(b) ? a : b);

/**
 * Freeze-end equipment (grenades taken off when the purchase log has them) → group, for players
 * whose weapons the file does not show. Each band starts at the cheapest loadout of the group with
 * kevlar and the $200 pistol: AK + kevlar = $3,550, Galil + kevlar = $2,650, MAC-10 + kevlar = $1,900,
 * kevlar alone = $850. Armor alone lifts a starter pistol to "upgraded pistol".
 */
export const EQUIP_BANDS: readonly [number, EcoGroup][] = [[3400, "rifle1"], [2400, "rifle2"], [1600, "smg"], [800, "pistolPlus"], [0, "pistol"]];

export function groupFromEquip(net: number): EcoGroup {
  for (const [min, g] of EQUIP_BANDS) if (net >= min) return g;
  return "pistol";
}

/**
 * A player's group in a duel: a primary the player was seen using this round (damage, kills, the
 * human's shots) decides; otherwise the stronger of a seen pistol and the equipment band, since a
 * player seen only with a pistol may still have a rifle.
 */
export function inferGroup(seen: EcoGroup | null, equipNet: number | null): EcoGroup | null {
  if (seen && ECO_GROUPS.indexOf(seen) <= ECO_GROUPS.indexOf("smg")) return seen;
  const band = equipNet === null ? null : groupFromEquip(equipNet);
  if (seen && band) return stronger(seen, band);
  return seen ?? band;
}

// ---- duel table --------------------------------------------------------------------------------

export interface DuelParams {
  /** Bradley–Terry strength per group (logit scale); P(a beats b) = σ(s_a − s_b ± ctEdge) */
  strength: Record<EcoGroup, number>;
  /** added for a CT killer, subtracted for a T killer */
  ctEdge: number;
  /** kill points = k·(1 − P(killer wins)) */
  k: number;
  source: string;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Anchored on HLTV's Rating 3.0 article: T rifle vs CT rifle 48 % (1.10 kill points), T rifle vs
 * starter pistol 75 % (0.54), AWP vs rifle 56 % as T and 60 % as CT. Those four numbers fix
 * ctEdge = −logit(0.48) = 0.080, rifle1 − pistol = logit(0.75) + 0.080 = 1.179 and sniper − rifle1 =
 * 0.32 (0.321 from the T figure, 0.325 from the CT one). k = 2.14 is the mean of 1.10/0.52 and
 * 0.54/0.25.
 *
 * rifle2, smg and pistolPlus have no published anchor. fitDuelStrengths on this app's eight matches
 * (875 kills between bots and the human, anchors held fixed, 2026-10-25) gave rifle2 0.83 and
 * pistolPlus 0.29, used here. It gave smg 1.20, above tier-1 rifles (SMG vs tier-1 rifle kills were
 * 40 to 41), which breaks the group order and reflects bot play on 132 duels, so smg takes the
 * midpoint of its neighbours instead.
 */
export const DEFAULT_DUEL: DuelParams = {
  strength: { sniper: 1.502, rifle1: 1.179, rifle2: 0.83, smg: 0.56, pistolPlus: 0.29, pistol: 0 },
  ctEdge: -logit(0.48),
  k: 2.14,
  source: "HLTV Rating 3.0 anchors; tier-2 rifle and upgraded pistol fitted on 8 bot matches; SMG interpolated",
};

/** P(the killer's side of the duel wins) for a killer in group a against a victim in group b. */
export function duelWinProb(a: EcoGroup, b: EcoGroup, killerSide: Side, p: DuelParams = DEFAULT_DUEL): number {
  return sigmoid(p.strength[a] - p.strength[b] + (killerSide === CT ? p.ctEdge : -p.ctEdge));
}

/** Eco-adjusted value of a kill; a death is charged the same value (dying as the favourite costs more). */
export function killPoints(a: EcoGroup, b: EcoGroup, killerSide: Side, p: DuelParams = DEFAULT_DUEL): number {
  return p.k * (1 - duelWinProb(a, b, killerSide, p));
}

/** The whole table, [killer group][victim group] for a T killer and a CT killer. */
export function duelTable(p: DuelParams = DEFAULT_DUEL): Record<"t" | "ct", Record<EcoGroup, Record<EcoGroup, number>>> {
  const side = (s: Side) => Object.fromEntries(ECO_GROUPS.map((a) => [a, Object.fromEntries(ECO_GROUPS.map((b) => [b, duelWinProb(a, b, s, p)]))])) as Record<EcoGroup, Record<EcoGroup, number>>;
  return { t: side(2), ct: side(3) };
}

/**
 * Bradley–Terry fit of free group strengths from duel outcomes (each kill is a duel the killer won),
 * holding the anchored groups and ctEdge fixed. Plain gradient ascent on the log-likelihood with a
 * weak pull toward the prior strengths (weight `ridge`) so a group with few duels stays near it.
 */
export function fitDuelStrengths(duels: { winner: EcoGroup; loser: EcoGroup; winnerSide: Side }[], free: EcoGroup[], prior: DuelParams = DEFAULT_DUEL, ridge = 1, iters = 4000, rate = 0.01): Record<EcoGroup, number> {
  const s = { ...prior.strength };
  for (let it = 0; it < iters; it++) {
    const grad: Record<string, number> = Object.fromEntries(free.map((g) => [g, -ridge * (s[g] - prior.strength[g])]));
    for (const d of duels) {
      const p = sigmoid(s[d.winner] - s[d.loser] + (d.winnerSide === CT ? prior.ctEdge : -prior.ctEdge));
      if (d.winner in grad) grad[d.winner] += 1 - p;
      if (d.loser in grad) grad[d.loser] -= 1 - p;
    }
    for (const g of free) s[g] += rate * grad[g];
  }
  return s;
}

// ---- per-round groups ----------------------------------------------------------------------------

/**
 * Each player's group at each kill tick of round ri: weapons seen up to that tick (the player's
 * damage and kill rows, and the human's shots), else the freeze-end equipment band.
 */
export function roundGroups(ctx: MatchCtx, ri: number): (pi: number, tick: number) => EcoGroup | null {
  const m = ctx.m;
  const seen: { pi: number; tick: number; g: EcoGroup }[] = [];
  const note = (pi: number | null, tick: number, w: string) => {
    const g = pi === null ? null : weaponGroup(w);
    if (g) seen.push({ pi: pi!, tick, g });
  };
  const d = m.damage;
  for (let j = 0; j < d.ri.length; j++) if (d.ri[j] === ri) note(d.attacker[j], d.tick[j], m.weapons[d.weapon[j]] ?? "");
  for (const k of ctx.killsByRound.get(ri) ?? []) note(k.killer, k.tick, k.weapon);
  const s = m.aim.shots;
  for (let i = 0; i < s.ri.length; i++) if (s.ri[i] === ri) note(m.human, s.tick[i], m.weapons[s.weapon[i]] ?? "");
  const equip = m.rounds.equip[ri] ?? [];
  const util = m.rounds.utilSpent?.[ri];
  return (pi, tick) => {
    let best: EcoGroup | null = null;
    for (const x of seen) if (x.pi === pi && x.tick <= tick) best = best ? stronger(best, x.g) : x.g;
    const e = equip[pi] ?? null;
    const net = e === null ? null : e - (util?.[pi] ?? 0);
    return inferGroup(best, net);
  };
}

// ---- additive inputs -------------------------------------------------------------------------------

/** Swing credit split; none of these has evidence behind it yet, they are the parameters a fit would tune. */
export interface SwingSplit {
  /** share of a kill's swing to the player who dealt the final damage */
  final: number;
  /** share to the flash assister, when there is one */
  flash: number;
  /** damage needed on the victim to share the rest (HLTV's assist threshold) */
  assistDmg: number;
  /** share of a death's swing forgiven when the death was traded */
  tradedRelief: number;
}
export const DEFAULT_SPLIT: SwingSplit = { final: 0.5, flash: 0.1, assistDmg: 40, tradedRelief: 0.25 };

/** Additive Rating 3.0 inputs over rounds with the kill log, so profiles sum them. */
export interface R3Inputs {
  rounds: number;
  kills: number;
  ecoKills: number;
  deaths: number;
  ecoDeaths: number;
  dmg: number;
  ecoDmg: number;
  kastRounds: number;
  /** KAST rounds weighted by the value of the event that earned them, at most 1 per round */
  ecoKast: number;
  /** rounds with 2+ kills, and the same weighted by the round's mean kill points (at most 1) */
  mkRounds: number;
  ecoMk: number;
  /** Rating 3 swing (credit split by SwingSplit), win-probability points, over swingRounds */
  swing: number;
  swingRounds: number;
  /** assists by HLTV's rule: 40+ damage on a victim someone else killed */
  assists40: number;
  /** a kill less than 5 s after the same player's previous kill in the round */
  tradeDenials: number;
  /** died less than 5 s after a teammate, to the same killer */
  failedTrades: number;
  /** kills whose groups could not be inferred (counted raw, weight 1) */
  unknownGroups: number;
}

export const emptyR3 = (): R3Inputs => ({
  rounds: 0, kills: 0, ecoKills: 0, deaths: 0, ecoDeaths: 0, dmg: 0, ecoDmg: 0, kastRounds: 0, ecoKast: 0,
  mkRounds: 0, ecoMk: 0, swing: 0, swingRounds: 0, assists40: 0, tradeDenials: 0, failedTrades: 0, unknownGroups: 0,
});

/** Rating 3 inputs for every player of a match, over its full rounds. */
export function r3Inputs(ctx: MatchCtx, trades: Trades, swing: SwingResult, duel: DuelParams = DEFAULT_DUEL, split: SwingSplit = DEFAULT_SPLIT): R3Inputs[] {
  const m = ctx.m;
  const out = Array.from({ length: ctx.nPlayers }, emptyR3);
  const pos = new Map(ctx.kills.map((k, j) => [k, j]));
  const swingByKill = new Map(swing.swings.map((s) => [s.k, s]));
  const window = TRADE_WINDOW_S * ctx.tickrate;
  const d = m.damage;

  for (const ri of ctx.rounds) {
    const list = ctx.killsByRound.get(ri) ?? [];
    const groupAt = roundGroups(ctx, ri);
    const valued = swing.available && !swing.unknownRounds.has(ri);
    const dmgRows: number[] = [];
    for (let j = 0; j < d.ri.length; j++) if (d.ri[j] === ri) dmgRows.push(j);

    const kp = new Map<number, number>(); // kill position -> eco kill points
    for (const k of list) {
      const j = pos.get(k)!;
      if (!isEnemyKill(k)) continue;
      const ks = ctx.side(ri, k.killer!);
      const ga = groupAt(k.killer!, k.tick);
      const gb = groupAt(k.victim, k.tick);
      if (!ga || !gb || ks === null) continue;
      kp.set(j, killPoints(ga, gb, ks, duel));
    }

    for (let pi = 0; pi < ctx.nPlayers; pi++) {
      const side = ctx.side(ri, pi);
      if (side === null) continue;
      const x = out[pi];
      x.rounds++;
      if (valued) x.swingRounds++;
      let kills = 0, ecoKills = 0;
      let kastW = 0;
      let survived = true;
      let lastKillTick: number | null = null;
      for (const k of list) {
        const j = pos.get(k)!;
        if (k.killer === pi && isEnemyKill(k) && !k.killerBot) {
          kills++;
          const v = kp.get(j) ?? 1;
          if (!kp.has(j)) x.unknownGroups++;
          ecoKills += v;
          kastW = Math.max(kastW, Math.min(1, v));
          if (lastKillTick !== null && k.tick - lastKillTick < window) x.tradeDenials++;
          lastKillTick = k.tick;
        }
        if (assistersOf(k).includes(pi) && !sameSide(k) && side !== ctx.side(ri, k.victim)) kastW = Math.max(kastW, Math.min(1, kp.get(j) ?? 1));
        if (k.victim === pi && !k.victimBot) {
          x.deaths++;
          if (!sameSide(k)) {
            survived = false;
            x.ecoDeaths += kp.get(j) ?? 1;
            if (trades.tradeDeath[j]) kastW = Math.max(kastW, 1);
            // failed trade: a teammate died to the same killer less than 5 s before
            if (k.killer !== null && list.some((e) => e !== k && e.killer === k.killer && e.tick <= k.tick && k.tick - e.tick < window && ctx.side(ri, e.victim) === side && e.victim !== pi)) x.failedTrades++;
          }
        }
      }
      if (survived) kastW = 1;
      x.kills += kills;
      x.ecoKills += ecoKills;
      if (kastW > 0) { x.kastRounds++; x.ecoKast += kastW; }
      if (kills >= 2) { x.mkRounds++; x.ecoMk += Math.min(1, ecoKills / kills); }
    }

    // damage, eco-weighted by the attacker's and victim's groups at the hit
    for (const j of dmgRows) {
      const a = d.attacker[j];
      const v = d.victim[j];
      if (a === null || a === v) continue;
      const sa = ctx.side(ri, a);
      if (sa === null || sa === ctx.side(ri, v)) continue;
      const ga = groupAt(a, d.tick[j]);
      const gb = groupAt(v, d.tick[j]);
      out[a].dmg += d.dmg[j];
      out[a].ecoDmg += d.dmg[j] * (ga && gb ? killPoints(ga, gb, sa, duel) : 1);
    }

    // assists (40+ damage) and the Rating 3 swing split
    for (const k of list) {
      const j = pos.get(k)!;
      const vs = ctx.side(ri, k.victim);
      if (vs === null) continue;
      const byAttacker = new Map<number, number>();
      for (const r of dmgRows) {
        const a = d.attacker[r];
        if (d.victim[r] !== k.victim || a === null || d.tick[r] > k.tick || ctx.side(ri, a) === vs) continue;
        byAttacker.set(a, (byAttacker.get(a) ?? 0) + d.dmg[r]);
      }
      const helpers = [...byAttacker].filter(([a, dmg]) => a !== k.killer && dmg >= split.assistDmg);
      if (isEnemyKill(k)) for (const [a] of helpers) out[a].assists40++;
      const sw = valued ? swingByKill.get(j) : undefined;
      if (!sw) continue;
      const loss = vs === CT ? sw.before - sw.after : sw.after - sw.before; // drop in the victim side's chance
      out[k.victim].swing -= loss * (trades.tradeDeath[j] && !sameSide(k) ? 1 - split.tradedRelief : 1);
      const killer = isEnemyKill(k) ? k.killer : null;
      const flash = k.flashAssister !== null && ctx.side(ri, k.flashAssister) !== vs && k.flashAssister !== killer ? k.flashAssister : null;
      let rest = loss;
      if (flash !== null) { out[flash].swing += split.flash * loss; rest -= split.flash * loss; }
      if (killer !== null) { out[killer].swing += split.final * loss; rest -= split.final * loss; }
      const pool = new Map<number, number>(helpers);
      if (killer !== null) pool.set(killer, byAttacker.get(killer) ?? 0);
      const total = [...pool.values()].reduce((s, v) => s + v, 0);
      if (total > 0) for (const [a, dmg] of pool) out[a].swing += (rest * dmg) / total;
      else if (killer !== null) out[killer].swing += rest;
    }
  }
  return out;
}

// ---- the rating ------------------------------------------------------------------------------------

export interface R3Weights { kpr: number; adr: number; dpr: number; kast: number; mk: number; swing: number }

/**
 * Rating = intercept + Σ w·feature. Feature units: KPR, ADR, DPR per round; KAST and multi-kill in
 * percent (0–100); swing in percentage points per round (HLTV shows +2.5 %).
 */
export interface R3Params {
  calibrated: boolean;
  /** "eco": eco-adjusted KPR, ADR, DPR, KAST and multi-kill; "raw": unadjusted */
  features: "eco" | "raw";
  intercept: number;
  w: R3Weights;
  /** where the numbers came from, shown in tooltips */
  source: string;
}

/**
 * Uncalibrated default: Rating 2.0's public approximation (rating.ts) restated on these inputs. Its
 * Impact term is 2.13·KPR + 0.42·APR − 0.41; KPR folds into the KPR weight and APR is replaced by an
 * assumed average of 0.13 per round in the intercept. Multi-kill and swing get 0 until a fit gives
 * them weight. There is no evidence that these weights match Rating 3.0.
 */
export const DEFAULT_R3: R3Params = {
  calibrated: false,
  features: "eco",
  intercept: 0.1587 - 0.2372 * 0.41 + 0.2372 * 0.42 * 0.13,
  w: { kpr: 0.3591 + 0.2372 * 2.13, adr: 0.0032, dpr: -0.5329, kast: 0.0073, mk: 0, swing: 0 },
  source: "Uncalibrated: Rating 2.0 approximation weights; waiting for the HLTV fit",
};

/** The parameters in use: a fit written by model/fit_rating3.py, else the default. */
export const R3_PARAMS: R3Params = FITTED_R3 ?? DEFAULT_R3;

export type R3Features = R3Weights;

export function r3Features(x: R3Inputs, features: "eco" | "raw"): R3Features | null {
  if (x.rounds <= 0) return null;
  const eco = features === "eco";
  const n = x.rounds;
  return {
    kpr: (eco ? x.ecoKills : x.kills) / n,
    adr: (eco ? x.ecoDmg : x.dmg) / n,
    dpr: (eco ? x.ecoDeaths : x.deaths) / n,
    kast: (100 * (eco ? x.ecoKast : x.kastRounds)) / n,
    mk: (100 * (eco ? x.ecoMk : x.mkRounds)) / n,
    swing: x.swingRounds ? (100 * x.swing) / x.swingRounds : 0,
  };
}

export interface Rating3 {
  label: typeof RATING3_LABEL;
  value: number | null;
  calibrated: boolean;
  source: string;
  features: R3Features | null;
}

export function rating3(x: R3Inputs, p: R3Params = R3_PARAMS): Rating3 {
  const f = r3Features(x, p.features);
  const value = f === null ? null : Math.max(0, p.intercept + p.w.kpr * f.kpr + p.w.adr * f.adr + p.w.dpr * f.dpr + p.w.kast * f.kast + p.w.mk * f.mk + p.w.swing * f.swing);
  return { label: RATING3_LABEL, value, calibrated: p.calibrated, source: p.source, features: f };
}
