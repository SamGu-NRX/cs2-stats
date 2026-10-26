// The one metric row every Profile tab uses: label, sample, a dotted track with a dot, and the value.
// The track draws only with a dot: a metric without a percentile shows its value and says why in its
// tooltip, with no empty track. The dot is green or red only on a performance metric at the ends of
// the range (Percentile.tsx percentileTone); everywhere else it is cream, which judges nothing.
import type { ReactNode } from "react";
import { ApproxMark, percentilePhrase, percentileTone, sentence, type PercentileKind } from "./Percentile";

export interface MetricRowProps {
  label: ReactNode;
  /** the formatted value; null shows a dash */
  value: string | null;
  /** what the value rests on: "6 of 39", "8 AWP duels" */
  sample?: string | null;
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
}

const DOT: Record<string, string> = { good: "var(--good-text)", poor: "var(--poor-text)" };

/** The row's tooltip: what the metric is, then where it ranks or why it does not. */
function tipOf(p: MetricRowProps): string {
  const rank = p.pct !== null && !p.reason
    ? `${percentilePhrase(p.pct, p.kind)} ${p.kind === "performance" ? "of" : "against"} ${p.population}.`
    : p.reason ? sentence(p.reason) : p.value === null ? "None in these matches." : "Not ranked.";
  return p.tip ? `${p.tip}\n${rank}` : rank;
}

export function MetricRow(p: MetricRowProps) {
  const ranked = p.pct !== null && !p.reason;
  const tone = ranked ? percentileTone(p.pct, p.kind) : undefined;
  return (
    <li className="mrow2" data-tip={tipOf(p)} tabIndex={0} data-na={p.value === null || undefined}>
      <span className="mrow2__l">{p.label}{p.approx ? <ApproxMark plain /> : null}</span>
      <span className="mrow2__n num">{p.sample ?? ""}</span>
      {ranked ? (
        <span className="mrow2__t" aria-hidden>
          <span className="mrow2__mid" />
          <i style={{ left: `${Math.max(0, Math.min(100, p.pct!))}%`, background: tone ? DOT[tone] : "var(--cream)" }} />
        </span>
      ) : <span />}
      <b className="mrow2__v num">{p.value ?? "–"}</b>
    </li>
  );
}

/** A list of metric rows. */
export function MetricList({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className="mrows" aria-label={label}>{children}</ul>;
}
