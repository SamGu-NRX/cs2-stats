// Career views (the Leetify parity list, PR B): 0-100 aim and utility ratings as composites of pro
// percentiles, any two summaries compared metric by metric, personal bests, top stats, focus areas and
// play sessions. Our definitions over schema v1 data; Leetify's pages were the checklist, and its
// weights are unpublished, so every weight here is ours.
import type { Percentile } from "./compare";
import { inputKnown, type Input, type Measures } from "./facts";
import { METRICS, type Need } from "./metrics";
import type { Summary } from "./rollup";

// ---------------------------------------------------------------- 0-100 ratings

/** One input of a composite: a metric, its weight, and whether a higher percentile is worse (an identity metric where more is worse). */
export interface CompositePart { id: string; weight: number; invert?: boolean }

/**
 * The composites and their inputs, every weight 1 (ours: Leetify does not publish its weights). A
 * performance metric's percentile already reads higher-is-better (compare() flips lowerIsBetter); the
 * identity inputs read as more is better except teammates flashed, which is inverted.
 */
export const COMPOSITES: Record<"aimRating" | "utilityQuantity" | "utilityQuality", CompositePart[]> = {
  aimRating: ["crosshairPlacement", "timeToDamage", "firstBulletAccuracy", "sprayAccuracy", "headAccuracy", "counterStrafe", "sightAccuracy"].map((id) => ({ id, weight: 1 })),
  utilityQuantity: ["flashesPR", "smokesPR", "hesPR", "molotovsPR"].map((id) => ({ id, weight: 1 })),
  utilityQuality: [
    ...["flashKillsPerFlash", "enemiesPerFlash", "blindPerFlash", "dmgPerHe", "molotovDmg", "utilUnused"].map((id) => ({ id, weight: 1 })),
    { id: "teamFlashPR", weight: 1, invert: true },
  ],
};

export interface CompositeScore {
  /** 0-100: the weighted mean of the inputs' percentiles; null unless every input has one */
  score: number | null;
  parts: { id: string; pct: number | null; weight: number }[];
  /** inputs without a percentile, and so why score is null */
  missing: string[];
}

/** A composite from a compare() result. */
export function compositeOf(parts: CompositePart[], p: Record<string, Percentile>): CompositeScore {
  const out = parts.map((x) => {
    const pct = p[x.id]?.pct ?? null;
    return { id: x.id, weight: x.weight, pct: pct === null ? null : x.invert ? 100 - pct : pct };
  });
  const missing = out.filter((x) => x.pct === null).map((x) => x.id);
  const w = out.reduce((a, x) => a + x.weight, 0);
  return { score: missing.length ? null : out.reduce((a, x) => a + x.weight * x.pct!, 0) / w, parts: out, missing };
}

/** Aim Rating, Utility Rating and its two sub-ratings (Utility Rating is the mean of quantity and quality). */
export function careerRatings(p: Record<string, Percentile>) {
  const aimRating = compositeOf(COMPOSITES.aimRating, p);
  const utilityQuantity = compositeOf(COMPOSITES.utilityQuantity, p);
  const utilityQuality = compositeOf(COMPOSITES.utilityQuality, p);
  const both = utilityQuantity.score !== null && utilityQuality.score !== null;
  return { aimRating, utilityQuantity, utilityQuality, utilityRating: both ? (utilityQuantity.score! + utilityQuality.score!) / 2 : null };
}

// ---------------------------------------------------------------- two summaries, metric by metric

export interface MetricDelta {
  id: string;
  value: number | null;
  /** the metric over the other summary (a previous period, recent matches) */
  before: number | null;
  delta: number | null;
  /** performance metrics: better or worse (lowerIsBetter flips it); identity metrics: higher or lower; same when equal */
  direction: "better" | "worse" | "higher" | "lower" | "same" | null;
}

