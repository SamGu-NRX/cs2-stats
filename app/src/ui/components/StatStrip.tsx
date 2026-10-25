// One line of stats where the aim views had a ring and bento tiles: each item is a label, a value and
// the shared percentile phrase (components/Percentile.tsx). An item whose data cannot exist for the
// selection shows a dash and a short reason instead of a fake number.
import { percentilePhrase, type PercentileKind } from "./Percentile";

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
  def?: string;
}

export function StatStrip({ items, label }: { items: StripItem[]; label: string }) {
  return (
    <dl className="strip" aria-label={label}>
      {items.map((it) => {
        const na = it.unavailable !== undefined || it.value === null;
        return (
          <div key={it.id} className="strip__item" data-na={na || undefined}>
            <dt className="caps" data-tip={it.def}>{it.label}</dt>
            <dd className="strip__val num">{na ? "–" : it.value}{!na && it.unit ? <small>{it.unit}</small> : null}</dd>
            <dd className="strip__ph">
              {it.unavailable ?? (it.pct === null ? "" : it.kind === "style" ? "Style, not ranked" : <><b>{percentilePhrase(it.pct, "performance")}</b> of {it.population}</>)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
