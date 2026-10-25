// Headline metrics over a list of matches: the value for one match, the total over many (always a
// ratio of sums, never an average of per-match ratios), the format and the benchmark. Home's tiles,
// the profile and the career aim view read these.
import { emptyAim, engFor, histMedian, mergeAim, shotsFor, sprayControl, type AimAgg } from "../../stats/aim";
import { addCounters, emptyCounters, type Counters } from "../../stats/counters";
import type { LightSummary } from "../../worker/protocol";
import { R3_PARAMS, rating3, type R3Inputs } from "../../stats/rating3";
import { countersRating } from "./engine";
import { fmtAdr, fmtDec, fmtDeg, fmtMs, fmtPct, fmtRating, fmtSwing } from "../lib/format";
import type { BenchId } from "../lib/verdict";

export interface MetricDef {
  id: string;
  label: string;
  /** definition for the tooltip */
  def: string;
  fmt: (v: number) => string;
  /** format for a delta (absolute value; the sign is drawn as ▲ / ▼) */
  fmtDelta: (v: number) => string;
  bench: BenchId;
  lowerIsBetter?: boolean;
  /** the difference that reads as fully good or bad in a delta */
  deltaSpan: number;
  /** needs plugin aim data */
  aim?: boolean;
  /** depends on the visibility signal, hidden until the engine validates it (stats/visibility.ts) */
  gated?: boolean;
  fromCounters?: (c: Counters) => number | null;
  fromAim?: (a: AimAgg) => number | null;
}

const per = (a: number, b: number) => (b > 0 ? a / b : null);

export const METRIC_DEFS: MetricDef[] = [
  { id: "rating", label: "Rating 3.0", def: "Rating 3.0 (approx.), uncalibrated: Rating 2.0's weights on HLTV 3.0's inputs until it is fitted.", fmt: fmtRating, fmtDelta: (v) => v.toFixed(2), bench: "rating", deltaSpan: 0.3, fromCounters: (c) => (c.rounds ? countersRating(c) : null) },
  { id: "kpr", label: "KPR", def: "Kills per round.", fmt: (v) => fmtDec(v), fmtDelta: (v) => v.toFixed(2), bench: "kpr", deltaSpan: 0.2, fromCounters: (c) => per(c.kills, c.rounds) },
  { id: "adr", label: "ADR", def: "Damage to enemies per round.", fmt: fmtAdr, fmtDelta: (v) => v.toFixed(1), bench: "adr", deltaSpan: 20, fromCounters: (c) => per(c.dmg, c.rounds) },
  { id: "kast", label: "KAST", def: "Rounds with a kill, assist, survival or traded death.", fmt: (v) => fmtPct(v), fmtDelta: (v) => `${v.toFixed(1)}%`, bench: "kast", deltaSpan: 10, fromCounters: (c) => (c.rounds ? (100 * c.kastRounds) / c.rounds : null) },
  { id: "swing", label: "Swing", def: "Average change in your team's round-win probability you caused per round.", fmt: (v) => fmtSwing(v / 100), fmtDelta: (v) => `${v.toFixed(2)}%`, bench: "swing", deltaSpan: 3, fromCounters: (c) => (c.swingRounds ? (100 * c.swing) / c.swingRounds : null) },
  { id: "hs", label: "HS%", def: "Headshot kills as a share of kills.", fmt: (v) => fmtPct(v), fmtDelta: (v) => `${v.toFixed(1)}%`, bench: "hs", deltaSpan: 15, fromCounters: (c) => (c.kills ? (100 * c.hsKills) / c.kills : null) },
  { id: "acc", label: "Accuracy", def: "Hits divided by shots, all guns. Recorded matches only.", fmt: (v) => fmtPct(v), fmtDelta: (v) => `${v.toFixed(1)}%`, bench: "acc", deltaSpan: 8, aim: true, fromAim: (a) => { const s = shotsFor(a, "all", "all"); return s.shots ? (100 * s.hits) / s.shots : null; } },
  { id: "reaction", label: "Reaction", def: "Median time from an enemy becoming visible to your aim moving toward them. Recorded matches only; visibility is still being validated.", fmt: fmtMs, fmtDelta: (v) => `${Math.round(v)} ms`, bench: "reaction", lowerIsBetter: true, deltaSpan: 120, aim: true, gated: true, fromAim: (a) => histMedian(engFor(a, "all").react) },
  { id: "ttd", label: "Time to damage", def: "Median time from an enemy becoming visible to your first damage on them. Recorded matches only; visibility is still being validated.", fmt: fmtMs, fmtDelta: (v) => `${Math.round(v)} ms`, bench: "ttd", lowerIsBetter: true, deltaSpan: 200, aim: true, gated: true, fromAim: (a) => histMedian(engFor(a, "all").ttd) },
];

export const metricDef = (id: string) => METRIC_DEFS.find((m) => m.id === id)!;

export function valueFor(m: MetricDef, c: Counters | null, a: AimAgg | null): number | null {
  if (m.fromCounters) return c ? m.fromCounters(c) : null;
  if (m.fromAim) return a ? m.fromAim(a) : null;
  return null;
}

export interface Totals { c: Counters; aim: AimAgg | null; aimMatches: number }

export function totals(list: LightSummary[]): Totals {
  const c = emptyCounters();
  let aim: AimAgg | null = null;
  let aimMatches = 0;
  for (const s of list) {
    addCounters(c, s.human.c);
    if (s.aim) { aim = mergeAim(aim ?? emptyAim(), s.aim); aimMatches++; }
  }
  return { c, aim, aimMatches };
}

/** Per-match values, oldest first. */
export function seriesOf(m: MetricDef, list: LightSummary[]): { s: LightSummary; v: number | null }[] {
  return [...list].reverse().map((s) => ({ s, v: valueFor(m, s.human.c, s.aim) }));
}

/** Spray control (degrees from the target, bullets 4+), all guns. */
export const sprayOf = (a: AimAgg | null) => (a ? sprayControl(shotsFor(a, "all", "all")) : null);
export const fmtSpray = (v: number | null) => fmtDeg(v, 2);

/**
 * Rating 3.0's terms for a breakdown card: each input's value, its weight and its contribution, plus
 * the intercept. Works on any Rating 3.0 inputs (overall or one side), so every card explains the
 * same formula.
 */
export function ratingParts(x: R3Inputs) {
  const f = rating3(x).features;
  if (!f) return null;
  const w = R3_PARAMS.w;
  const terms: { key: keyof typeof w; label: string; value: string }[] = [
    { key: "kpr", label: "Kills per round", value: f.kpr.toFixed(2) },
    { key: "adr", label: "Damage per round", value: f.adr.toFixed(1) },
    { key: "dpr", label: "Deaths per round", value: f.dpr.toFixed(2) },
    { key: "kast", label: "KAST", value: `${f.kast.toFixed(1)}%` },
    { key: "mk", label: "Multi-kill rounds", value: `${f.mk.toFixed(1)}%` },
    { key: "swing", label: "Round swing", value: `${f.swing.toFixed(2)}%` },
  ];
  return [
    ...terms.map((t) => ({ label: t.label, value: t.value, weight: w[t.key].toFixed(4), contrib: w[t.key] * f[t.key] })),
    { label: "Constant", value: "", weight: "", contrib: R3_PARAMS.intercept },
  ];
}
