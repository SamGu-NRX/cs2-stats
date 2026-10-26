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
import { sourceOf } from "./sources";
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
    ? `${w.label}, from winprob-hltv.json in the packs folder. It values each round's swing.`
    : `${w.label}. It values each round's swing; add winprob-hltv.json to the packs folder to use HLTV's table instead.`;
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

/** "1 of 16 rounds logged": how much of a match the kill-by-kill log covers. */
export const loggedText = (m: { nRounds: number; roundsPlayed: number }) => `${m.nRounds} of ${m.roundsPlayed} rounds logged`;

/**
 * The coverage rule, applied once where the match list arrives (data/provider.tsx), so every view
 * reads it: a match whose kill-by-kill log covers under half its rounds keeps its counts (the logged
 * rounds' kills and deaths) but none of its per-round values (ADR, KAST, HS%, swing, rating, the eco
 * scoreboard). Those values describe the few logged rounds, not the match, and would read as the
 * match's result in Matches, the Home hero and the match header.
 */
export function coverEntry(e: MatchEntry): MatchEntry {
  if (ratedMatch(e.match)) return e;
  const v: Values = {};
  for (const k of Object.keys(e.line.v)) v[k] = null;
  return { ...e, line: { ...e.line, v, eco: null, rating: null } };
}
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

/** One term of Rating 3.0 for a breakdown: the input's value, its coefficient, and coefficient × value. */
export interface RatingTerm { label: string; input: string; coefficient: number; contribution: number }

/**
 * Rating 3.0's terms over a rating's own inputs (Rating3.inputs from rating3Of), in params.json's
 * order, then the constant: the intercept plus every contribution is the rating's value.
 */
export function ratingTerms(inputs: Record<string, number>): { terms: RatingTerm[]; intercept: number } {
  const r = ratingInfo();
  return {
    terms: r.terms.map((t) => {
      const l = R3_INPUT_LABEL[t.input];
      if (!l || inputs[t.input] === undefined) throw new Error(`Rating 3.0 term ${t.name} reads input "${t.input}", which the breakdown does not have`);
      return { label: l.label, input: l.fmt(inputs[t.input]), coefficient: t.coefficient, contribution: t.coefficient * inputs[t.input] };
    }),
    intercept: r.intercept,
  };
}

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

/**
 * Rounds with exactly 2, 3 and 4 kills, and with 5, from the engine's 2+, 3+, 4+ and 5 counts, each
 * with its percent of all rounds (null without rounds).
 */
export const multiKillRows = (m: Measures) => ([
  { k: 2 as const, rounds: m.multiKillRounds - m.k3Rounds },
  { k: 3 as const, rounds: m.k3Rounds - m.k4Rounds },
  { k: 4 as const, rounds: m.k4Rounds - m.k5Rounds },
  { k: 5 as const, rounds: m.k5Rounds },
]).map((r) => ({ ...r, pct: m.rounds ? (100 * r.rounds) / m.rounds : null }));

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

/**
 * Metrics shown under an attribute after its scored ones, value only (main's unscored rows). Main's
 * other extras (RWS, trade denials, multi-kill, tradeable deaths, bait assists, trade opportunities,
 * first duel rank and time, weapon attacks, clutches per 24) are scored metrics of the same attribute
 * here, so they already show. Main's "Trade success" is tradeKillSuccess.
 */
export const EXTRA_SUBS: Partial<Record<AttributeId, string[]>> = {
  firepower: ["perfectKillsPct", "ecoKpr"],
  entrying: ["failedTradesPR"],
  trading: ["tradeKillSuccess", "baitKillsPR"],
};

/** An attribute's extra rows over the same rounds as its scores (the caller's metric values on that side). */
export const extraSubs = (id: AttributeId, v: Values): Sub[] => (EXTRA_SUBS[id] ?? []).map((mid) => {
  const m = metric(mid);
  return { id: mid, label: m.label, def: m.def, value: v[mid], text: fmtMetric(mid, v[mid]), score: null, status: m.status, reason: null };
});

/** A role signal's bar (main's role card): filled to twice the threshold, and whether the value reaches it. */
export const signalBar = (value: number, threshold: number) => ({ fill: Math.max(0, Math.min(1, value / (2 * threshold))), fits: value >= threshold });

export const WEAPON_CLASS_LABEL: Record<string, string> = {
  rifle: "Rifles", sniper: "Snipers", smg: "SMGs", heavy: "Heavy", pistol: "Pistols", grenade: "Grenades", knife: "Knife", other: "Other",
};

// ---------------------------------------------------------------- populations
// Performance ranks against the pros, the user's style against the bot careers in their own matches
// (design/identity.md, worker/ranking.ts). Every percentile on screen names one of the two.

/** The words a percentile phrase names its population with: "pro riflers", "pros". */
export const proPoolName = (role: "awper" | "rifler" | "all") => (role === "all" ? "pros" : role === "awper" ? "pro AWPers" : "pro riflers");
/**
 * The population a pro percentile was read in, from its pool (compare.ts Percentile.pool): the role
 * pools, everyone ("all": sniping metrics always compare with every pro), or one map's player-maps.
 */
export const proPopulation = (pool: string) => (pool === "awper" ? "pro AWPers" : pool === "rifler" ? "pro riflers" : pool.startsWith("map:") ? "pros on this map" : "pros");
/** The same for the bot pools the user's style ranks against: "rifler bots", "all bots". */
export const botPoolName = (role: "awper" | "rifler" | "all") => (role === "all" ? "all bots" : role === "awper" ? "AWPer bots" : "rifler bots");


