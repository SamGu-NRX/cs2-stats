// GOOD / AVERAGE / POOR verdicts, as on HLTV's player card, and the geometry of the meter under
// each stat. Two references are possible:
// - a fixed benchmark (BENCH), hand-picked near HLTV's pro averages;
// - a measured average (the bots you played), where a band of ±7 % around it reads as average.
// Neither has a calibration study behind it; the tooltip in the UI names which reference is used.

export type Verdict = "good" | "avg" | "poor" | "na";

export interface Bench {
  label: string;
  /** at or past this is good */
  good: number;
  /** past this is poor */
  poor: number;
  /** meter range */
  min: number;
  max: number;
  /** the average marked on the meter */
  ref: number;
  lowerIsBetter?: boolean;
}

// Hand-picked thresholds. Ratings, KPR, DPR, ADR and KAST sit around HLTV's top-level averages
// (rating 1.00, KPR ~0.68, DPR ~0.66, ADR ~76, KAST ~71 %). The aim thresholds come from public
// Leetify ranges for reaction and time to damage. No study calibrates them for bot matches.
export const BENCH = {
  rating: { label: "Rating", good: 1.1, poor: 0.95, min: 0.5, max: 1.6, ref: 1.0 },
  kpr: { label: "KPR", good: 0.76, poor: 0.62, min: 0.3, max: 1.2, ref: 0.68 },
  dpr: { label: "DPR", good: 0.62, poor: 0.72, min: 0.4, max: 0.9, ref: 0.66, lowerIsBetter: true },
  adr: { label: "ADR", good: 82, poor: 70, min: 40, max: 130, ref: 76 },
  kast: { label: "KAST", good: 74, poor: 68, min: 50, max: 90, ref: 71 },
  /** percent points per round */
  swing: { label: "Swing", good: 1, poor: -0.5, min: -6, max: 8, ref: 0 },
  /** share of rounds with 2+ kills, percent */
  multi: { label: "Multi-kill", good: 17, poor: 13, min: 0, max: 40, ref: 15 },
  hs: { label: "HS%", good: 50, poor: 35, min: 0, max: 80, ref: 45 },
  acc: { label: "Accuracy", good: 26, poor: 18, min: 0, max: 50, ref: 22 },
  reaction: { label: "Reaction", good: 250, poor: 400, min: 100, max: 700, ref: 320, lowerIsBetter: true },
  ttd: { label: "Time to damage", good: 450, poor: 700, min: 200, max: 1200, ref: 560, lowerIsBetter: true },
  xhair: { label: "Crosshair", good: 5, poor: 10, min: 0, max: 20, ref: 7, lowerIsBetter: true },
} satisfies Record<string, Bench>;

export type BenchId = keyof typeof BENCH;

export function verdictOf(v: number | null | undefined, b: Bench): Verdict {
  if (v === null || v === undefined || !Number.isFinite(v)) return "na";
  if (b.lowerIsBetter) return v <= b.good ? "good" : v > b.poor ? "poor" : "avg";
  return v >= b.good ? "good" : v < b.poor ? "poor" : "avg";
}

export const REF_BAND = 0.07;

/** A benchmark built around a measured average: ±7 % of it is average. */
export function benchAround(base: Bench, ref: number): Bench {
  const d = Math.max(Math.abs(ref) * REF_BAND, (base.max - base.min) * 0.02);
  return base.lowerIsBetter
    ? { ...base, ref, good: ref - d, poor: ref + d }
    : { ...base, ref, good: ref + d, poor: ref - d };
}

export interface MeterGeometry {
  /** 0..1 positions on the track */
  value: number | null;
  ref: number;
  /** zone edges, left to right: [0, low] is the left zone, [high, 1] the right zone */
  low: number;
  high: number;
  /** the good zone is on the right unless lower is better */
  goodOnRight: boolean;
}

const unit = (x: number, b: Bench) => Math.max(0, Math.min(1, (x - b.min) / (b.max - b.min)));

export function meterGeometry(v: number | null | undefined, b: Bench): MeterGeometry {
  const val = v === null || v === undefined || !Number.isFinite(v) ? null : unit(v, b);
  const goodOnRight = !b.lowerIsBetter;
  const p = unit(b.poor, b);
  const g = unit(b.good, b);
  return { value: val, ref: unit(b.ref, b), low: Math.min(p, g), high: Math.max(p, g), goodOnRight };
}

export const VERDICT_LABEL: Record<Verdict, string> = { good: "Good", avg: "Average", poor: "Poor", na: "n/a" };
