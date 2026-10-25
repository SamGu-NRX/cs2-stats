// The UI's view of the stats engine: labels, the side switch, stat lines read off the worker's
// lines, the attribute adapter, number formats by metric unit, and the rating coverage rule. Nothing
// here defines a metric, and nothing here loads the engine: the numbers arrive from the worker and
// the descriptions from data/meta.ts.
import { coveredEnough } from "../../stats/coverage";
import { BUY_CLASSES, type BuyClass } from "../../stats/economy";
import type { AttributeScore } from "../../stats/compare";
import type { Measures } from "../../stats/facts";
import type { Kind, Status } from "../../stats/metrics";
import type { Side } from "../../stats/tables";
import type { Careers, Line, Values } from "../../worker/protocol";
import { fmtAdr, fmtDec, fmtDeg, fmtInt, fmtMoney, fmtMs, fmtPct, fmtRating, fmtSecs } from "../lib/format";
import type { MatchEntry } from "./match";
import { metric, ratingInfo, winProbInfo } from "./meta";
import type { AttributeId } from "./proPack";

// ---------------------------------------------------------------- rating

export const RATING_LABEL = "Rating 3.0";
/** The engine's own label for the rating, "Rating 3.0 (approx.)". */
export const ratingHeadline = () => ratingInfo().label;
/** Where round win probability (and so swing) comes from, as Settings states it. */
export const winProbText = () => {
  const w = winProbInfo();
  return w.kind === "hltv"
    ? `${w.label}, from packs/winprob-hltv.json; it drives round swing.`
    : `${w.label}. Install packs/winprob-hltv.json for HLTV's lookup; it drives round swing.`;
};
export const rating3Note = () => {
  const r = ratingInfo();
  return `Rating 3.0 (approx.): HLTV Rating 3.02 as reconstructed in model/rating3 (${r.status}).`;
};
export const RATING_POOLED = "Rated per side over the rounds it can value; a side with under half its rounds valued is left out. The total averages the side ratings, weighted by those rounds.";

/**
 * A match whose kill-by-kill log covers under half its rounds (a converted log that holds the first
 * rounds as totals only) gets no rating of its own, on either side: the rating of its few covered
 * rounds is not the match's rating. Such a match is also left out of career views (careerEntries).
 */
export const NO_RATING_TIP = "No Rating 3.0: fewer than half of this match's rounds have the kill-by-kill log, so it is left out of career views.";
export const ratedMatch = coveredEnough;
/** A match entry's own rating, null under the coverage rule. */
export const entryRating = (e: MatchEntry) => e.line.rating;

/** Rating 3.0's six inputs, as the breakdown card lists them. */
export const R3_INPUT_LABEL: Record<string, { label: string; fmt: (v: number) => string }> = {
  kpr_eco: { label: "Eco-adjusted kills per round", fmt: (v) => v.toFixed(2) },
  adr_eco: { label: "Eco-adjusted damage per round", fmt: (v) => v.toFixed(1) },
  dpr_eco: { label: "Eco-adjusted deaths per round", fmt: (v) => v.toFixed(2) },
  kast_eco: { label: "Eco-adjusted KAST", fmt: (v) => `${v.toFixed(1)}%` },
  mk: { label: "Multi-kill rounds", fmt: (v) => `${v.toFixed(1)}%` },
  swing: { label: "Round swing", fmt: (v) => `${v.toFixed(2)}%` },
};

// ---------------------------------------------------------------- sides

export type SideKey = "both" | "t" | "ct";
export const SIDE_OPTIONS: { value: SideKey; label: string }[] = [
  { value: "both", label: "Both" }, { value: "t", label: "T" }, { value: "ct", label: "CT" },
];
export const sideOfKey = (k: SideKey): Side | null => (k === "t" ? "T" : k === "ct" ? "CT" : null);
/** The engine's side filter for a side key; both sides is no filter. */
export const sidesOf = (k: SideKey): { sides?: Side[] } => (k === "both" ? {} : { sides: [sideOfKey(k)!] });
/** The key rating3BySide and compare use. */
export const ratingKey = (k: SideKey) => (k === "both" ? "both" : sideOfKey(k)!);

