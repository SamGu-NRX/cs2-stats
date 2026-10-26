// The one percentile display: label, value, one bar with your dot and a median tick at 50, one phrase.
// Performance reads "Top N%" or "Bottom N%" of the population; style reads "NN/100 against" it, because
// identity has no better or worse (design/identity.md). Only the population words change between uses.
// Percentiles arrive already flipped for lower-is-better metrics (stats/compare.ts), so the dot always
// sits on a better-is-right scale.
import type { ReactNode } from "react";

export type PercentileKind = "performance" | "style";

export const APPROX_TIP = "Approximate: HLTV hasn't published this formula.";

/** Marks a metric whose status is "approx" (stats/metrics.ts): our reading of an unpublished definition.
 *  Every surface that shows such a metric shows the mark. `plain` drops its own tooltip and tab stop,
 *  for a row that is itself the focus target and carries the note in its tooltip. */
export function ApproxMark({ plain = false }: { plain?: boolean }) {
  return (
    <span className="approx" {...(plain ? {} : { "data-tip": APPROX_TIP, tabIndex: 0 })}>
      <span aria-hidden>≈</span><span className="sr-only">, approximate</span>
    </span>
  );
}

/** "Top 4%" / "Bottom 3%" for performance, "63/100" for style. Never "Top 0%". */
export function percentilePhrase(pct: number, kind: PercentileKind): string {
  if (kind === "style") return `${Math.round(pct)}/100`;
  return pct >= 50 ? `Top ${Math.max(1, Math.round(100 - pct))}%` : `Bottom ${Math.max(1, Math.round(pct))}%`;
}

/** Colour only on performance: green from the 70th percentile, red below the 30th. */
export const percentileTone = (pct: number | null, kind: PercentileKind) =>
  kind === "performance" && pct !== null ? (pct >= 70 ? "good" : pct < 30 ? "poor" : undefined) : undefined;

export function Percentile({ label, value, unit, pct, kind, population, sample, unavailable, coverage, reason, approx, def, variant = "stack" }: {
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
  /** partial inputs: what the value rests on (e.g. "weapon known for 3 of 7 deaths"); the engine gives no percentile then */
  coverage?: string;
  /** why the engine withheld the percentile (compare.ts Percentile.reason, a full sentence); the value stays, the reason stands where the rank would */
  reason?: string | null;
  /** the metric's status is "approx" */
  approx?: boolean;
  /** the metric's definition, shown on hover */
  def?: string;
  /** stack: label and value over the track, the phrase under it; row: all four on one line; quiet: the
   *  stack without the phrase, which moves into the row's tooltip (the dot already shows it) */
  variant?: "stack" | "row" | "quiet";
}) {
  const na = unavailable !== undefined;
  const unranked = na || coverage !== undefined || !!reason;
  const phrase = na ? unavailable : coverage !== undefined ? `${coverage.charAt(0).toUpperCase()}${coverage.slice(1)}; not compared with ${population}` : reason ? reason
    : pct === null ? `Not ranked: too few ${population} to compare with`
    : [percentilePhrase(pct, kind), kind === "performance" ? ` of ${population}` : ` against ${population}`, sample ? ` · ${sample}` : ""];
  const quiet = variant === "quiet";
  const phraseText = Array.isArray(phrase) ? phrase.join("") : phrase ?? "";
  // the row's tooltip: the engine's reason alone when there is one; else the rank, the approx note, what it is
  const sentence = (x: string) => (/[.!?]$/.test(x) ? x : `${x}.`);
  const rowTip = !quiet ? undefined : reason ? reason : [phraseText ? sentence(phraseText) : null, approx ? APPROX_TIP : null, def ?? null].filter(Boolean).join(" ");
  return (
    <div className={`pctl pctl--${variant}`} data-tone={percentileTone(unranked ? null : pct, kind)} data-na={na || undefined}
      {...(quiet ? { "data-tip": rowTip, tabIndex: 0 } : {})}>
      <span className="pctl__label" {...(!quiet && def ? { "data-tip": def, tabIndex: 0 } : {})}>{label}{approx ? <ApproxMark plain={quiet} /> : null}</span>
      <span className="pctl__val num">{na || value === null ? "–" : value}{!na && value !== null && unit ? <small>{unit}</small> : null}</span>
      <span className="pctl__bar" aria-hidden>{!unranked && pct !== null ? <i style={{ left: `${Math.max(0, Math.min(100, pct))}%` }} /> : null}</span>
      {quiet ? null : <span className="pctl__phrase">{Array.isArray(phrase) ? <><b>{phrase[0]}</b>{phrase.slice(1)}</> : phrase}</span>}
    </div>
  );
}
