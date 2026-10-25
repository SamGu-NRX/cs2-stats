// The UI's only view of the stats engine. Every component reads match and profile numbers through
// these functions, so engine changes land here and the views do not change.
//
// Engine v2 (app/src/stats/README.md) supplies Rating 3.0 (approx., uncalibrated), per-round player
// data (roundDetails), the four-way economy (econ), roles and HLTV-named sub-stats. The engine
// does not split Rating 3.0 by side yet; data/sideRating.ts does it in the meantime.
import { scoreAttributes, type GroupScore } from "../../stats/attributes";
import { addCounters, emptyCounters, type Counters } from "../../stats/counters";
import type { KillView, MatchView, PlayerRow, RoundView } from "../../stats/derive";
import { BUY_CLASSES, type BuyClass } from "../../stats/economy";
import { SUBSTAT_BY_ID, type SubStat, type SubStatStatus } from "../../stats/hltv";
import { formatMetric, METRICS } from "../../stats/metrics";
import type { ProfileView } from "../../stats/profile";
import { rating2, type RatingInputs } from "../../stats/rating";
import { rating3, type R3Inputs } from "../../stats/rating3";
import type { SideInputs } from "./sideRating";
import { deriveRole, type Role } from "../../stats/role";
import type { KillEvent, PlayerRound, RoundDetail } from "../../stats/rounds";
import { CT, T, type Side } from "../../stats/schema";
import type { LightSummary } from "../../worker/protocol";
import { ATTRIBUTE_ORDER, type AttributeId } from "./proPack";

// ---------------------------------------------------------------- rating
// One rating everywhere: Rating 3.0 (approx.), pooled over rounds. The six inputs are summed over
// every round with the kill log before the formula is applied, as HLTV does for careers, so a
// profile's rating is not the mean of its match ratings. Rating 2.0 appears only in tooltips
// (design/architecture.md, "Rating labels across the migration").

export const RATING_LABEL = "Rating 3.0";
export const RATING_HEADLINE = "Rating 3.0 (approx.)";
export const RATING3_NOTE = "Rating 3.0 (approx.) is uncalibrated: it restates Rating 2.0's weights on HLTV 3.0's inputs until it is fitted to HLTV ratings.";
export const RATING_POOLED = "Pooled over rounds: kills, damage, deaths, KAST, multi-kills and swing are summed over every round with the kill log, then the formula runs once, as HLTV does for careers.";

/**
 * Rating 3.0 counts only rounds with the kill log. A converted match whose first 15 of 16 rounds
 * hold totals only would get a rating from one round, so below half coverage there is no rating.
 */
export const R3_MIN_COVERAGE = 0.5;
const covered = (logRounds: number, rounds: number) => logRounds > 0 && logRounds >= R3_MIN_COVERAGE * rounds;
export const r3Usable = (c: Counters) => covered(c.r3.rounds, c.rounds);
export const NO_RATING_TIP = "No Rating 3.0: fewer than half of this match's rounds have the kill-by-kill log.";

export const playerRating = (p: PlayerRow): number | null => (r3Usable(p.c) ? p.rating3.value : null);
/** Pooled Rating 3.0 over any counters total (the inputs are additive). */
export const countersRating = (c: Counters): number | null => (r3Usable(c) ? rating3(c.r3).value : null);
export const countersRating3 = (c: Counters) => rating3(c.r3);
export const summaryRating = (s: LightSummary): number | null => (r3Usable(s.human.c) ? s.human.rating3 : null);
/** Rating 2.0 for any additive slice, for tooltips only. */
export const sliceRating = (x: RatingInputs) => rating2(x);
/** Rating 3.0 from one side's inputs (data/sideRating.ts), under the same coverage rule: `rounds`
 *  is every round played on that side, with or without the kill log. */
export const r3Value = (x: R3Inputs | null | undefined, rounds: number) => (x && covered(x.rounds, rounds) ? rating3(x).value : null);

