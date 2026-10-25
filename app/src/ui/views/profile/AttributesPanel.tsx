// HLTV's attributes block, directly under the Profile card. One Side control and one "Compared to"
// control govern the whole panel. Firepower has its own full-width row; the six style attributes follow
// in pairs. Each shows a score out of 100 (the mean of its metrics' percentiles in the chosen population)
// and expands to the metrics behind it. An attribute whose population differs from the panel's control
// (Sniping is always compared with everyone) says so in its note. Each expanded performance metric
// keeps its pro percentile (design/identity.md).
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
}

const SIDES: Option<PanelSide>[] = [{ value: "both", label: "Both" }, { value: "T", label: "T", side: "t" }, { value: "CT", label: "CT", side: "ct" }];

function Attribute({ a, wide = false }: { a: PanelAttribute; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(true);
  const id = useId();
  // a keyboard toggle (detail 0) changes instantly; a click animates
  const toggle = (e: MouseEvent) => { setInstant(e.detail === 0); setOpen((o) => !o); };
  return (
    <div className={`apa ${wide ? "apa--wide" : ""}`} data-open={open || undefined} data-instant={instant || undefined} data-attr={a.id}>
      <div className="apa__row">
        <AttrIcon id={a.id} size={18} className="apa__icon" />
        <h3 className="apa__name">{a.label}</h3>
        <span className="help" data-tip={a.tip ?? `The mean of its ${a.metrics.length} metrics' percentiles. Open it to see them.`} tabIndex={0} aria-label={`What ${a.label} means`}>?</span>
        {a.note ? <span className="apa__note">{a.note}</span> : null}
        <span className="apa__score num">{a.score === null ? "–" : Math.round(a.score)}<small>/100</small></span>
        <button className="apa__chev" aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : "Show"} the metrics behind ${a.label}`} onClick={toggle} />
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

export function AttributesPanel<P extends string>({ side, onSide, pool, pools, onPool, provisional, message, firepower, style }: {
  side: PanelSide;
  onSide: (s: PanelSide) => void;
  pool: P;
  pools: Option<P>[];
  onPool: (p: P) => void;
  /** one short phrase when the population is provisional, e.g. "Provisional: 72 bot matches"; its explanation goes in the tip */
  provisional: { label: string; tip: string } | null;
  /** one line under the controls, e.g. why the chosen pool gives no scores */
  message?: ReactNode;
  firepower: PanelAttribute | null;
  /** entrying, trading, opening, closing, sniping, utility, in that order */
  style: PanelAttribute[];
}) {
  return (
    <section className="card apanel" aria-label="Attributes">
      <div className="apanel__head">
        <span className="apanel__lbl">Side</span>
        <Segmented options={SIDES} value={side} onChange={onSide} label="Side" />
        <div className="apanel__cmp">
          {provisional ? <span className="chip chip--warn" data-tip={provisional.tip} tabIndex={0}>{provisional.label}</span> : null}
          <Select options={pools} value={pool} onChange={onPool} label="Compared to" prefix="Compared to" />
        </div>
      </div>
      {message ? <p className="apanel__msg meta">{message}</p> : null}
      {firepower ? <Attribute a={firepower} wide /> : null}
      <div className="apanel__grid">{style.map((a) => <Attribute key={a.id} a={a} />)}</div>
    </section>
  );
}