/** Every metric over `now` against the same metric over `before`. */
export function metricDeltas(now: Summary, before: Summary): MetricDelta[] {
  return METRICS.map((m) => {
    const value = m.value(now), prev = m.value(before);
    if (value === null || prev === null) return { id: m.id, value, before: prev, delta: null, direction: null };
    const delta = value - prev;
    const direction = delta === 0 ? "same" : m.kind === "performance" ? (delta > 0 !== (m.lowerIsBetter ?? false) ? "better" : "worse") : delta > 0 ? "higher" : "lower";
    return { id: m.id, value, before: prev, delta, direction };
  });
}

// ---------------------------------------------------------------- personal bests

/** A match must have this many rounds for its rates to stand as a personal best. Ours, no fit. */
export const BEST_MIN_ROUNDS = 10;

/** Per-match counts with a best: the most in one match, from a match that recorded the inputs in `needs`. */
export const BEST_COUNTS: { id: string; label: string; needs?: Input[]; of: (m: Measures) => number }[] = [
  { id: "kills", label: "Kills", of: (m) => m.kills },
  { id: "assists", label: "Assists", of: (m) => m.assists },
  { id: "hsKills", label: "Headshot kills", of: (m) => m.hsKills },
  { id: "dmg", label: "Damage", of: (m) => m.dmg },
  { id: "multiKillRounds", label: "Multi-kill rounds", of: (m) => m.multiKillRounds },
  { id: "openingKills", label: "Opening kills", of: (m) => m.openingKills },
  { id: "tradeKills", label: "Trade kills", of: (m) => m.tradeKills },
  { id: "clutchesWon", label: "Clutches won", of: (m) => m.clutchWon1 + m.clutchWon2 + m.clutchWon3 + m.clutchWon4 + m.clutchWon5 },
  { id: "enemiesFlashed", label: "Enemies flashed", needs: ["utility"], of: (m) => m.enemiesFlashed },
  { id: "utilDmg", label: "Utility damage", needs: ["utility"], of: (m) => m.utilDmg },
];

export interface Best { id: string; value: number; file: string }

/**
 * The match recorded every input in `needs` in full. "model" chooses the pro pool and "eco" gates only
 * the percentile (facts.ts INPUT_COVERAGE), so neither says anything about one match's value.
 */
const recordedIn = (s: Summary, needs: readonly Need[] = []) => needs.every((n) => n === "model" || n === "eco" || inputKnown(n, s.m));

/**
 * Adds one match's values to the bests: every count in BEST_COUNTS, and every performance metric with
 * a value (its best is the highest, or the lowest where lower is better) when the match has
 * BEST_MIN_ROUNDS rounds and the metric's sample minimum. A count or metric whose inputs the match did
 * not record in full has no best from it, rather than a zero or a value over some of its rows. A tie
 * keeps the earlier match.
 */
export function addBests(acc: Record<string, Best>, file: string, s: Summary): void {
  const keep = (id: string, value: number, better: (a: number, b: number) => boolean) => {
    const cur = acc[id];
    if (!cur || better(value, cur.value)) acc[id] = { id, value, file };
  };
  for (const c of BEST_COUNTS) if (s.m.rounds && recordedIn(s, c.needs)) keep(c.id, c.of(s.m), (a, b) => a > b);
  if (s.m.rounds < BEST_MIN_ROUNDS) return;
  for (const m of METRICS) {
    if (m.kind !== "performance" || !recordedIn(s, m.needs) || (m.sample?.min !== undefined && m.sample.n(s) < m.sample.min)) continue;
    const v = m.value(s);
    if (v !== null && Number.isFinite(v)) keep(m.id, v, m.lowerIsBetter ? (a, b) => a < b : (a, b) => a > b);
  }
}

// ---------------------------------------------------------------- top stats and focus areas

/** The `n` performance metrics with the highest percentile (ties by id). */
export function topStats(p: Record<string, Percentile>, n = 5): Percentile[] {
  return Object.values(p).filter((x) => x.pct !== null && METRICS.find((m) => m.id === x.id)?.kind === "performance")
    .sort((a, b) => b.pct! - a.pct! || a.id.localeCompare(b.id)).slice(0, n);
}