export const ratingLabel = (_v?: unknown) => RATING_LABEL;

// ---------------------------------------------------------------- sides

export type SideKey = "both" | "t" | "ct";
export const SIDE_OPTIONS: { value: SideKey; label: string }[] = [
  { value: "both", label: "Both" }, { value: "t", label: "T" }, { value: "ct", label: "CT" },
];
export const sideOfKey = (k: SideKey): Side | null => (k === "t" ? T : k === "ct" ? CT : null);

/** The side a player was on in a round, from their team and the round's side for "us". */
export function playerSide(v: MatchView, r: RoundView, pi: number): Side {
  return v.players[pi].team === "us" ? r.usSide : ((5 - r.usSide) as Side);
}

export interface StatLine {
  rounds: number;
  kills: number;
  deaths: number;
  assists: number;
  diff: number;
  adr: number | null;
  kast: number | null;
  hs: number | null;
  kpr: number | null;
  dpr: number | null;
  /** average swing per round, a fraction */
  swing: number | null;
  /** Rating 3.0; null without enough kill-log rounds, or for one side until its inputs load */
  rating: number | null;
  /** Rating 2.0 over the same rounds, for tooltips */
  rating2: number | null;
}

const per = (a: number, b: number) => (b > 0 ? a / b : null);

/**
 * A player's line for one side or both. Both sides read the engine's counters. One side sums the
 * per-round details (HS, swing); its Rating 3.0 comes from the side inputs when given.
 */
export function statLine(v: MatchView, pi: number, side: SideKey, sides?: SideInputs[] | null): StatLine {
  const p = v.players[pi];
  const c = p.c;
  if (side === "both") {
    return {
      rounds: c.rounds, kills: c.kills, deaths: c.deaths, assists: c.assists, diff: c.kills - c.deaths,
      adr: per(c.dmg, c.rounds), kast: c.rounds ? (100 * c.kastRounds) / c.rounds : null,
      hs: c.kills ? (100 * c.hsKills) / c.kills : null, kpr: per(c.kills, c.rounds), dpr: per(c.deaths, c.rounds),
      swing: p.swingPerRound, rating: playerRating(p), rating2: c.rounds ? p.rating : null,
    };
  }
  const want = sideOfKey(side);
  const sl: RatingInputs = side === "t" ? c.sideT : c.sideCT;
  let hs = 0;
  let swing = 0;
  let swingRounds = 0;
  for (const r of v.roundDetails) {
    const pr = r.players[pi];
    if (!pr || pr.side !== want) continue;
    hs += pr.hsKills;
    if (pr.swing !== null) { swing += pr.swing; swingRounds++; }
  }
  const r2 = sl.rounds ? sliceRating(sl) : null;
  return {
    rounds: sl.rounds, kills: sl.kills, deaths: sl.deaths, assists: sl.assists, diff: sl.kills - sl.deaths,
    adr: per(sl.dmg, sl.rounds), kast: sl.rounds ? (100 * sl.kastRounds) / sl.rounds : null,
    hs: sl.kills ? (100 * hs) / sl.kills : null, kpr: per(sl.kills, sl.rounds), dpr: per(sl.deaths, sl.rounds),
    swing: swingRounds ? swing / swingRounds : null, rating: sides ? r3Value(sides[pi][side], sl.rounds) : null, rating2: r2,
  };
}

/** The same line from profile or summary counters. One side has no HS% or swing (not split); its
 *  Rating 3.0 needs the side's inputs. */
