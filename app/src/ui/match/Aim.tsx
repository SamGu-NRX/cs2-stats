// Aim, Leetify-style: a group of its own next to HLTV's seven attributes. Shared by the match page
// and the profile; every stat splits by side and weapon class.
import { useState } from "react";
import { engFor, GUN_CLASSES, shotsFor, SPRAY_FROM_IDX, SPRAY_MAX_IDX, type AimAgg, type ClassFilter, type ShotStats, type SideFilter } from "../../stats/aim";
import { AIM_STATS, CLASS_LABEL } from "./aimStats";
import { AimTile } from "./AimTile";
import { Histogram, SprayChart } from "../charts";
import { Segmented } from "../Segmented";
import type { TabProps } from "./MatchPage";

function ControlChart({ s }: { s: ShotStats }) {
  const pts = s.ctrlN.map((n, i) => ({ i, v: n ? s.ctrlSum[i] / n : null })).filter((p) => p.v !== null) as { i: number; v: number }[];
  if (pts.length < 2) return <p className="note">Not enough bursts with a target to chart.</p>;
  const max = Math.max(1, ...pts.map((p) => p.v)) * 1.1;
  const X = (i: number) => (i / (SPRAY_MAX_IDX - 1)) * 100;
  const Y = (v: number) => 60 - (v / max) * 56;
  return (
    <figure className="hist" style={{ margin: 0 }}>
      <figcaption className="hist__cap"><span>Distance from target by bullet</span><span className="muted">degrees · lower is better</span></figcaption>
      <svg viewBox="0 0 100 62" preserveAspectRatio="none" role="img" aria-label={`Spray control by bullet: ${pts.map((p) => `bullet ${p.i + 1} ${p.v.toFixed(1)} degrees`).join(", ")}`}>
        <line x1={X(SPRAY_FROM_IDX - 1)} x2={X(SPRAY_FROM_IDX - 1)} y1="0" y2="62" stroke="rgba(60,60,67,.18)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        <polyline points={pts.map((p) => `${X(p.i)},${Y(p.v)}`).join(" ")} fill="none" stroke="var(--c-blue)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="hist__axis num"><span>bullet 1</span><span>spray from bullet {SPRAY_FROM_IDX}</span><span>{SPRAY_MAX_IDX}</span></div>
    </figure>
  );
}

export function AimPanels({ a }: { a: AimAgg }) {
  const [side, setSide] = useState<SideFilter>("all");
  const [cls, setCls] = useState<ClassFilter>("all");
  const s = shotsFor(a, side, cls);
  const eng = engFor(a, side);
  const classes = GUN_CLASSES.filter((c) => shotsFor(a, side, c).shots > 0 || shotsFor(a, side, c).kills > 0);
  const validating = !a.validated;
  return (
    <>
      <div className="tabs">
        <Segmented size="sm" label="Side" value={side} onChange={setSide} options={[{ value: "all", label: "Both sides" }, { value: "t", label: "T" }, { value: "ct", label: "CT" }]} />
        <Segmented size="sm" label="Weapon class" value={cls} onChange={setCls}
          options={[{ value: "all" as ClassFilter, label: "All guns" }, ...GUN_CLASSES.map((c) => ({ value: c as ClassFilter, label: CLASS_LABEL[c], disabled: !classes.includes(c) }))]} />
      </div>
      <section className="glass card" aria-label="Aim">
        <div className="card__head">
          <h2 className="card__title">Aim</h2>
          <span className="note">{s.shots} shots · {s.kills} kills · Leetify-style, separate from the HLTV attributes</span>
        </div>
        <div className="tiles tiles--aim">
          {AIM_STATS.map((st) => <AimTile key={st.id} st={st} s={s} validated={a.validated} />)}
        </div>
      </section>
      {classes.length > 1 && (
        <section className="glass card" aria-label="Aim by weapon class">
          <div className="card__head"><h2 className="card__title">By weapon class</h2><span className="note">{side === "all" ? "both sides" : side.toUpperCase()}</span></div>
          <div className="tbl-wrap">
            <table className="tbl tbl--auto">
              <thead><tr><th>Class</th><th>Shots</th>{AIM_STATS.slice(0, 9).map((st) => <th key={st.id} tabIndex={0} data-tip={st.tip}>{st.label}</th>)}</tr></thead>
              <tbody>
                {classes.map((c) => {
                  const cs = shotsFor(a, side, c);
                  return <tr key={c}><td>{CLASS_LABEL[c]}</td><td>{cs.shots}</td>{AIM_STATS.slice(0, 9).map((st) => <td key={st.id}>{st.value(cs)}</td>)}</tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <section className="glass card" aria-label="When an enemy appears">
        <div className="card__head">
          <h2 className="card__title">When an enemy appears</h2>
          {validating
            ? <span className="pill pill--warn has-tip" tabIndex={0} data-tip="These timings depend on the plugin's visibility detection, which is still being checked against the game. They are shown, but treat them as provisional until the plugin marks visibility as validated.">Validating</span>
            : <span className="note">{eng.n} engagements</span>}
        </div>
        <div className={`hists ${validating ? "is-validating" : ""}`}>
          <div data-tip="Time from an enemy becoming visible to your first damage on them." className="has-tip" tabIndex={0}><Histogram h={eng.ttd} unit="ms" label="Time to damage" /></div>
          <div data-tip="Time from an enemy becoming visible to the first tick your aim moves toward them at 30°/s or faster." className="has-tip" tabIndex={0}><Histogram h={eng.react} unit="ms" label="Reaction time" /></div>
          <div data-tip="Angle between your crosshair and the enemy's head at the moment they became visible. Lower means better crosshair placement." className="has-tip" tabIndex={0}><Histogram h={eng.xhair} unit="°" label="Crosshair placement" color="var(--c-green)" /></div>
        </div>
      </section>
      <section className="glass card" aria-label="Spray">
        <div className="card__head"><h2 className="card__title">Spray</h2><span className="note">Where your bullets landed, bullet by bullet</span></div>
        <div className="grid-2">
          <SprayChart spray={a.spray} />
          <ControlChart s={s} />
        </div>
      </section>
    </>
  );
}

export default function Aim({ v }: TabProps) {
  if (!v.aim) {
    return <div className="glass card empty"><h2>No aim data in this match</h2><p>The capture plugin records aim for matches it captures from the start. Converted legacy matches have none.</p></div>;
  }
  return <AimPanels a={v.aim} />;
}