/** Below this percentile a skill is a focus area: under the pool's middle. Ours. */
export const FOCUS_BELOW = 50;

/** One practical sentence per skill a focus area can name. Ours. */
export const FOCUS_TIPS: Record<string, string> = {
  crosshairPlacement: "Keep your crosshair at head height on the angle you expect an enemy.",
  timeToDamage: "Pre-aim the common spots so you can shoot the moment someone appears.",
  firstBulletAccuracy: "Stop completely before the first shot instead of shooting on the move.",
  sprayAccuracy: "Practise your main rifle's spray pattern on a recoil map before you play.",
  headAccuracy: "Aim at head height rather than the body when an enemy first appears.",
  counterStrafe: "Tap the opposite movement key to stop dead before every rifle shot.",
  sightAccuracy: "Fire when you can see the enemy, and stop spraying at where he was.",
  adr: "Shoot at enemies your teammates are already fighting so your damage finishes kills.",
  kast: "Fight close enough to a teammate that a death of yours gets traded.",
  dpr: "After a kill, reposition before you take the next fight.",
  openingSuccess: "Open duels with a flash, or from an angle enemies rarely check.",
  tradeKillSuccess: "Stay close behind your entry so you can swing the moment he dies.",
  tradedDeathSuccess: "Take your fights where a teammate can see the enemy who kills you.",
  flashKillsPerFlash: "Flash for a teammate who is ready to peek, not into empty space.",
  utilUnused: "Use your grenades before you take a fight you might lose.",
  dmgPerHe: "Throw grenades at grouped enemies, or at one a teammate has already hurt.",
  molotovDmg: "Throw molotovs onto the spots enemies hold, not onto open ground.",
  oneVsOne: "In a 1v1, use sound and the clock before you peek.",
};

export interface FocusArea { id: string; pct: number; gap: number; tip: string }

/** The weakest skills with a tip: performance metrics under FOCUS_BELOW, ranked by how far under. */
export function focusAreas(p: Record<string, Percentile>, n = 5): FocusArea[] {
  return Object.values(p).filter((x) => x.pct !== null && x.pct < FOCUS_BELOW && FOCUS_TIPS[x.id])
    .map((x) => ({ id: x.id, pct: x.pct!, gap: FOCUS_BELOW - x.pct!, tip: FOCUS_TIPS[x.id] }))
    .sort((a, b) => b.gap - a.gap || a.id.localeCompare(b.id)).slice(0, n);
}

// ---------------------------------------------------------------- sessions

/** A gap this long or longer between one match's end and the next one's start starts a new session (the user's figure). */
export const SESSION_GAP_H = 3;

/** Matches (start and end in ms) grouped into sessions, each in start order, sessions in start order. */
export function groupSessions(ms: { file: string; start: number; end: number }[], gapH = SESSION_GAP_H): string[][] {
  const sorted = [...ms].sort((a, b) => a.start - b.start || a.file.localeCompare(b.file));
  const out: string[][] = [];
  let lastEnd = -Infinity;
  for (const m of sorted) {
    if (!out.length || m.start - lastEnd >= gapH * 3_600_000) out.push([]);
    out[out.length - 1].push(m.file);
    lastEnd = Math.max(lastEnd, m.end);
  }
  return out;
}

export interface SessionAwards {
  /** the match with the highest Rating 3.0, and the one with the most kills (ties: the earlier) */
  bestMatch: { file: string; rating: number } | null;
  mostKills: { file: string; kills: number } | null;
}

/** A session's awards from its matches, in play order. */
export function awardsOf(rows: { file: string; rating: number | null; kills: number }[]): SessionAwards {
  let bestMatch: SessionAwards["bestMatch"] = null, mostKills: SessionAwards["mostKills"] = null;
  for (const r of rows) {
    if (r.rating !== null && (!bestMatch || r.rating > bestMatch.rating)) bestMatch = { file: r.file, rating: r.rating };
    if (!mostKills || r.kills > mostKills.kills) mostKills = { file: r.file, kills: r.kills };
  }
  return { bestMatch, mostKills };
}
