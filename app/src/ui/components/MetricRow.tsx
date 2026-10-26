// The one metric row every Profile tab uses (design-target-v2 .mrow): label, a dotted track, the
// sample, the value, and optionally the rank as text. The track draws only with a percentile: a
// metric without one shows its value and says why in its tooltip, with no empty track.
// The dot sits at the percentile, the tick at 50 is the pros' median (or the bots' for style). A
// performance dot takes one of five colours by quintile; a style dot is always tan, since style has
// no better or worse. A row resting on fewer than THIN events draws a hollow dot, a quieter value and
// a ≈ after its label.
import type { CSSProperties, ReactNode } from "react";
import { Num } from "./bits";
import { ApproxMark, percentilePhrase, sentence, type PercentileKind } from "./Percentile";

/** Fewer events than this behind a value make it a thin sample (design-target-v2/SYSTEM.md). */
export const THIN = 10;

export type Quintile = 1 | 2 | 3 | 4 | 5;

/** The percentile's fifth, 1 lowest: q5 and q4 read good, q3 neutral, q2 and q1 poor. */
export const quintile = (pct: number): Quintile => (pct >= 80 ? 5 : pct >= 60 ? 4 : pct >= 40 ? 3 : pct >= 20 ? 2 : 1);

const clamp = (x: number) => Math.max(0, Math.min(100, x));

/**
 * A dotted track: the tick at 50, your dot at `at` (0 to 100), and an optional hollow marker at
 * `ghost` (Plays like's pro). `tone` is the dot's colour class: q1 to q5, or none for tan. The dot
 * is placed by `left`; on the page's first render it slides in from the middle (views.css, .trk__dot).
 */
export function Track({ at, ghost, tone, hollow, label, className }: {
  at: number | null;
  ghost?: number | null;
  tone?: `q${Quintile}` | "cream";
  hollow?: boolean;
  /** names the track for assistive tech; without one it is decoration beside a labelled value */
  label?: string;
  className?: string;
}) {
  const pos = (x: number): CSSProperties => ({ left: `${clamp(x)}%`, ["--p" as string]: clamp(x) });
  return (
    <span className={`trk ${tone ?? ""} ${className ?? ""}`} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <span className="trk__mid" />
      {ghost != null && <i className="trk__ref" style={pos(ghost)} />}
      {at !== null && <i className={`trk__dot ${hollow ? "is-hollow" : ""}`} style={pos(at)} />}
    </span>
  );
}

export interface MetricRowProps {
  label: ReactNode;
  /** the formatted value; null shows a dash */
  value: string | null;
  /** what the value rests on: "6 of 39", "8 AWP duels" */
  sample?: string | null;
  /** the events behind the value (a share's denominator, the sample count); under THIN the row is thin */
  n?: number | null;
  /** 0 to 100, higher better for performance; null draws no track */
  pct: number | null;
  kind: PercentileKind;
  /** "pro riflers", "62 rifler bot matches": who the percentile ranks against */
  population: string;
  /** the metric's one-sentence tooltip (Metric.tip) */
  tip?: string;
  /** why there is no percentile (compare.ts Percentile.reason); shown in the tooltip */
  reason?: string | null;
  /** the metric is an approximation: a plain ≈, explained once per tab in its legend */
  approx?: boolean;
  /** the rank as text in a last column; the list must be a MetricList with `rank` */
  rank?: boolean;
  /** a value-only row under a score (engine.ts EXTRA_SUBS): not part of what is ranked */
  extra?: boolean;
}

/** The row's tooltip: what the metric is, then where it ranks or why it does not. */
function tipOf(p: MetricRowProps, thin: boolean): string {
  const rank = p.pct !== null && !p.reason
    ? `${percentilePhrase(p.pct, p.kind)} ${p.kind === "performance" ? "of" : "against"} ${p.population}.`
    : p.reason ? sentence(p.reason) : p.value === null ? "None in these matches." : p.extra ? "Not part of the score." : "Not ranked.";
  const lines = [p.tip, rank, thin ? `Only ${p.n}, so this may shift.` : null];
  return lines.filter(Boolean).join("\n");
}

export function MetricRow(p: MetricRowProps) {
  const ranked = p.pct !== null && !p.reason;
  const thin = p.n !== null && p.n !== undefined && p.n < THIN && p.value !== null;
  const tone = ranked && p.kind === "performance" ? (`q${quintile(p.pct!)}` as const) : undefined;
  return (
    <li className={`mrow ${thin ? "is-thin" : ""}`} data-tip={tipOf(p, thin)} tabIndex={0} data-na={p.value === null || undefined} data-extra={p.extra || undefined}>
      <span className="mrow__lab">{p.label}{p.approx ? <ApproxMark plain /> : null}</span>
      {ranked ? <Track at={p.pct} tone={tone} hollow={thin} /> : <span />}
      <span className="mrow__smp">{p.sample ?? ""}</span>
      <b className="mrow__val num">{p.value === null ? "–" : <Num v={p.value} />}</b>
      {p.rank && (
        <span className={`mrow__rank ${p.kind === "style" ? "is-style" : tone ?? ""}`}>
          {!ranked ? "" : p.kind === "style" ? "Style" : percentilePhrase(p.pct!, "performance")}
        </span>
      )}
    </li>
  );
}

/** A list of metric rows; `rank` adds the rank column, and every row in it must set `rank` too. */
export function MetricList({ children, label, rank }: { children: ReactNode; label?: string; rank?: boolean }) {
  return <ul className={`mrows ${rank ? "mrows--rank" : ""}`} aria-label={label}>{children}</ul>;
}