// ---------------------------------------------------------------- stat lines

export interface StatLine {
  m: Measures;
  v: Values;
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
  /** multi-kill rounds, percent */
  mk: number | null;
  /** round swing as a win-probability fraction, the unit fmtSwing takes (the swing metric is in percent) */
  swing: number | null;
  rating: number | null;
}

export function lineOf(l: Pick<Line, "m" | "v">, rating: number | null): StatLine {
  const { m, v } = l;
  return {
    m, v, rounds: m.rounds, kills: m.kills, deaths: m.deaths, assists: m.assists, diff: m.kills - m.deaths,
    adr: v.adr, kast: v.kast, hs: v.hs, kpr: v.kpr, dpr: v.dpr, mk: v.mk,
    swing: v.swing === null ? null : v.swing / 100, rating,
  };
}

/** A worker line (its rating already under the coverage rule) as a stat line. */
export const statLine = (l: Line) => lineOf(l, l.rating);

/** A match entry's line for the recording player, both sides. */
export const entryLine = (e: MatchEntry) => statLine(e.line);

// ---------------------------------------------------------------- counts read off the measures

/** Rounds with exactly 2, 3 and 4 kills, and with 5, from the engine's 2+, 3+, 4+ and 5 counts. */
export const multiKillRows = (m: Measures) => [
  { k: 2 as const, rounds: m.multiKillRounds - m.k3Rounds },
  { k: 3 as const, rounds: m.k3Rounds - m.k4Rounds },
  { k: 4 as const, rounds: m.k4Rounds - m.k5Rounds },
  { k: 5 as const, rounds: m.k5Rounds },
];

/** 1v1 to 1v5 clutches played and won. */
export const clutchRows = (m: Measures) => ([1, 2, 3, 4, 5] as const).map((vs) => ({ vs, played: m[`clutch${vs}`], won: m[`clutchWon${vs}`] }));

export const BUY_CLASS_LABEL: Record<BuyClass, string> = { pistol: "Pistol", eco: "Eco", half: "Half buy", full: "Full buy" };
export { BUY_CLASSES };

// ---------------------------------------------------------------- formats

/** A metric's value in its unit's format. */
export function fmtMetric(id: string, v: number | null): string {
  switch (metric(id).unit) {
    case "rating": return fmtRating(v);
    case "pct": return fmtPct(v);
    case "secs": return fmtSecs(v);
    case "ms": return fmtMs(v);
    case "deg": return fmtDeg(v, 2);
    case "money": return fmtMoney(v);
    case "dmg": return fmtAdr(v);
    case "units": case "speed": return fmtInt(v);
    case "perRound": case "count": case "rank": return fmtDec(v);
  }
}

/** Where a percentile sits, for performance metrics (higher is always better after compare()). */
export const rankText = (pct: number | null) => (pct === null ? "–" : pct >= 50 ? `Top ${Math.max(1, Math.round(100 - pct))}%` : `Bottom ${Math.max(1, Math.round(pct))}%`);

// ---------------------------------------------------------------- attributes

export interface Sub {
  id: string; label: string; def: string; value: number | null; text: string; score: number | null; status: Status;
  /** why the value has no percentile (compare.ts Percentile.reason); null when it has one or has no value */
  reason: string | null;
}
export interface Attr { id: AttributeId; label: string; kind: Kind; score: number | null; subs: Sub[] }

/** The engine's attribute scores (percentiles in the pool the worker ranked them against) with each metric's label and format. */
export const attrsOf = (scores: AttributeScore[]): Attr[] => scores.map((a) => ({
  id: a.id as AttributeId, label: a.label, kind: a.kind, score: a.score,
  subs: a.metrics.map((p) => {
    const m = metric(p.id);
    return { id: p.id, label: m.label, def: m.def, value: p.value, text: fmtMetric(p.id, p.value), score: p.pct, status: m.status, reason: p.reason };
  }),
}));

