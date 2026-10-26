// Profile panels that read the metrics-v2 engine fields (#31): where round swing comes from, how
// aggressively you take fights, and how you buy. These are research metrics, so each row renders only
// when the engine returns a value, and a panel with none does not render: no reserved empty space.
import type { Percentile as Pct } from "../../../stats/compare";
import type { SwingSources } from "../../../stats/swing";
import type { Query, Rolled } from "../../../worker/protocol";
import { Card } from "../../components/Card";
import { MetricList, MetricRow, Track } from "../../components/MetricRow";
import { fmtMetric } from "../../data/engine";
import { useCall } from "../../data/hooks";
import { metric } from "../../data/meta";
import { tipOf } from "../../data/tips";
import { fmtSwing } from "../../lib/format";
import { scoreFill, scoreText, toScore } from "../../lib/scale";

// ---------------------------------------------------------------- dot track

/**
 * A labelled dotted track (components/MetricRow.tsx Track): the tick in the middle, a dot at `at`
 * (0 to 100) and, with `ghost`, a hollow second marker (Plays like's pro). Where the middle is depends
 * on the caller: the pro median for a percentile, the pro mean for the aggression score.
 */
export function DotTrack({ at, ghost, tone, label }: { at: number | null; ghost?: number | null; tone?: "cream"; label: string }) {
  return <Track at={at} ghost={ghost} tone={tone} label={label} />;
}

// ---------------------------------------------------------------- swing by source

const SOURCES: { key: keyof SwingSources; label: string; tip: string }[] = [
  { key: "kills", label: "Kills", tip: "Win chance your own kills add, trade kills apart." },
  { key: "trades", label: "Trades", tip: "Win chance your trade kills add." },
  { key: "damage", label: "Damage", tip: "Your damage's share of teammates' kills." },
  { key: "flashes", label: "Flash assists", tip: "Win chance your flashes add to teammates' kills." },
  { key: "deaths", label: "Deaths", tip: "Win chance your deaths cost." },
  { key: "roundEnd", label: "Round end", tip: "What is left of the round's swing when it ends." },
];

/**
 * Round swing by source (stats/swing.ts swingSources) as a waterfall: each source's bar starts where
 * the one before it ended, and the last bar is the total, which is the swing the card above carries.
 * Values are percentage points per valued round; gains and losses take the performance colours. The
 * bots' column is the same split for the bots in the same matches.
 */
