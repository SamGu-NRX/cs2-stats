// The one percentile display: label, value, one bar with your dot and a median tick at 50, one phrase.
// Performance reads "Top N%" or "Bottom N%" of the population; style reads "NN/100 against" it, because
// identity has no better or worse (design/identity.md). Only the population words change between uses.
// Percentiles arrive already flipped for lower-is-better metrics (stats/compare.ts), so the dot always
// sits on a better-is-right scale.
import type { ReactNode } from "react";

export type PercentileKind = "performance" | "style";

/** "Top 4%" / "Bottom 3%" for performance, "63/100" for style. Never "Top 0%". */
export function percentilePhrase(pct: number, kind: PercentileKind): string {
  if (kind === "style") return `${Math.round(pct)}/100`;
  return pct >= 50 ? `Top ${Math.max(1, Math.round(100 - pct))}%` : `Bottom ${Math.max(1, Math.round(pct))}%`;
}

/** Colour only on performance: green from the 70th percentile, red below the 30th. */
export const percentileTone = (pct: number | null, kind: PercentileKind) =>
  kind === "performance" && pct !== null ? (pct >= 70 ? "good" : pct < 30 ? "poor" : undefined) : undefined;

export function Percentile({ label, value, unit, pct, kind, population, sample, unavailable, def, variant = "stack" }: {
  label: ReactNode;
  /** formatted value; null shows a dash */
  value: string | null;
  unit?: string;
  pct: number | null;
  kind: PercentileKind;
  /** "pro riflers", "rifler bots", "all bots" */
  population: string;
  /** named when the sample is small, e.g. "5 clutches" */
  sample?: string;
  /** one honest sentence when the data cannot exist for this selection */
  unavailable?: string;
  /** the metric's definition, shown on hover */
  def?: string;
  variant?: "stack" | "row";
}) {
  const na = unavailable !== undefined;
  const phrase = na ? unavailable : pct === null ? `Not ranked: too few ${population} to compare with`
    : [percentilePhrase(pct, kind), kind === "performance" ? ` of ${population}` : ` against ${population}`, sample ? ` · ${sample}` : ""];
  return (
    <div className={`pctl pctl--${variant}`} data-tone={percentileTone(na ? null : pct, kind)} data-na={na || undefined}>
      <span className="pctl__label" data-tip={def}>{label}</span>
      <span className="pctl__val num">{na || value === null ? "–" : value}{!na && value !== null && unit ? <small>{unit}</small> : null}</span>
      <span className="pctl__bar" aria-hidden>{!na && pct !== null ? <i style={{ left: `${Math.max(0, Math.min(100, pct))}%` }} /> : null}</span>
      <span className="pctl__phrase">{Array.isArray(phrase) ? <><b>{phrase[0]}</b>{phrase.slice(1)}</> : phrase}</span>
    </div>
  );
}