export function counterLine(c: Counters, side: SideKey, sideR3?: R3Inputs | null): StatLine {
  const sl: RatingInputs = side === "both" ? c : side === "t" ? c.sideT : c.sideCT;
  const both = side === "both";
  const r2 = sl.rounds ? sliceRating(sl) : null;
  return {
    rounds: sl.rounds, kills: sl.kills, deaths: sl.deaths, assists: sl.assists, diff: sl.kills - sl.deaths,
    adr: per(sl.dmg, sl.rounds), kast: sl.rounds ? (100 * sl.kastRounds) / sl.rounds : null,
    hs: both && c.kills ? (100 * c.hsKills) / c.kills : null,
    kpr: per(sl.kills, sl.rounds), dpr: per(sl.deaths, sl.rounds),
    swing: both && c.swingRounds ? c.swing / c.swingRounds : null,
    rating: both ? countersRating(c) : r3Value(sideR3, sl.rounds), rating2: r2,
  };
}

/** Multi-kill rounds as a percent of rounds (both sides; not split by side). */
export const multiKillPct = (c: Counters) => (c.rounds ? (100 * c.multiKillRounds) / c.rounds : null);

// ---------------------------------------------------------------- rounds × players

export interface CellKill { victim: number | null; weapon: string; hs: boolean; secs: number | null; trade: boolean; opening: boolean; event: KillEvent | null }
export interface RoundCell {
  ri: number;
  side: Side;
  kills: CellKill[];
  died: boolean;
  death: KillEvent | null;
  dmg: number;
  swing: number | null;
  /** only the game's round totals exist (no victims or weapons) */
  lite: boolean;
  /** no stats for this player this round */
  empty: boolean;
  clutch: PlayerRound["clutch"];
  pr: PlayerRound | null;
}

/** The round inspector's matrix, [pi][ri], from the engine's per-round details. */
export function roundMatrix(v: MatchView): RoundCell[][] {
  return v.players.map((p, pi) => v.roundDetails.map((r) => {
    const pr = r.players[pi];
    const side: Side = pr?.side ?? (p.team === "us" ? r.usSide : ((5 - r.usSide) as Side));
    if (!pr) return { ri: r.ri, side, kills: [], died: false, death: null, dmg: 0, swing: null, lite: r.lite, empty: true, clutch: null, pr: null };
    const kills: CellKill[] = pr.kills.length
      ? pr.kills.map((k) => ({ victim: k.victim, weapon: k.weapon, hs: k.headshot, secs: k.secs, trade: k.tradeKill, opening: k.opening, event: k }))
      : Array.from({ length: pr.k }, (_, i) => ({ victim: null, weapon: "", hs: i < pr.hsKills, secs: null, trade: false, opening: false, event: null }));
    return {
      ri: r.ri, side, kills, died: pr.d > 0, death: pr.death, dmg: pr.dmg, swing: pr.swing,
      lite: !r.captured, empty: !r.captured && !r.lite, clutch: pr.clutch, pr,
    };
  }));
}

/** Rounds with 2, 3, 4 and 5+ kills for one player in a match, from the per-round details. */
export function multiKillCounts(v: MatchView, pi: number): Record<2 | 3 | 4 | 5, number> {
  const out = { 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of v.roundDetails) { const k = r.players[pi]?.k ?? 0; if (k >= 2) out[Math.min(5, k) as 2 | 3 | 4 | 5]++; }
  return out;
}

/** Swing summed over the match per player (fraction points), null without any swing rounds. */
export function matchSwingTotal(v: MatchView, pi: number): number | null {
  let s = 0;
  let n = 0;
  for (const r of v.roundDetails) { const x = r.players[pi]?.swing; if (x !== null && x !== undefined) { s += x; n++; } }
  return n ? s : null;
}

/** A kill's swing for its killer: the kill's win-probability change from the round's path. */
export function killSwingOf(r: RoundDetail, k: KillEvent, killerTeamIsUs: boolean, usSide: Side): number | null {
  const pt = r.winProb?.find((p) => p.event === "kill" && p.k === k.k);
  if (!pt || pt.before === null) return null;
  const dCT = pt.pCT - pt.before;
  const killerSide = killerTeamIsUs ? usSide : ((5 - usSide) as Side);
  return killerSide === CT ? dCT : -dCT;
}

