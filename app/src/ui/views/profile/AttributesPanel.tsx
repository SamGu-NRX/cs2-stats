// HLTV's style attributes as metric rows (components/MetricRow.tsx). The block holds the six style
// attributes in HLTV's order under one "Compared to" control; the page's Side control (title bar) sets
// the side. Each attribute is a row: its score out of 100 (the mean of its metrics' percentiles in its
// population) on a tan track, since a style score has no better or worse, with the metric that ranks
// highest beside it; the row opens to the metrics behind it. A provisional score (a still-small bot
// pool) is named once, in the card's header pill.
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { Select, type Option } from "../../components/controls";
import { MetricList, MetricRow, Track } from "../../components/MetricRow";
import type { PercentileKind } from "../../components/Percentile";
import type { Sub } from "../../data/engine";
import { ATTR_TIP, PROVISIONAL_TIP } from "../../data/tips";
import type { AttributeId } from "../../data/proPack";

export interface PanelMetric {
  id: string; label: string; value: string | null; unit?: string; pct: number | null; kind: PercentileKind; population: string; def?: string;
  /** the metric's status is "approx" */
  approx?: boolean;
  /** why the engine gave no percentile (compare.ts Percentile.reason) */
  reason?: string | null;
  /** one honest sentence when the value cannot exist for this selection */
  unavailable?: string;
  /** what the value rests on ("6 of 39") and how many events that is (tabs.tsx sampleOf) */
  sample?: string | null;
  n?: number | null;
}
export interface PanelAttribute {
  id: AttributeId; label: string; score: number | null; metrics: PanelMetric[];
  /** the population when it is not the panel's, e.g. "Compared to everyone" */
  note?: string;
  /** starts expanded */
  open?: boolean;
  /** the score ranks against a still-small bot pool */
  provisional?: boolean;
  /** rows after the scored metrics with a value only: not part of the score (engine.ts EXTRA_SUBS) */
  extra?: Sub[];
}

/** A scored metric as a metric row; a value that cannot exist shows a dash and says why. */
export function PanelRow({ m, rank }: { m: PanelMetric; rank?: boolean }) {
  return (
    <MetricRow label={m.label} value={m.unavailable || m.value === null ? null : `${m.value}${m.unit ?? ""}`} sample={m.sample} n={m.n} pct={m.pct} kind={m.kind}
      population={m.population} tip={m.def} reason={m.reason ?? (m.unavailable ? m.unavailable : null)} approx={m.approx} rank={rank} />
  );
}

/** A metric with its value only, under an attribute's scored metrics (main's unscored rows): no track, since nothing ranks it. */
export function ValueRow({ s, rank }: { s: Sub; rank?: boolean }) {
  return <MetricRow label={s.label} value={s.value === null ? null : s.text} pct={null} kind="style" population="" tip={s.def} approx={s.status === "approx"} rank={rank} extra />;
}

/** The metric ranked highest, shown beside the attribute so its row says what drives the score. */
const peekOf = (a: PanelAttribute) => a.metrics.filter((m) => m.pct !== null && m.value !== null && !m.reason).sort((x, y) => y.pct! - x.pct!)[0];

export function Attribute({ a }: { a: PanelAttribute }) {
  const [open, setOpen] = useState(!!a.open);
  // ?attr= or the data can ask for another attribute to open: follow that change, keep the user's toggles otherwise
  const [asked, setAsked] = useState(!!a.open);
  if (!!a.open !== asked) {
    setAsked(!!a.open);
    setOpen(!!a.open);
  }
  const [instant, setInstant] = useState(true);
  const id = useId();
  const peek = peekOf(a);
  // The whole row opens the attribute for a pointer; the chevron button is its keyboard control, and
  // a keyboard toggle (detail 0) changes instantly where a click animates. The (?) and a provisional
  // score keep their own tooltips.
  const toggle = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".help, .apa__score[tabindex]")) return;
    setInstant(e.detail === 0);
    setOpen((o) => !o);
  };
  return (
    <div className="apa" data-open={open || undefined} data-attr={a.id} data-prov={a.provisional || undefined}>
      <div className="mrow apa__row" onClick={toggle}>
        <span className="mrow__lab">
          <h3 className="apa__name">{a.label}</h3>
          <span className="help" data-tip={ATTR_TIP[a.id]} tabIndex={0} aria-label={`What ${a.label} means`}>?</span>
          {a.note ? <span className="apa__note">{a.note}</span> : null}
        </span>
        {a.score === null ? <span /> : <Track at={a.score} />}
        <span className="mrow__smp apa__peek">{peek ? `${peek.label} ${peek.value}${peek.unit ?? ""}` : ""}</span>
        <b className="mrow__val apa__score num" {...(a.provisional ? { "data-tip": PROVISIONAL_TIP, tabIndex: 0 } : {})}>{a.score === null ? "–" : Math.round(a.score)}<small className="unit">/100</small></b>
        <button className={`apa__chev ${instant ? "is-instant" : ""}`} aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : "Show"} the metrics behind ${a.label}`} />
      </div>
      <div id={id} className={`collapse ${instant ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
        <div className="collapse__in">
          <MetricList label={`${a.label} metrics`}>
            {a.metrics.map((m) => <PanelRow key={m.id} m={m} />)}
            {a.extra?.map((s) => <ValueRow key={s.id} s={s} />)}
          </MetricList>
        </div>
      </div>
    </div>
  );
}

export function AttributesPanel<P extends string>({ title, tip, pool, pools, onPool, poolNote, message, style, provisional }: {
  title: string;
  /** the title's tooltip */
  tip: string;
  pool: P;
  pools: Option<P>[];
  onPool: (p: P) => void;
  /** the chosen pool's size in words, e.g. "62 rifler bot matches" */
  poolNote?: string;
  /** one line under the controls, e.g. why the chosen pool gives no scores */
  message?: ReactNode;
  /** entrying, trading, opening, closing, sniping, utility, in that order */
  style: PanelAttribute[];
  /** the scores rank against a still-small bot pool: the header says so once, in a pill */
  provisional?: boolean;
}) {
  return (
    <section className="card apanel" aria-label={title}>
      <div className="card__head apanel__head">
        <h2 className="card__title apanel__title"><span className="card__tipped" data-tip={tip} tabIndex={0}>{title}</span></h2>
        <div className="card__aside apanel__cmp">
          {provisional
            ? <span className="vpill vpill--plain" data-tip={PROVISIONAL_TIP} tabIndex={0}>Provisional{poolNote ? `, ${poolNote}` : ""}</span>
            : poolNote ? <span className="meta">{poolNote}</span> : null}
          <Select options={pools} value={pool} onChange={onPool} label="Compared to" prefix="vs" />
        </div>
      </div>
      {message ? <p className="apanel__msg meta">{message}</p> : null}
      <div className="apanel__grid">{style.map((a) => <Attribute key={a.id} a={a} />)}</div>
    </section>
  );
}
