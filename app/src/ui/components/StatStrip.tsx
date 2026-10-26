// One line of stats where the aim views had a ring and bento tiles: each item is a label, a value and
// the shared percentile phrase (components/Percentile.tsx). An item whose data cannot exist for the
// selection shows a dash and a short reason instead of a fake number.
import type { ReactNode } from "react";
import { ApproxMark, percentilePhrase, type PercentileKind } from "./Percentile";

export interface StripItem {
  id: string;
  label: string;
  value: string | null;
  unit?: string;
  pct: number | null;
  kind: PercentileKind;
  population: string;
  /** a few words, e.g. "needs line of sight" */
  unavailable?: string;
  /** partial inputs, e.g. "weapon known for 3 of 7 deaths"; shown instead of a percentile */
  coverage?: string;
  approx?: boolean;
  def?: string;
}

/** `lead`: a first cell of the caller's own (Career aim's accuracy ring), a div with a dt and dds like the items. */
export function StatStrip({ items, label, lead }: { items: StripItem[]; label: string; lead?: ReactNode }) {
  return (
    <dl className="strip" aria-label={label}>
      {lead}
      {items.map((it) => {
        const na = it.unavailable !== undefined || it.value === null;
        return (
          <div key={it.id} className="strip__item" data-na={na || undefined}>
            <dt className="caps" data-tip={it.def} tabIndex={it.def ? 0 : undefined}>{it.label}{it.approx ? <ApproxMark /> : null}</dt>
            <dd className="strip__val num">{na ? "–" : it.value}{!na && it.unit ? <small>{it.unit}</small> : null}</dd>
            <dd className="strip__ph">
              {it.unavailable ?? it.coverage ?? (it.pct === null ? "" : it.kind === "style" ? "Style, not ranked" : <><b>{percentilePhrase(it.pct, "performance")}</b> of {it.population}</>)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