/** Swing a kill credited to one player (the killer's share, split by damage), null without swing. */
export function killSwing(k: KillView, pi: number | null): number | null {
  if (pi === null || k.ctWinBefore === null) return null;
  return k.credits.find(([p]) => p === pi)?.[1] ?? 0;
}

/** The round where a player's swing was highest, with their kills that round. */
export function bestRound(v: MatchView, pi: number): { ri: number; swing: number | null; kills: number; hs: number } | null {
  let best: { ri: number; swing: number | null; kills: number; hs: number } | null = null;
  const score = (x: { swing: number | null; kills: number }) => (x.swing ?? 0) * 100 + x.kills * 0.01;
  for (const r of v.roundDetails) {
    const pr = r.players[pi];
    if (!pr || !r.captured) continue;
    const cand = { ri: r.ri, swing: pr.swing, kills: pr.k, hs: pr.hsKills };
    if (!best || score(cand) > score(best)) best = cand;
  }
  return best;
}

export const BUY_CLASS_LABEL: Record<BuyClass, string> = { pistol: "Pistol", eco: "Eco", force: "Force buy", full: "Full buy" };
export { BUY_CLASSES };

// ---------------------------------------------------------------- attributes and roles

/** HLTV's names. The engine calls the closing group "clutching". */
const GROUP_TO_ATTR: Record<string, AttributeId> = {
  firepower: "firepower", entrying: "entrying", trading: "trading", opening: "opening",
  clutching: "closing", sniping: "sniping", utility: "utility",
};
export const ATTR_LABEL: Record<AttributeId, string> = {
  firepower: "Firepower", entrying: "Entrying", trading: "Trading", opening: "Opening",
  closing: "Closing", sniping: "Sniping", utility: "Utility",
};
export const ATTR_DEF: Record<AttributeId, string> = {
  firepower: "Kills and damage per round, multi-kills and rating.",
  entrying: "Taking first contact for the team: deaths that get traded, being saved, support rounds.",
  trading: "Punishing enemies who just got a kill, and saving teammates under fire.",
  opening: "Winning the first duel of the round, and how often you take it.",
  closing: "Late-round play: clutches, last alive, time alive and saves.",
  sniping: "Kills, rounds and opening kills with sniper rifles.",
  utility: "Grenade damage, flashes thrown, flash assists and enemy blind time.",
};

/** HLTV-named sub-stats shown under each attribute beyond the scored ones (value only, no score). */
const EXTRA_SUBS: Record<AttributeId, string[]> = {
  firepower: ["rws", "perfectKills", "tradeDenials", "multiKill", "ecoKpr"],
  entrying: ["tradeableDeaths", "baitAssists", "failedTrades"],
  trading: ["tradeOpps", "tradeOppsTaken", "baitKills"],
  opening: ["firstDuelRank", "firstDuelTime", "weaponAttacks"],
  closing: ["clutchesPer24"],
  sniping: [],
  utility: ["utilSuccess"],
};

export interface Sub { id: string; label: string; def: string; value: number | null; text: string; score: number | null; status: SubStatStatus | null }
export interface Attr { id: AttributeId; label: string; score: number | null; subs: Sub[]; extra: Sub[] }

const subFmt = (s: SubStat, v: number | null) => {
  if (v === null || !Number.isFinite(v)) return "–";
  switch (s.fmt) {
    case "dec2": return v.toFixed(2);
    case "dec1": return v.toFixed(1);
    case "pct": return `${v.toFixed(1)}%`;
    case "secs": return `${v.toFixed(1)} s`;
    case "int0": return String(Math.round(v));
  }
};

