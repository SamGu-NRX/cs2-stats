// HLTV's attributes block, directly under the Profile card. One Side control and one "Compared to"
// control govern the whole panel. Firepower has its own full-width row; the six style attributes follow
// in pairs. Each shows a score out of 100 (the mean of its metrics' percentiles in the chosen population)
// and expands to the metrics behind it. Firepower ranks against the chosen bot pool so one control
// governs the panel; each expanded performance metric keeps its pro percentile (design/identity.md).
// The bars are cream, never red or green: a style score has no better or worse.
import { useId, useState, type MouseEvent } from "react";
import { Segmented, Select, type Option } from "../../components/controls";
import { Percentile, type PercentileKind } from "../../components/Percentile";
import { AttrIcon } from "../../icons/attributes";
import type { AttributeId } from "../../data/proPack";

export type PanelSide = "both" | "CT" | "T";
export interface PanelMetric { id: string; label: string; value: string | null; unit?: string; pct: number | null; kind: PercentileKind; population: string; def?: string }
export interface PanelAttribute { id: AttributeId; label: string; score: number | null; note?: string; metrics: PanelMetric[] }

const SIDES: Option<PanelSide>[] = [{ value: "both", label: "Both" }, { value: "CT", label: "CT", side: "ct" }, { value: "T", label: "T", side: "t" }];

function Attribute({ a, wide = false }: { a: PanelAttribute; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(true);
  const id = useId();
  // a keyboard toggle (detail 0) changes instantly; a click animates
  const toggle = (e: MouseEvent) => { setInstant(e.detail === 0); setOpen((o) => !o); };
  return (
    <div className={`apa ${wide ? "apa--wide" : ""}`} data-open={open || undefined}>
      <div className="apa__row">
        <AttrIcon id={a.id} size={18} className="apa__icon" />
        <h3 className="apa__name">{a.label}</h3>
        <span className="help" data-tip={`The mean of ${a.metrics.length} metrics' percentiles in the population you compare with. Open it to see them.`} tabIndex={0} aria-label={`What ${a.label} means`}>?</span>
        {a.note ? <span className="apa__note">{a.note}</span> : null}
        <span className="apa__score num">{a.score === null ? "–" : Math.round(a.score)}<small>/100</small></span>
        <button className="apa__chev" aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : "Show"} the metrics behind ${a.label}`} onClick={toggle} />
      </div>
      <div className="apa__bar" aria-hidden><i style={{ width: `${a.score ?? 0}%` }} /></div>
      <div id={id} className={`collapse ${instant ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
        <div className="collapse__in">
          <div className="apa__more">
            {a.metrics.map((m) => <Percentile key={m.id} label={m.label} value={m.value} unit={m.unit} pct={m.pct} kind={m.kind} population={m.population} def={m.def} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AttributesPanel<P extends string>({ side, onSide, pool, pools, onPool, provisional, firepower, style }: {
  side: PanelSide;
  onSide: (s: PanelSide) => void;
  pool: P;
  pools: Option<P>[];
  onPool: (p: P) => void;
  /** one short phrase when the population is provisional, e.g. "Provisional: 72 bot matches"; its explanation goes in provisionalTip */
  provisional: { label: string; tip: string } | null;
  firepower: PanelAttribute;
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
      <Attribute a={firepower} wide />
      <div className="apanel__grid">{style.map((a) => <Attribute key={a.id} a={a} />)}</div>
    </section>
  );
}
