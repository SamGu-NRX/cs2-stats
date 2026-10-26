// HLTV's attributes. The style block (Profile's Identity section) holds the six style attributes in
// pairs, in HLTV's order, under one "Compared to" control; the page's Side control (title bar) sets the
// side. Each attribute shows a score out of 100 (the mean of its metrics' percentiles in its population)
// and opens to the metrics behind it. Firepower uses the same row, alone and open, in its own card.
// The bars are cream, never red or green: a style score has no better or worse. A provisional score
// (a still-small bot pool) draws its bar hatched.
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { Select, type Option } from "../../components/controls";
import { ApproxMark, Percentile, type PercentileKind } from "../../components/Percentile";
import type { Sub } from "../../data/engine";
import { ATTR_TIP, PROVISIONAL_TIP } from "../../data/tips";
import { AttrIcon } from "../../icons/attributes";
import type { AttributeId } from "../../data/proPack";
import { splitUnit } from "./parts";

export interface PanelMetric {
  id: string; label: string; value: string | null; unit?: string; pct: number | null; kind: PercentileKind; population: string; def?: string;
  /** the metric's status is "approx" */
  approx?: boolean;
  /** why the engine gave no percentile (compare.ts Percentile.reason) */
  reason?: string | null;
  /** one honest sentence when the value cannot exist for this selection */
  unavailable?: string;
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

/**
 * A metric with its value only, under an attribute's scored metrics (main's unscored rows). The label
 * carries the definition, as the scored rows' labels do; there is no bar because nothing ranks it.
 */
export function ValueRow({ s }: { s: Sub }) {
  const v = splitUnit(s.text);
  return (
    <div className="vrow" data-metric={s.id}>
      <span className="vrow__label" data-tip={s.def} tabIndex={0}>{s.label}{s.status === "approx" ? <ApproxMark /> : null}</span>
      <span className="vrow__val num">{v.value}{v.unit ? <small>{v.unit}</small> : null}</span>
    </div>
  );
}

/** The metric ranked highest, shown beside a closed attribute so its row says what drives the score. */
const peekOf = (a: PanelAttribute) => a.metrics.filter((m) => m.pct !== null && m.value !== null && !m.reason).sort((x, y) => y.pct! - x.pct!)[0];

export function Attribute({ a, wide = false }: { a: PanelAttribute; wide?: boolean }) {
  const [open, setOpen] = useState(!!a.open);
  // ?attr= or the data can ask for another attribute to open: follow that change, keep the user's toggles otherwise
  const [asked, setAsked] = useState(!!a.open);
  if (!!a.open !== asked) {
    setAsked(!!a.open);
    setOpen(!!a.open);
  }
  const [instant, setInstant] = useState(true);
  const id = useId();
  const peek = open ? undefined : peekOf(a);
  // The whole row opens the attribute for a pointer; the chevron button is its keyboard control, and
  // a keyboard toggle (detail 0) changes instantly where a click animates. The (?) and a provisional
  // score keep their own tooltips.
  const toggle = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".help, .apa__score[tabindex]")) return;
    setInstant(e.detail === 0);
    setOpen((o) => !o);
  };
  return (
    <div className={`apa ${wide ? "apa--wide" : ""}`} data-open={open || undefined} data-attr={a.id} data-prov={a.provisional || undefined}>
      <div className="apa__row" onClick={toggle}>
        <AttrIcon id={a.id} size={18} className="apa__icon" />
        <h3 className="apa__name">{a.label}</h3>
        <span className="help" data-tip={ATTR_TIP[a.id]} tabIndex={0} aria-label={`What ${a.label} means`}>?</span>
        {a.note ? <span className="apa__note">{a.note}</span> : null}
        {peek ? <span className="apa__peek meta">{peek.label} <b className="num">{peek.value}{peek.unit}</b></span> : null}
        <span className="apa__score num" {...(a.provisional ? { "data-tip": PROVISIONAL_TIP, tabIndex: 0 } : {})}>{a.score === null ? "–" : Math.round(a.score)}<small>/100</small></span>
        <button className={`apa__chev ${instant ? "is-instant" : ""}`} aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : "Show"} the metrics behind ${a.label}`} />
      </div>
      <div className="apa__bar" aria-hidden><i style={{ width: `${a.score ?? 0}%` }} /></div>
      <div id={id} className={`collapse ${instant ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
        <div className="collapse__in">
          <div className="apa__more">
            {a.metrics.map((m) => (
              <Percentile key={m.id} label={m.label} value={m.value} unit={m.unit} pct={m.pct} kind={m.kind} population={m.population} def={m.def}
                approx={m.approx} reason={m.reason} unavailable={m.unavailable} />
            ))}
            {a.extra?.map((s) => <ValueRow key={s.id} s={s} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AttributesPanel<P extends string>({ title, tip, pool, pools, onPool, poolNote, message, style }: {
  title: string;
  /** the title's tooltip */
  tip: string;
  pool: P;
  pools: Option<P>[];
  onPool: (p: P) => void;
  /** the chosen pool's size in words, e.g. "Against 62 rifler bot matches" */
  poolNote?: string;
  /** one line under the controls, e.g. why the chosen pool gives no scores */
  message?: ReactNode;
  /** entrying, trading, opening, closing, sniping, utility, in that order */
  style: PanelAttribute[];
}) {
  return (
    <section className="card apanel" aria-label={title}>
      <div className="apanel__head">
        <h2 className="card__title apanel__title"><span className="card__tipped" data-tip={tip} tabIndex={0}>{title}</span></h2>
        <div className="apanel__cmp">
          {poolNote ? <span className="meta">{poolNote}</span> : null}
          <Select options={pools} value={pool} onChange={onPool} label="Compared to" prefix="Compared to" />
        </div>
      </div>
      {message ? <p className="apanel__msg meta">{message}</p> : null}
      <div className="apanel__grid">{style.map((a) => <Attribute key={a.id} a={a} />)}</div>
    </section>
  );
}
