// HLTV's attribute block, as HLTV draws it on a player's page and the user asked to keep: Firepower
// wide across the top with its score out of 100 over a filled bar in the performance colours, then
// the six style attributes in pairs, each with its icon, its score out of 100 and a filled bar in the
// neutral style colour (hatched while the bot pool behind it is still small). Every attribute opens
// to the metrics behind it, as dotted-track metric rows (components/MetricRow.tsx). The block's header
// carries what the scores rank against: the side, Firepower's pros or bots, and the style pool.
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { MetricList, MetricRow } from "../../components/MetricRow";
import type { PercentileKind } from "../../components/Percentile";
import type { Sub } from "../../data/engine";
import type { AttributeId } from "../../data/proPack";
import { ATTR_TIP, PROVISIONAL_TIP } from "../../data/tips";
import { AttrIcon } from "../../icons/attributes";
import { scoreFill, scoreText, toScore } from "../../lib/scale";

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
  /** the population when it is not the block's, e.g. "Compared to everyone" */
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

/** The metric ranked highest, shown beside a closed attribute so its row says what drives the score. */
const peekOf = (a: PanelAttribute) => a.metrics.filter((m) => m.pct !== null && m.value !== null && !m.reason).sort((x, y) => y.pct! - x.pct!)[0];

/**
 * One attribute: icon, name, its (?), the score out of 100 and a filled bar, opening to its metrics.
 * `performance` (Firepower) colours the score and the bar by how good it is; a style attribute stays
 * neutral, since a style has no better or worse. The whole head opens it for a pointer; the chevron
 * is its keyboard control, and a keyboard toggle (detail 0) opens instantly where a click animates.
 */
export function Attribute({ a, performance = false, wide = false, rank = false }: { a: PanelAttribute; performance?: boolean; wide?: boolean; rank?: boolean }) {
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
  const t = a.score === null ? 0 : toScore(a.score, 50, 50);
  const toggle = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".help, .hatt__score[tabindex]")) return;
    setInstant(e.detail === 0);
    setOpen((o) => !o);
  };
  return (
    <div className={`hatt ${wide ? "hatt--wide" : ""} ${performance ? "hatt--perf" : ""}`} data-open={open || undefined} data-attr={a.id} data-prov={a.provisional || undefined}>
      <div className="hatt__head" onClick={toggle}>
        <AttrIcon id={a.id} size={wide ? 22 : 18} className="hatt__icon" />
        <h3 className="hatt__name">{a.label}</h3>
        <span className="help" data-tip={ATTR_TIP[a.id]} tabIndex={0} aria-label={`What ${a.label} means`}>?</span>
        {a.note ? <span className="hatt__note">{a.note}</span> : null}
        {peek ? <span className="hatt__peek meta">{peek.label} <b className="num">{peek.value}{peek.unit}</b></span> : <span className="hatt__peek" />}
        <span className="hatt__score disp" style={performance && a.score !== null ? { color: scoreText(t) } : undefined} {...(a.provisional ? { "data-tip": PROVISIONAL_TIP, tabIndex: 0 } : {})}>
          {a.score === null ? "–" : Math.round(a.score)}<small>/100</small>
        </span>
        <button className={`hatt__chev ${instant ? "is-instant" : ""}`} aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : "Show"} the metrics behind ${a.label}`} />
      </div>
      <div className="hatt__bar" aria-hidden>
        <i style={{ width: `${a.score ?? 0}%`, ...(performance && a.score !== null ? { background: scoreFill(t) } : {}) }} />
        {performance && <span className="hatt__mid" />}
      </div>
      <div id={id} className={`collapse ${instant ? "is-instant" : ""}`} data-open={open} {...(open ? {} : { inert: "" })}>
        <div className="collapse__in">
          <MetricList label={`${a.label} metrics`} rank={rank}>
            {a.metrics.map((m) => <PanelRow key={m.id} m={m} rank={rank} />)}
            {a.extra?.map((s) => <ValueRow key={s.id} s={s} rank={rank} />)}
          </MetricList>
        </div>
      </div>
    </div>
  );
}

/**
 * The block: a header with its controls, Firepower wide, the six style attributes in two columns.
 * `firepower` is null while it loads or when the pool cannot rank it; `message` is one line under the
 * header (why the chosen pool gives no scores).
 */
export function AttributesPanel({ controls, note, message, firepower, style, provisional }: {
  /** the header's controls: side, Firepower's population, the style pool */
  controls: ReactNode;
  /** who the scores rank against, in words */
  note?: ReactNode;
  message?: ReactNode;
  firepower: PanelAttribute | null;
  /** entrying, trading, opening, closing, sniping, utility, in that order */
  style: PanelAttribute[];
  /** the style scores rank against a still-small bot pool: said once, in the header */
  provisional?: boolean;
}) {
  return (
    <section className="card hblock" aria-label="Attributes">
      <div className="hblock__head">
        <h2 className="card__title">Attributes</h2>
        {provisional && <span className="vpill vpill--plain" data-tip={PROVISIONAL_TIP} tabIndex={0}>Provisional</span>}
        {note ? <span className="meta hblock__note">{note}</span> : null}
        <div className="hblock__controls">{controls}</div>
      </div>
      {message ? <p className="hblock__msg meta">{message}</p> : null}
      {firepower && <Attribute a={firepower} performance wide rank />}
      <div className="hblock__grid">{style.map((a) => <Attribute key={a.id} a={a} />)}</div>
    </section>
  );
}
