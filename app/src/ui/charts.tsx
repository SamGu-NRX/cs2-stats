// Hand-drawn SVG charts. Kept small on purpose: a chart library would outweigh the whole app.
import { useMemo, useState } from "react";
import { histMedian, type AimAgg, type Hist, type SprayStep } from "../stats/aim";
import { weaponLabel } from "../stats/weapons";
import { Segmented } from "./Segmented";

export function Histogram({ h, unit, label, color = "var(--c-blue)" }: { h: Hist; unit: string; label: string; color?: string }) {
  const bins = [...h.bins, h.over];
  const max = Math.max(1, ...bins);
  const med = histMedian(h);
  const W = 100;
  const H = 60;
  const bw = W / bins.length;
  const medX = med === null ? null : ((med - h.lo) / (h.step * h.bins.length)) * (W - bw);
  return (
    <figure className="hist">
      <figcaption className="hist__cap">
        <span>{label}</span>
        <b className="num">{med === null ? "–" : `${unit === "°" ? med.toFixed(1) : Math.round(med)}${unit === "°" ? "°" : ` ${unit}`}`}</b>
        <span className="muted">median · {h.n} samples</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: median ${med === null ? "none" : med.toFixed(1)} ${unit}, ${h.n} samples`}>
        {bins.map((b, i) => {
          const hh = (b / max) * (H - 2);
          return <rect key={i} x={i * bw + 0.15} y={H - hh} width={bw - 0.3} height={hh} fill={i === h.bins.length ? "rgba(60,60,67,.3)" : color} opacity={0.85} />;
        })}
        {medX !== null && <line x1={medX} x2={medX} y1="0" y2={H} stroke="var(--text-1)" strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="hist__axis num"><span>{h.lo}</span><span>{h.lo + h.step * h.bins.length}{unit === "°" ? "°" : ` ${unit}`}+</span></div>
    </figure>
  );
}

const sd = (n: number, s: number, ss: number) => (n > 1 ? Math.sqrt(Math.max(0, ss / n - (s / n) ** 2)) : 0);

/**
 * Spray pattern for one weapon: mean bullet impact by bullet index (Source yaw grows to the left
 * and pitch grows downward, so x = −yaw and y = pitch puts the pattern the way it looks in game),
 * an ellipse of ±1 standard deviation per bullet, and the mean aim error to the target in orange.
 */
export function SprayChart({ spray }: { spray: AimAgg["spray"] }) {
  const weapons = useMemo(
    () => Object.entries(spray).map(([w, steps]) => ({ w, n: steps.reduce((a, s) => a + s.n, 0) })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 5),
    [spray],
  );
  const [pick, setPick] = useState<string | null>(null);
  const w = pick ?? weapons[0]?.w;
  if (!w) return <p className="note">No bullet impacts recorded.</p>;
  const steps = spray[w].map((s, i) => ({ s, i })).filter(({ s }) => s.n > 0) as { s: SprayStep; i: number }[];
  const pts = steps.map(({ s, i }) => ({ i, x: -s.sy / s.n, y: s.sp / s.n, rx: sd(s.n, s.sy, s.syy), ry: sd(s.n, s.sp, s.spp), n: s.n, e: s.en ? { x: -s.ey / s.en, y: s.ep / s.en } : null }));
  const ext = Math.max(1, ...pts.flatMap((p) => [Math.abs(p.x) + p.rx, Math.abs(p.y) + p.ry, p.e ? Math.abs(p.e.x) : 0, p.e ? Math.abs(p.e.y) : 0])) * 1.1;
  const S = 100 / (2 * ext);
  const X = (x: number) => 50 + x * S;
  const Y = (y: number) => 50 + y * S;
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <Segmented size="sm" label="Weapon" value={w} onChange={setPick} options={weapons.map((x) => ({ value: x.w, label: weaponLabel(x.w) }))} />
      </div>
      <div className="spray">
        <svg viewBox="0 0 100 100" role="img" aria-label={`${weaponLabel(w)} spray pattern over ${pts.length} bullet positions`}>
          <line x1="50" x2="50" y1="0" y2="100" stroke="rgba(60,60,67,.12)" />
          <line x1="0" x2="100" y1="50" y2="50" stroke="rgba(60,60,67,.12)" />
          {pts.map((p) => <ellipse key={`e${p.i}`} cx={X(p.x)} cy={Y(p.y)} rx={Math.max(0.4, p.rx * S)} ry={Math.max(0.4, p.ry * S)} fill="rgba(0,122,255,.07)" stroke="rgba(0,122,255,.25)" strokeWidth="0.3" />)}
          <polyline points={pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")} fill="none" stroke="var(--c-blue)" strokeWidth="0.6" strokeLinejoin="round" />
          {pts.map((p) => (
            <g key={p.i}>
              <circle cx={X(p.x)} cy={Y(p.y)} r="1.4" fill="var(--c-blue)" />
              {(p.i === 0 || (p.i + 1) % 5 === 0) && <text x={X(p.x) + 2.2} y={Y(p.y) + 1} fontSize="3.4" fill="var(--text-2)">{p.i + 1}</text>}
              {p.e && <circle cx={X(p.e.x)} cy={Y(p.e.y)} r="0.9" fill="var(--c-orange)" />}
            </g>
          ))}
        </svg>
        <div className="spray__legend note">
          <p><i className="sw" style={{ background: "var(--c-blue)" }} /> Mean impact per bullet, numbered; ellipse = ±1 standard deviation.</p>
          <p><i className="sw" style={{ background: "var(--c-orange)" }} /> Mean aim error: where the target's head was, relative to your crosshair.</p>
          <p>Scale: ±{ext.toFixed(1)}° from the crosshair at the centre.</p>
        </div>
      </div>
    </div>
  );
}