export function SwingSourcesChart({ you, bots }: { you: SwingSources; bots: SwingSources | null }) {
  let run = 0;
  const steps = SOURCES.map((s) => { const from = run; run += you[s.key]; return { ...s, v: you[s.key], from, to: run }; });
  const total = run;
  const lo = Math.min(0, ...steps.map((s) => Math.min(s.from, s.to)));
  const hi = Math.max(0, ...steps.map((s) => Math.max(s.from, s.to)));
  const span = hi - lo || 1;
  const x = (v: number) => (100 * (v - lo)) / span;
  const bar = (from: number, to: number, v: number) => (
    <span className="wfall__track" aria-hidden>
      <span className="wfall__zero" style={{ left: `${x(0)}%` }} />
      <i style={{ left: `${x(Math.min(from, to))}%`, width: `${Math.max(0.6, x(Math.max(from, to)) - x(Math.min(from, to)))}%`, background: scoreFill(v >= 0 ? 1 : -1) }} />
    </span>
  );
  const pts = (v: number) => fmtSwing(v / 100);
  return (
    <div className="wfall">
      <div className="wfall__head caps"><span>Source</span><span>Per round</span><span className="num">You</span>{bots && <span className="num" data-tip="Bots in the same matches." tabIndex={0}>Bots</span>}</div>
      <ul>
        {steps.map((s) => (
          <li key={s.key} className="wfall__row" data-bots={bots ? "" : undefined}>
            <span className="wfall__l" data-tip={s.tip} tabIndex={0}>{s.label}</span>
            {bar(s.from, s.to, s.v)}
            <b className="num" style={{ color: scoreText(toScore(s.v, 0, 3)) }}>{pts(s.v)}</b>
            {bots && <span className="num faint">{pts(bots[s.key])}</span>}
          </li>
        ))}
        <li className="wfall__row wfall__row--total" data-bots={bots ? "" : undefined}>
          <span className="wfall__l">Total</span>
          {bar(0, total, total)}
          <b className="num" style={{ color: scoreText(toScore(total, 0, 3)) }}>{pts(total)}</b>
          {bots && <span className="num faint">{pts(SOURCES.reduce((t, s) => t + bots[s.key], 0))}</span>}
        </li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- value rows

/** A metric's row: the engine's label and tooltip, its value, and its percentile against `population` when there is one. */
function Row({ id, value, p, population = "" }: { id: string; value: number; p?: Pct | null; population?: string }) {
  return (
    <MetricRow label={metric(id).label} value={fmtMetric(id, value)} pct={p?.pct ?? null} reason={p?.reason ?? null} kind="style"
      population={population} tip={tipOf(id)} approx={metric(id).status === "approx"} />
  );
}

const valueOf = (s: Rolled, id: string) => s.v[id] ?? null;

// ---------------------------------------------------------------- aggression

const AGGRO_PARTS = ["peekTravel", "duelExposure", "firedFirst", "engageDistance"];
/** The score's scale on the track: this many pro standard deviations each way fills it. */
const AGGRO_SD = 2;

/**
 * How aggressively you take fights (stats/aggro-scale.ts aggressionScore: the four parts combined, in
 * pro standard deviations, 0 the pros' mean), on a passive-to-aggressive track with the pros' mean at
 * the tick, then the four parts' values. The parts have pro baselines, but the worker ranks only
 * performance metrics against pros (ranking.ts compare), so they show values without a track.
 * Every part needs line of sight; without it the panel does not render.
 */
export function AggressionCard({ s }: { s: Rolled }) {
  const score = valueOf(s, "aggressionScore");
  const parts = AGGRO_PARTS.map((id) => ({ id, v: valueOf(s, id) }));
  if (score === null && parts.every((p) => p.v === null)) return null;
  const at = score === null ? null : 50 + (50 * Math.max(-AGGRO_SD, Math.min(AGGRO_SD, score))) / AGGRO_SD;
  return (
    <Card title="Aggression" tip="How you take fights, against the pros' average." className="aggro">
      <div className="aggro__scale">
        <span className="caps">Passive</span>
        <DotTrack at={at} tone="cream" label={score === null ? "No aggression score" : `Aggression ${score.toFixed(2)} pro standard deviations from the pros' average`} />
        <span className="caps">Aggressive</span>
      </div>
      <p className="aggro__score">
        <b className="num">{score === null ? "–" : `${score > 0 ? "+" : score < 0 ? "−" : ""}${Math.abs(score).toFixed(2)}`}</b>
        <span className="meta" data-tip={tipOf("aggressionScore")} tabIndex={0}>pro SDs from the pros' average</span>
      </p>
      <MetricList label="Aggression parts">{parts.map((p) => (p.v === null ? null : <Row key={p.id} id={p.id} value={p.v} />))}</MetricList>
    </Card>
  );
}

// ---------------------------------------------------------------- economy

/**
 * How you buy (stats/buying.ts): your equipment against your team's, and the gear you keep after
 * surviving a loss. Both rank against the bots in your matches (style call), the only population the
 * worker ranks identity metrics in, so the tick is the bots' median.
 */
export function EconomyCard({ q, s, side }: { q: Query; s: Rolled; side: "both" | "T" | "CT" }) {
  const style = useCall("style", [q, { side }]).data;
  const ids = ["buyDeviation", "saveConversion"];
  const rows = ids.map((id) => ({ id, v: valueOf(s, id), p: (style?.p[id] ?? null) as Pct | null }));
  if (rows.every((r) => r.v === null)) return null;
  return (
    <Card title="Economy" tip="How you spend, against the bots in your matches." className="econ" aside={<span className="meta">Mid tick: bots</span>}>
      <MetricList label="Economy">
        {rows.map((r) => (r.v === null ? null : <Row key={r.id} id={r.id} value={r.v} p={r.p} population="the bots in your matches" />))}
      </MetricList>
    </Card>
  );
}
