// The UI's view of the stats engine: labels, the side switch, stat lines read through METRIC, the
// attribute and role adapters, and number formats by metric unit. Views read engine numbers through
// these functions; nothing here defines a metric.
import { BUY_CLASSES, type BuyClass } from "../../stats/economy";
import type { AttributeScore } from "../../stats/compare";
import { emptyMeasures, type Measures } from "../../stats/facts";
import { METRIC, type Kind, type Status } from "../../stats/metrics";
import { RATING3_DIAGNOSTIC, RATING3_LABEL, rating3, rating3BySide } from "../../stats/rating3";
import { rollup, type Summary } from "../../stats/rollup";
import type { Side } from "../../stats/tables";
import { fmtAdr, fmtDec, fmtDeg, fmtInt, fmtMoney, fmtMs, fmtPct, fmtRating, fmtSecs } from "../lib/format";
import type { MatchEntry, MatchModel } from "./match";
import type { AttributeId } from "./proPack";

// ---------------------------------------------------------------- rating

export const RATING_LABEL = "Rating 3.0";
export const RATING_HEADLINE = RATING3_LABEL;
/** params.json's own description of the fit, shown while the formula is its diagnostic */
const R3_STATUS = rating3(emptyMeasures()).status;
export const RATING3_NOTE = RATING3_DIAGNOSTIC
  ? `Rating 3.0 (approx.) uses the diagnostic formula in params.json, not the accepted Rating 3.02: ${R3_STATUS}`
  : "Rating 3.0 (approx.): HLTV Rating 3.02 as reconstructed in model/rating3.";
export const RATING_POOLED = "Pooled over rounds: the six inputs are summed over every round before the formula runs once, as HLTV does for careers.";

/**
 * A match whose kill-by-kill log covers under half its rounds (a converted log that holds the first
 * rounds as totals only) gets no rating of its own: the rating of its few covered rounds is not the
 * match's rating. The rounds still count in pooled ratings.
 */
export const R3_MIN_COVERAGE = 0.5;
export const NO_RATING_TIP = "No Rating 3.0: fewer than half of this match's rounds have the kill-by-kill log.";
export const ratedMatch = (m: { nRounds: number; roundsPlayed: number }) => m.nRounds >= R3_MIN_COVERAGE * m.roundsPlayed;
/** A match entry's own rating, null under the coverage rule. */
export const entryRating = (e: MatchEntry) => (ratedMatch(e.match) ? e.rating.value : null);
export { RATING3_DIAGNOSTIC };

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
  summary: Summary;
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
  /** round swing as a win-probability fraction, the unit fmtSwing takes (METRIC.swing is in percent) */
  swing: number | null;
  rating: number | null;
}

const val = (id: string, s: Summary) => METRIC[id].value(s);

export function lineOf(s: Summary, rating: number | null): StatLine {
  const sw = val("swing", s);
  return {
    summary: s, rounds: s.m.rounds, kills: s.m.kills, deaths: s.m.deaths, assists: s.m.assists, diff: s.m.kills - s.m.deaths,
    adr: val("adr", s), kast: val("kast", s), hs: val("hs", s), kpr: val("kpr", s), dpr: val("dpr", s), mk: val("mk", s),
    swing: sw === null ? null : sw / 100, rating,
  };
}

/** A match entry's line for the recording player, both sides. */
export const entryLine = (e: MatchEntry) => lineOf(e.summary, entryRating(e));

/** One player's line in one match on one side (or both), rolled up from the match's facts. */
export function playerLine(v: MatchModel, pi: number, side: SideKey): StatLine {
  const filter = { player: v.players[pi].key };
  const s = rollup([v.facts], { ...filter, ...sidesOf(side) });
  return lineOf(s, ratedMatch(v.facts.match) ? rating3BySide([v.facts], filter)[ratingKey(side)].value : null);
}

export const matchLines = (v: MatchModel, side: SideKey) => v.players.map((p) => playerLine(v, p.pi, side));

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
  switch (METRIC[id].unit) {
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

// ---------------------------------------------------------------- attributes

export interface Sub { id: string; label: string; def: string; value: number | null; text: string; score: number | null; status: Status }
export interface Attr { id: AttributeId; label: string; kind: Kind; score: number | null; subs: Sub[] }

/** The engine's attribute scores (percentiles against the pro pool) with each metric's label and format. */
export const attrsOf = (scores: AttributeScore[]): Attr[] => scores.map((a) => ({
  id: a.id as AttributeId, label: a.label, kind: a.kind, score: a.score,
  subs: a.metrics.map((p) => {
    const m = METRIC[p.id];
    return { id: p.id, label: m.label, def: m.def, value: p.value, text: fmtMetric(p.id, p.value), score: p.pct, status: m.status };
  }),
}));

export const WEAPON_CLASS_LABEL: Record<string, string> = {
  rifle: "Rifles", sniper: "Snipers", smg: "SMGs", heavy: "Heavy", pistol: "Pistols", grenade: "Grenades", knife: "Knife", other: "Other",
};

// ---------------------------------------------------------------- lists

/** Matches in the filter, newest first. */
export function filterEntries(all: MatchEntry[], map: string | null): MatchEntry[] {
  return map ? all.filter((s) => s.match.map === map) : all;
}

/** Maps present in the data, most played first. */
export function mapsIn(all: MatchEntry[]): string[] {
  const n = new Map<string, number>();
  for (const s of all) n.set(s.match.map, (n.get(s.match.map) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

/** Bots in a list of matches, by steamid: the "bots you played" comparison. */
export const botIds = (list: MatchEntry[]) => [...new Set(list.flatMap((e) => e.players.filter((p) => p.bot).map((p) => p.id)))];
