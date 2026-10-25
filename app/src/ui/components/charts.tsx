// Hand-drawn SVG charts. Every chart labels its extremes, marks your average and, where one exists,
// a reference line (rating 1.00, a benchmark). Charts never replay an entrance on tab switch,
// filter or refresh.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ratingScore, scoreFill, scoreText } from "../lib/scale";

// ---------------------------------------------------------------- shared

/** Measures an element's width so SVG text stays at true pixel size (no viewBox stretching). */
export function useWidth<T extends HTMLElement>(fallback = 600): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e.contentRect.width))));
    ro.observe(el);
    setW(Math.max(120, Math.floor(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------------------------------------------------------- form bars

export interface FormBar { key: string; value: number | null; label: string; sub?: string; result?: "W" | "L" | "T"; onClick?: () => void; tip?: string }

/**
 * Ratings as bars around 1.00: above the line grows up in green, below grows down in red, so a
 * glance shows good and bad games. The best and worst are labelled; the average is a dashed line.
 */
export function FormBars({ bars, height = 120, refValue = 1, fmt = (v: number) => v.toFixed(2), score = ratingScore, avgValue, avgLabel = "avg" }: { bars: FormBar[]; height?: number; refValue?: number; fmt?: (v: number) => string; score?: (v: number) => number; avgValue?: number | null; avgLabel?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vals = bars.map((b) => b.value).filter((v): v is number => v !== null);
  if (!vals.length) return <div ref={ref} />;
  const hi = Math.max(refValue + 0.5, ...vals);
  const lo = Math.min(refValue - 0.5, ...vals, 0);
  const top = 16;
  const bottom = 34;
  const ih = height - top - bottom;
  const Y = (v: number) => top + ((hi - v) / (hi - lo)) * ih;
  const n = bars.length;
  const slot = w / Math.max(n, 1);
  const bw = Math.min(28, slot * 0.62);
  // the reference line: a caller-supplied aggregate (e.g. a pooled rating) or the mean of the bars
  const avg = avgValue ?? vals.reduce((a, v) => a + v, 0) / vals.length;
  const best = Math.max(...vals);
  const worst = Math.min(...vals);
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label={`Ratings, oldest to newest: ${bars.map((b) => `${b.label} ${b.value === null ? "none" : fmt(b.value)}`).join(", ")}`}>
        <line x1="0" x2={w} y1={Y(refValue)} y2={Y(refValue)} stroke="var(--line2)" />
        <line x1="0" x2={w} y1={Y(avg)} y2={Y(avg)} stroke="var(--cream)" strokeDasharray="3 3" opacity="0.5" />
        <text x={w} y={Y(avg) - 4} textAnchor="end" className="ax ax--cream">{avgLabel} {fmt(avg)}</text>
        {bars.map((b, i) => {
          if (b.value === null) return null;
          const x = i * slot + (slot - bw) / 2;
          const y0 = Y(refValue);
          const y1 = Y(b.value);
          const t = score(b.value);
          const extreme = b.value === best || b.value === worst;
          return (
            <g key={b.key} className={b.onClick ? "bar-link" : undefined} onClick={b.onClick} data-tip={b.tip}>
              <rect x={i * slot} y={top} width={slot} height={ih} fill="transparent" />
              <rect x={x} y={Math.min(y0, y1)} width={bw} height={Math.max(2, Math.abs(y1 - y0))} rx="2" fill={scoreFill(t)} opacity={0.35 + 0.65 * Math.min(1, Math.abs(t) + 0.2)} />
              {extreme && <text x={x + bw / 2} y={b.value >= refValue ? y1 - 4 : Math.min(y1 + 12, height - bottom - 2)} textAnchor="middle" className="ax ax--strong" style={{ fill: scoreText(t) }}>{fmt(b.value)}</text>}
              <text x={x + bw / 2} y={height - 5} textAnchor="middle" className={`ax ${b.result === "W" ? "ax--cream" : ""}`}>{b.sub ?? ""}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- trend line

export interface TrendPoint { key: string; value: number | null; label: string }

/** Values over matches with your average, a benchmark, and the best and worst points labelled. */
export function TrendLine({ points, fmt, height = 140, bench, benchLabel = "ref", lowerIsBetter, color = "var(--cream)", avgValue, avgLabel = "avg" }: { points: TrendPoint[]; fmt: (v: number) => string; height?: number; bench?: number; benchLabel?: string; lowerIsBetter?: boolean; color?: string; avgValue?: number | null; avgLabel?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (vals.length === 0) return <div ref={ref} className="chart chart--empty">No values yet</div>;
  const lo0 = Math.min(...vals, bench ?? Infinity);
  const hi0 = Math.max(...vals, bench ?? -Infinity);
  const pad = (hi0 - lo0 || Math.abs(hi0) || 1) * 0.18;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const left = 8;
  const right = 8;
  const top = 18;
  const bottom = 20;
  const X = (i: number) => left + (points.length === 1 ? (w - left - right) / 2 : (i / (points.length - 1)) * (w - left - right));
  const Y = (v: number) => top + ((hi - v) / (hi - lo)) * (height - top - bottom);
  const avg = avgValue ?? vals.reduce((a, v) => a + v, 0) / vals.length;
  const best = lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
  const worst = lowerIsBetter ? Math.max(...vals) : Math.min(...vals);
  const path = points.map((p, i) => (p.value === null ? null : `${X(i)},${Y(p.value)}`)).filter(Boolean).join(" ");
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label={`Trend: ${points.map((p) => `${p.label} ${p.value === null ? "none" : fmt(p.value)}`).join(", ")}`}>
        {bench !== undefined && (
          <g>
            <line x1="0" x2={w} y1={Y(bench)} y2={Y(bench)} stroke="var(--ink3)" strokeDasharray="3 3" />
            <text x={w - 2} y={Y(bench) + 12} textAnchor="end" className="ax">{benchLabel} {fmt(bench)}</text>
          </g>
        )}
        <line x1="0" x2={w} y1={Y(avg)} y2={Y(avg)} stroke="var(--cream)" strokeDasharray="2 4" opacity="0.45" />
        <text x="2" y={Y(avg) - 4} className="ax ax--cream">{avgLabel} {fmt(avg)}</text>
        <polyline points={path} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => {
          if (p.value === null) return null;
          const ext = p.value === best || p.value === worst;
          const good = p.value === best;
          return (
            <g key={p.key}>
              <circle cx={X(i)} cy={Y(p.value)} r={ext ? 3.5 : 2.5} fill={ext ? (good ? "var(--good-text)" : "var(--poor-text)") : color} stroke="var(--bg1)" strokeWidth="1.5" />
              {ext && vals.length > 1 && <text x={X(i)} y={Y(p.value) + (good !== !!lowerIsBetter ? -8 : 14)} textAnchor="middle" className="ax ax--strong" style={{ fill: good ? "var(--good-text)" : "var(--poor-text)" }}>{fmt(p.value)}</text>}
            </g>
          );
        })}
        {points.length > 1 && <text x={X(0)} y={height - 4} className="ax">{points[0].label}</text>}
        <text x={X(points.length - 1)} y={height - 4} textAnchor="end" className="ax">{points[points.length - 1].label}</text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- diverging bars

export interface DivRow { key: string; label: ReactNode; value: number | null; text: string; side?: "us" | "them"; highlight?: boolean }

/** Horizontal bars around zero: green to the right, red to the left, value at the bar end. */
export function DivergingBars({ rows, cap }: { rows: DivRow[]; cap: number }) {
  const max = Math.max(cap, ...rows.map((r) => Math.abs(r.value ?? 0)));
  return (
    <div className="divbars" role="list">
      {rows.map((r) => {
        const v = r.value ?? 0;
        const pct = (Math.abs(v) / max) * 50;
        const t = Math.max(-1, Math.min(1, v / cap));
        return (
          <div key={r.key} className={`divbars__row ${r.highlight ? "is-you" : ""}`} role="listitem">
            <span className="divbars__label">{r.label}</span>
            <span className="divbars__track">
              <i className="divbars__axis" />
              {r.value !== null && <i className="divbars__bar" style={{ left: v >= 0 ? "50%" : `${50 - pct}%`, width: `${pct}%`, background: scoreFill(t), opacity: 0.4 + 0.6 * Math.abs(t) }} />}
            </span>
            <span className="divbars__v num" style={{ color: r.value === null ? "var(--ink3)" : scoreText(t) }}>{r.text}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- attribute radar

/**
 * Seven-axis radar: you (cream, filled) and a comparison (dashed). When the comparison changes, its
 * polygon lerps from where it is now (320 ms, ease-in-out); with reduced motion it jumps.
 */
export function AttrRadar({ labels, you, other, otherLabel, size = 260 }: { labels: string[]; you: (number | null)[]; other: (number | null)[] | null; otherLabel?: string; size?: number }) {
  const n = labels.length;
  const c = size / 2;
  const R = c - 62;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + Math.cos(a) * R * (v / 100), c + Math.sin(a) * R * (v / 100)] as const;
  };
  const target = (other ?? []).map((v) => v ?? 0);
  const [shown, setShown] = useState<number[]>(target);
  const cur = useRef<number[]>(target);
  useEffect(() => {
    if (!other) return;
    const from = cur.current.length === target.length ? [...cur.current] : target.map(() => 0);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { cur.current = target; setShown(target); return; }
    const t0 = performance.now();
    const D = 320;
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / D);
      const e = ease(t);
      const next = target.map((v, i) => from[i] + (v - from[i]) * e);
      cur.current = next;
      setShown(next);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [other?.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const poly = (vals: number[]) => vals.map((v, i) => pt(i, v).join(",")).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Attribute shape: ${labels.map((l, i) => `${l} you ${you[i] === null ? "none" : Math.round(you[i]!)}${other ? `, ${otherLabel} ${other[i] ?? "none"}` : ""}`).join("; ")}`} className="radar">
      {[25, 50, 75, 100].map((r) => <polygon key={r} points={poly(labels.map(() => r))} fill="none" stroke="var(--line)" />)}
      {labels.map((_, i) => { const [x, y] = pt(i, 100); return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="var(--line)" />; })}
      {other && <polygon points={poly(shown)} fill="rgba(163,167,164,.08)" stroke="var(--ink2)" strokeDasharray="4 3" strokeWidth="1.5" />}
      <polygon points={poly(you.map((v) => v ?? 0))} fill="rgba(255,215,173,.14)" stroke="var(--cream)" strokeWidth="1.75" strokeLinejoin="round" />
      {you.map((v, i) => { const [x, y] = pt(i, v ?? 0); return <circle key={i} cx={x} cy={y} r="2.5" fill="var(--cream)" />; })}
      {labels.map((l, i) => {
        const [x, y] = pt(i, 116);
        return <text key={l} x={x} y={y + 4} textAnchor={Math.abs(x - c) < 4 ? "middle" : x > c ? "start" : "end"} className="ax ax--label">{l}</text>;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- HLTV gauge

let gaugeWoke = false;

/**
 * The card's gauge: a 240° arc filled to rating / 2, green when good, grey when average, red when
 * poor. On the first view of the session the arc draws and the number counts up (600 ms); after
 * that it is static, and a side switch only recolours it.
 */
export function Gauge({ value, verdict, label, size = 176 }: { value: number | null; verdict: "good" | "avg" | "poor" | "na"; label: ReactNode; size?: number }) {
  const sweep = 240;
  const r = size / 2 - 10;
  const c = size / 2;
  const len = (Math.PI * 2 * r * sweep) / 360;
  const frac = value === null ? 0 : Math.max(0, Math.min(1, value / 2));
  const [wake] = useState(() => !gaugeWoke && value !== null && !matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [shown, setShown] = useState(wake ? 0 : value ?? 0);
  useEffect(() => {
    if (value === null) return;
    if (!wake) { setShown(value); return; }
    gaugeWoke = true;
    const t0 = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 600);
      setShown(value * ease(t));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = 90 + (360 - sweep) / 2;
  const arc = (deg: number) => {
    const a = (Math.PI / 180) * deg;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const [sx, sy] = arc(start);
  const [ex, ey] = arc(start + sweep);
  const d = `M${sx} ${sy} A${r} ${r} 0 1 1 ${ex} ${ey}`;
  const stroke = verdict === "good" ? "var(--good)" : verdict === "poor" ? "var(--poor)" : "var(--avg)";
  return (
    <div className="gauge" style={{ width: size, height: size * 0.8 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <path d={d} fill="none" stroke="var(--track)" strokeWidth="7" strokeLinecap="round" />
        <path d={d} fill="none" stroke={stroke} strokeWidth="7" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - frac)} className={wake ? "gauge__arc gauge__arc--wake" : "gauge__arc"} style={{ transition: "stroke var(--d-color) ease" }} />
      </svg>
      <div className="gauge__in">
        <span className="verdict" data-v={verdict}>{verdict === "na" ? "" : verdict === "avg" ? "Average" : verdict === "good" ? "Good" : "Poor"}</span>
        <b className="gauge__v num">{value === null ? "–" : shown.toFixed(2)}</b>
        <span className="gauge__l">{label}</span>
      </div>
    </div>
  );
}
