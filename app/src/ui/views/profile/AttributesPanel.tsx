// HLTV's attributes block, where Profile's Identity section starts. One Side control and one
// "Compared to" control govern the whole panel. Firepower comes first, then the six style attributes,
// one per row in HLTV's order. Each shows a score out of 100 (the mean of its metrics' percentiles in
// its population) and expands to the metrics behind it. An attribute whose population differs from
// the panel's control (Firepower ranks against pros, Sniping against every bot) says so in its note.
// The bars are cream, never red or green: a style score has no better or worse.
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { Segmented, Select, type Option } from "../../components/controls";
import { Percentile, type PercentileKind } from "../../components/Percentile";
import { AttrIcon } from "../../icons/attributes";
import type { AttributeId } from "../../data/proPack";

export type PanelSide = "both" | "CT" | "T";
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
  /** the help tooltip; defaults to how the score is built */
  tip?: string;
  /** starts expanded */
  open?: boolean;
}

const SIDES: Option<PanelSide>[] = [{ value: "both", label: "Both" }, { value: "CT", label: "CT", side: "ct" }, { value: "T", label: "T", side: "t" }];

/** The metric ranked highest, shown beside a closed attribute so its row says what drives the score. */
const peekOf = (a: PanelAttribute) => a.metrics.filter((m) => m.pct !== null && m.value !== null && !m.reason).sort((x, y) => y.pct! - x.pct!)[0];

function Attribute({ a }: { a: PanelAttribute }) {
  const [open, setOpen] = useState(!!a.open);
  const [instant, setInstant] = useState(true);
  const id = useId();
  const peek = open ? undefined : peekOf(a);
  // The whole row opens the attribute for a pointer; the chevron button is its keyboard control, and
  // a keyboard toggle (detail 0) changes instantly where a click animates. The (?) keeps its own tooltip.
  const toggle = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".help")) return;
    setInstant(e.detail === 0);
    setOpen((o) => !o);
  };
  return (
    <div className="apa" data-open={open || undefined} data-attr={a.id}>
      <div className="apa__row" onClick={toggle}>
        <AttrIcon id={a.id} size={18} className="apa__icon" />
        <h3 className="apa__name">{a.label}</h3>
        <span className="help" data-tip={a.tip ?? `The mean of its ${a.metrics.length} metrics' percentiles. Open it to see them.`} tabIndex={0} aria-label={`What ${a.label} means`}>?</span>
        {a.note ? <span className="apa__note">{a.note}</span> : null}
        {peek ? <span className="apa__peek meta">{peek.label} <b className="num">{peek.value}{peek.unit}</b></span> : null}
        <span className="apa__score num">{a.score === null ? "–" : Math.round(a.score)}<small>/100</small></span>
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
          </div>
        </div>
      </div>
    </div>
  );
}

export function AttributesPanel<P extends string>({ side, onSide, pool, pools, onPool, poolNote, provisional, message, firepower, style, children }: {
  side: PanelSide;
  onSide: (s: PanelSide) => void;
  pool: P;
  pools: Option<P>[];
  onPool: (p: P) => void;
  /** the chosen pool's size in words, e.g. "Percentile against 62 rifler bot careers" */
  poolNote?: ReactNode;
  /** one short phrase when the population is provisional, e.g. "Provisional: 72 bot matches"; its explanation goes in the tip */
  provisional: { label: string; tip: string } | null;
  /** one line under the controls, e.g. why the chosen pool gives no scores */
  message?: ReactNode;
  firepower: PanelAttribute | null;
  /** entrying, trading, opening, closing, sniping, utility, in that order */
  style: PanelAttribute[];
  /** the note under the rows: how the scores are built */
  children?: ReactNode;
}) {
  return (
    <section className="card apanel" aria-label="Attributes">
      <div className="apanel__head">
        <h2 className="card__title apanel__title">Attributes</h2>
        <span className="apanel__lbl">Side</span>
        <Segmented options={SIDES} value={side} onChange={onSide} label="Side" />
        <div className="apanel__cmp">
          {provisional ? <span className="chip chip--warn" data-tip={provisional.tip} tabIndex={0}>{provisional.label}</span> : null}
          {poolNote ? <span className="meta">{poolNote}</span> : null}
          <Select options={pools} value={pool} onChange={onPool} label="Compared to" prefix="Compared to" />
        </div>
      </div>
      {message ? <p className="apanel__msg meta">{message}</p> : null}
      <div className="apanel__list">
        {firepower ? <Attribute a={firepower} /> : null}
        {style.map((a) => <Attribute key={a.id} a={a} />)}
      </div>
      {children ? <div className="apanel__foot">{children}</div> : null}
    </section>
  );
}