/**
 * The bot population the user's style ranks against, as one count with one noun. Every place that
 * names the population (the attributes panel, the provisional chip, a card aside) reads it here, so a
 * screen never says "63 bot matches" in one spot and "62 bot careers" in the next.
 *
 * - The noun follows what one sample is (Careers.unit): a bot career, or one bot in one match while
 *   too few careers qualify.
 * - The count is the pool the scores read when the caller has it (StyleResult.n with its role), else
 *   the whole population: every bot match, or every qualifying career.
 *
 *   const pop = botPopulation(style.careers, { n: style.n, role: cmp === "all" ? "all" : style.role });
 *   pop.text  // "62 rifler bot matches"
 */
export interface BotPool { n: number; role: "awper" | "rifler" | "all" }
export interface BotPopulation { count: number; noun: string; text: string }
export function botPopulation(c: Careers, pool?: BotPool): BotPopulation {
  const count = pool ? pool.n : c.unit === "matches" ? c.botMatches : c.qualified;
  const role = !pool || pool.role === "all" ? "" : pool.role === "awper" ? "AWPer " : "rifler ";
  const noun = c.unit === "matches" ? (count === 1 ? "bot match" : "bot matches") : count === 1 ? "bot career" : "bot careers";
  return { count, noun, text: `${count} ${role}${noun}` };
}

/** A bot pool's name and size, for a card's aside: "Percentile against 62 rifler bot matches". */
export const botPoolText = (c: Careers, pool?: BotPool) => `Percentile against ${botPopulation(c, pool).text}`;

/** The sentence behind the "Provisional" chip the style scores carry until enough bot careers qualify. */
export const provisionalText = (c: Careers, pool?: BotPool) => (c.unit === "matches"
  ? `Provisional: against ${botPopulation(c, pool).text}; career scores need ${c.minPool} bot careers with ${c.minRounds}+ rounds`
  : `Provisional: ${c.qualified} of ${c.needed} bot careers with ${c.minRounds}+ rounds`);

export const BOTS_TIP = "Style is ranked against the bots in your own matches: each bot name is one career, summed over the same matches as you. Pros are ranked against pros.";

/** Why a style pool shows no scores (the detail behind "Needs a recorded demo"): fewer samples in it than the engine needs to write its quantiles. */
export const thinPoolText = (c: Careers, n: number) => `This pool has ${botPopulation(c, { n, role: "all" }).text}${c.unit === "careers" ? ` with ${c.minRounds}+ rounds` : ""}, and a style score needs ${c.minPool}.`;

// ---------------------------------------------------------------- lists

/** Matches in the filter, newest first. */
export function filterEntries(all: MatchEntry[], map: string | null): MatchEntry[] {
  return map ? all.filter((s) => s.match.map === map) : all;
}

// Which matches count. Matches lists every match; each rule below is shared by every view.

/** The user's own match: anything but a pro demo (data/sources.ts). Pro demos open from Matches, labelled, and count nowhere. */
export const isOwn = (e: MatchEntry) => sourceOf(e).id !== "pro";
/** Played to its end. An abandoned match opens normally but is in no W-L and no career total. */
export const isFinished = (e: MatchEntry) => e.match.complete;
/**
 * Whether a match is a match at all: it has activity, a completed round, a kill or a damage event
 * (MatchEntry.activity). A recording stopped before anything happened is left out of Matches and every
 * career number; a winnerless one with kills or damage is listed and labelled unfinished. (The rule and
 * names #29 uses.)
 */
export const isListed = (s: MatchEntry) => s.activity;

/** What Matches lists: the matches in the filter that isListed keeps. */
export const listedEntries = (all: MatchEntry[], map: string | null) => filterEntries(all, map).filter(isListed);

/** The result is known: some round has a winner. A 0:0 with unknown winners is no draw, so it stays out of W-L. */
export const hasKnownResult = (e: MatchEntry) => e.score.us + e.score.them > 0;
/** The kill-by-kill log covers at least half the rounds (the coverage rule; see coverEntry). */
export const isLogged = (e: MatchEntry) => ratedMatch(e.match);

/**
 * The one match set every career number reads (the sidebar, Home, Profile, Career aim, and the
 * Matches summary's rating): the user's own finished matches whose kill-by-kill log covers at least
 * half their rounds. Pro demos, unfinished matches and thin logs neither appear in a career list nor
 * move an average, so the sidebar, the Rating 3.0 tile and Form's pooled line agree.
 */
export const careerEntries = (all: MatchEntry[], map: string | null) => listedEntries(all, map).filter((s) => isOwn(s) && isFinished(s) && isLogged(s));

/** Matches that count in a win-loss record: the user's own finished ones. A thin log still has a real result. */
export const recordEntries = (list: MatchEntry[]) => list.filter((s) => isOwn(s) && isFinished(s) && hasKnownResult(s));

/** Why a match is left out of the career, for its row's tooltip; null when it counts. */
export function notCountedText(e: MatchEntry): string | null {
  if (!isOwn(e)) return "Pro demo: not part of your career.";
  if (!isFinished(e)) return `Unfinished: abandoned after ${e.match.nRounds} ${e.match.nRounds === 1 ? "round" : "rounds"}. It opens normally, but is left out of W–L and career totals.`;
  if (!isLogged(e)) return `${loggedText(e.match)}: too few for a rating, so it is left out of career totals.`;
  return null;
}


/** Maps present in the data, most played first. */
export function mapsIn(all: MatchEntry[]): string[] {
  const n = new Map<string, number>();
  for (const s of all) n.set(s.match.map, (n.get(s.match.map) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** Bots in a list of matches, by steamid: the "bots you played" comparison. */
export const botIds = (list: MatchEntry[]) => [...new Set(list.flatMap((e) => e.players.filter((p) => p.bot).map((p) => p.id)))];