export function attributes(groups: GroupScore[], total?: Counters): Attr[] {
  const byId = new Map(groups.map((g) => [GROUP_TO_ATTR[g.id], g]));
  return ATTRIBUTE_ORDER.map((id) => {
    const g = byId.get(id);
    return {
      id, label: ATTR_LABEL[id], score: g?.score ?? null,
      subs: (g?.subs ?? []).map((s) => {
        const m = METRICS[s.id];
        const hl = SUBSTAT_BY_ID[s.id];
        return { id: s.id, label: hl?.name ?? m?.label ?? s.id, def: hl?.def ?? m?.def ?? "", value: s.value, text: m ? formatMetric(m, s.value) : String(s.value ?? "–"), score: s.score, status: hl?.status ?? null };
      }),
      extra: total ? EXTRA_SUBS[id].map((sid) => SUBSTAT_BY_ID[sid]).filter(Boolean).map((s) => {
        const value = s.value(total);
        return { id: s.id, label: s.name, def: s.def, value, text: subFmt(s, value), score: null, status: s.status };
      }) : [],
    };
  });
}

export const attrVector = (a: Attr[]) => a.map((x) => x.score);

/** The two weakest scored attributes, with their weakest sub-stat. */
export function weakest(a: Attr[], n = 2) {
  return a.filter((x) => x.score !== null).sort((x, y) => x.score! - y.score!).slice(0, n).map((x) => ({
    ...x, worst: [...x.subs].filter((s) => s.score !== null).sort((p, q) => p.score! - q.score!)[0] ?? null,
  }));
}

/** The engine's role for any counters total. */
export const roleFor = (c: Counters): Role => deriveRole(c);

/**
 * Role signals as a blend: each flavour's evidence as a share of its threshold, normalised to 100 %.
 * Flavours without data (positions are plugin-only) are listed as missing, not as zero.
 */
export function roleBlend(r: Role): { label: string; share: number | null; score: number | null; value: number | null; threshold: number }[] {
  const scored = r.flavours.filter((f) => f.score !== null);
  const total = scored.reduce((a, f) => a + Math.max(0, f.score!), 0);
  return r.flavours.map((f) => ({ label: f.flavour, share: f.score === null || !total ? null : Math.max(0, f.score) / total, score: f.score, value: f.value, threshold: f.threshold }));
}

// ---------------------------------------------------------------- profile helpers

/** Sum of every bot career in the given matches: ratios over it are bot averages. */
export function botAverage(summaries: LightSummary[]): Counters | null {
  if (!summaries.some((s) => s.bots.length)) return null;
  const c = emptyCounters();
  for (const s of summaries) for (const b of s.bots) addCounters(c, b.c);
  return c;
}

/** Attributes for any counters total, scored against the bot careers in the same matches. */
export function attributesFor(total: Counters, summaries: LightSummary[]): Attr[] {
  const careers = new Map<string, Counters>();
  for (const s of summaries) for (const b of s.bots) {
    let c = careers.get(b.key);
    if (!c) careers.set(b.key, (c = emptyCounters()));
    addCounters(c, b.c);
  }
  return attributes(scoreAttributes(total, [...careers.values()]).groups, total);
}

export const profileAttributes = (p: ProfileView) => attributes(p.attributes.groups, p.total);

/** Clutches 1v1..1v5 from counters. */
export const clutchRows = (c: Counters) => c.clutchN.map((n, i) => ({ vs: i + 1, played: n, won: c.clutchW[i] }));

/** Rounds with 2, 3, 4 and 5 kills. */
export const multiKillRows = (c: Counters) => [2, 3, 4, 5].map((k) => ({ k, rounds: c.kc[k] ?? 0 }));

export const WEAPON_CLASS_LABEL: Record<string, string> = {
  rifle: "Rifles", sniper: "Snipers", smg: "SMGs", heavy: "Heavy", pistol: "Pistols", grenade: "Grenades", knife: "Knife", other: "Other",
};

/** Matches in the filter, newest first. */
export function filterSummaries(all: LightSummary[], map: string | null): LightSummary[] {
  return map ? all.filter((s) => s.map === map) : all;
}

/** Maps present in the data, most played first. */
export function mapsIn(all: LightSummary[]): string[] {
  const n = new Map<string, number>();
  for (const s of all) n.set(s.map, (n.get(s.map) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}