export const WEAPON_CLASS_LABEL: Record<string, string> = {
  rifle: "Rifles", sniper: "Snipers", smg: "SMGs", heavy: "Heavy", pistol: "Pistols", grenade: "Grenades", knife: "Knife", other: "Other",
};

// ---------------------------------------------------------------- populations
// Performance ranks against the pros, the user's style against the bot careers in their own matches
// (design/identity.md, worker/ranking.ts). Every percentile on screen names one of the two.

/** A pro pool's name and size, for a card's aside. */
export const poolText = (role: "awper" | "rifler" | "all", n: number) => `Percentile against ${n} ${role === "all" ? "pros" : role === "awper" ? "pro AWPers" : "pro riflers"}`;

/** A bot career pool's name and size. */
export const botPoolText = (role: "awper" | "rifler" | "all", n: number) =>
  `Percentile against ${n} ${role === "all" ? "" : role === "awper" ? "AWPer " : "rifler "}bot ${n === 1 ? "career" : "careers"}`;

/** The sentence behind the "Provisional" chip the style scores carry until enough bot careers qualify. */
export const provisionalText = (c: Careers) => (c.unit === "matches"
  ? `Provisional: against ${c.botMatches} bot ${c.botMatches === 1 ? "match" : "matches"}; career scores need ${c.minPool} bot careers with ${c.minRounds}+ rounds`
  : `Provisional: ${c.qualified} of ${c.needed} bot careers with ${c.minRounds}+ rounds`);

export const BOTS_TIP = "Style is ranked against the bots in your own matches: each bot name is one career, summed over the same matches as you. Pros are ranked against pros.";

/** Why a style pool shows no scores (the detail behind "Needs a recorded demo"): fewer samples in it than the engine needs to write its quantiles. */
export const thinPoolText = (c: Careers, n: number) => (c.unit === "matches"
  ? `This pool has ${n} bot ${n === 1 ? "match" : "matches"}, and a style score needs ${c.minPool}.`
  : `This pool has ${n} bot ${n === 1 ? "career" : "careers"} with ${c.minRounds}+ rounds, and a style score needs ${c.minPool}.`);

// ---------------------------------------------------------------- lists

/** Matches in the filter, newest first. */
export function filterEntries(all: MatchEntry[], map: string | null): MatchEntry[] {
  return map ? all.filter((s) => s.match.map === map) : all;
}

/**
 * The one match set every career number reads (the sidebar, Home, Profile, Playstyle, Career aim and
 * Weapons): finished matches whose kill-by-kill log covers at least half their rounds. An unfinished
 * match or a partial converted log neither appears in a career list nor moves an average, so the
 * sidebar, the Rating 3.0 tile and Form's pooled line agree. The Matches list shows every match and
 * labels the others.
 */
export const careerEntries = (all: MatchEntry[], map: string | null) => filterEntries(all, map).filter((s) => s.match.complete && ratedMatch(s.match) && !isWingman(s));

/**
 * A wingman match: a 16-round limit (MR8) with at most two players a side, as Valve's wingman demos are.
 * The rating and win-probability models and the pro baselines are all 5v5, so career views leave it out.
 */
export const isWingman = (s: MatchEntry) => s.match.maxRounds === 16 && ([0, 1] as const).every((t) => s.players.filter((p) => p.team === t).length <= 2);

export const WINGMAN_TIP = "Wingman (2v2): left out of career views (Home, Profile, Playstyle, Career aim, Weapons), whose models and baselines are 5v5.";

/** What Matches lists: every match in the filter except unfinished ones and those with no round won (0–0). */
export const listedEntries = (all: MatchEntry[], map: string | null) => filterEntries(all, map).filter((s) => s.match.complete && s.score.us + s.score.them > 0);

/** Maps present in the data, most played first. */
export function mapsIn(all: MatchEntry[]): string[] {
  const n = new Map<string, number>();
  for (const s of all) n.set(s.match.map, (n.get(s.match.map) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** Bots in a list of matches, by steamid: the "bots you played" comparison. */
export const botIds = (list: MatchEntry[]) => [...new Set(list.flatMap((e) => e.players.filter((p) => p.bot).map((p) => p.id)))];
