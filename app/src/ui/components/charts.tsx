// Hand-drawn SVG charts. Every chart labels its extremes, marks your average and, where one exists,
// a reference line (rating 1.00, a benchmark). Charts never replay an entrance on tab switch,
// filter or refresh.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  const avg = avgValue ?? vals.reduce((a, v) => a + v, 0) / vals.length;
  // A gutter on the right holds the reference labels, so they never sit on the data. It is as wide as
  // the longer label (about 6.2 px a character in the 11 px axis font, an estimate, not a measurement),
  // at least 84 px: a fixed 84 cut "average player 1.00" off at the card's edge.
  const longest = Math.max(`${avgLabel} ${fmt(avg)}`.length, bench === undefined ? 0 : `${benchLabel} ${fmt(bench)}`.length);
  const right = Math.max(84, Math.ceil(10 + 6.2 * longest));
  const top = 18;
  const bottom = 20;
  const X = (i: number) => left + (points.length === 1 ? (w - left - right) / 2 : (i / (points.length - 1)) * (w - left - right));
  const Y = (v: number) => top + ((hi - v) / (hi - lo)) * (height - top - bottom);
  const best = lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
  const worst = lowerIsBetter ? Math.max(...vals) : Math.min(...vals);
  const path = points.map((p, i) => (p.value === null ? null : `${X(i)},${Y(p.value)}`)).filter(Boolean).join(" ");
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label={`Trend: ${points.map((p) => `${p.label} ${p.value === null ? "none" : fmt(p.value)}`).join(", ")}`}>
        {bench !== undefined && (
          <g>
            <line x1="0" x2={w - right} y1={Y(bench)} y2={Y(bench)} stroke="var(--ink3)" strokeDasharray="3 3" />
            <text x={w - right + 6} y={Y(bench) + 4 + (Math.abs(Y(bench) - Y(avg)) < 12 ? 12 : 0)} className="ax">{benchLabel} {fmt(bench)}</text>
          </g>
        )}
        <line x1="0" x2={w - right} y1={Y(avg)} y2={Y(avg)} stroke="var(--cream)" strokeDasharray="2 4" opacity="0.45" />
        <text x={w - right + 6} y={Y(avg) + 4} className="ax ax--cream">{avgLabel} {fmt(avg)}</text>
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
/**
 * Your six style scores against another player's, on one radar. Picking another player morphs their
 * shape: a CSS transition on the path's `d` (--d-expand, --ease-out in tokens.css), which retargets from
 * the shape on screen when a new pick interrupts it. A keyboard pick (`instant`) and reduced motion swap
 * the shape at once. A provisional score of yours draws its shape with a hatched fill.
 */
export function AttrRadar({ labels, you, other, otherLabel, size = 260, instant = false, provisional = false, provisionalTip }: {
  labels: string[]; you: (number | null)[]; other: (number | null)[] | null; otherLabel?: string; size?: number;
  /** swap the other shape without the morph (keyboard selection) */
  instant?: boolean;
  /** your scores rank against a still-small bot pool */
  provisional?: boolean;
  /** the tooltip a provisional shape opens on hover and focus */
  provisionalTip?: string;
}) {
  const n = labels.length;
  const c = size / 2;
  const R = c - 62;
  const hatch = `hatch${useId().replace(/:/g, "")}`;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + Math.cos(a) * R * (v / 100), c + Math.sin(a) * R * (v / 100)] as const;
  };
  const poly = (vals: number[]) => vals.map((v, i) => pt(i, v).join(",")).join(" ");
  // one M and n-1 L commands, so every shape has the same structure and `d` interpolates between them
  const path = (vals: number[]) => `M${vals.map((v, i) => pt(i, v).map((x) => x.toFixed(2)).join(" ")).join("L")}Z`;
  const otherD = other ? path(other.map((v) => v ?? 0)) : null;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Attribute shape: ${labels.map((l, i) => `${l} you ${you[i] === null ? "none" : Math.round(you[i]!)}${other ? `, ${otherLabel} ${other[i] ?? "none"}` : ""}`).join("; ")}`} className="radar" {...(provisional && provisionalTip ? { "data-tip": provisionalTip, tabIndex: 0 } : {})}>
      {provisional && (
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="rgba(255,215,173,.06)" /><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,215,173,.35)" strokeWidth="2" />
          </pattern>
        </defs>
      )}
      {[25, 50, 75, 100].map((r) => <polygon key={r} points={poly(labels.map(() => r))} fill="none" stroke="var(--line)" />)}
      {labels.map((_, i) => { const [x, y] = pt(i, 100); return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="var(--line)" />; })}
      {otherD && <path className={`radar__other ${instant ? "is-instant" : ""}`} d={otherD} style={{ d: `path("${otherD}")` } as CSSProperties} fill="rgba(163,167,164,.08)" stroke="var(--ink2)" strokeDasharray="4 3" strokeWidth="1.5" />}
      <polygon points={poly(you.map((v) => v ?? 0))} fill={provisional ? `url(#${hatch})` : "rgba(255,215,173,.14)"} stroke="var(--cream)" strokeWidth="1.75" strokeLinejoin="round" />
      {you.map((v, i) => { const [x, y] = pt(i, v ?? 0); return <circle key={i} cx={x} cy={y} r="2.5" fill="var(--cream)" />; })}
      {labels.map((l, i) => {
        const [x, y] = pt(i, 116);
        return <text key={l} x={x} y={y + 4} textAnchor={Math.abs(x - c) < 4 ? "middle" : x > c ? "start" : "end"} className="ax ax--label">{l}</text>;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- histogram

/** Samples put in bins for the histogram: `bins` counts from `lo` in steps of `step`, and those past the last bin. */
export interface Hist { lo: number; step: number; bins: number[]; over: number; n: number }

const NICE = [1, 2, 2.5, 5, 10];

/**
 * Bins from 0 to about the 90th percentile in ten or so round steps, with the rest in the overflow
 * bin, so one slow sighting does not flatten the shape. Layout only: the median drawn on the chart is
 * the engine's metric value, passed in.
 */
export function binSamples(xs: readonly number[], target = 10): Hist {
  if (!xs.length) return { lo: 0, step: 1, bins: [], over: 0, n: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const top = Math.max(sorted[Math.floor(0.9 * (sorted.length - 1))], 1e-9);
  const raw = top / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = mag * NICE.find((k) => k * mag >= raw)!;
  const bins = Array.from({ length: Math.max(1, Math.ceil(top / step)) }, () => 0);
  let over = 0;
  for (const x of xs) {
    const i = Math.floor(Math.max(0, x) / step);
    if (i < bins.length) bins[i]++;
    else over++;
  }
  return { lo: 0, step, bins, over, n: xs.length };
}

/**
 * A distribution with the median as a solid rule and an optional benchmark as a dashed one.
 * The overflow bin (values past the last bin) is drawn hatched at the right.
 */
export function Histogram({ h, med, unit, height = 120, bench, benchLabel, color = "var(--tan)", lowerIsBetter }: { h: Hist; med: number | null; unit: string; height?: number; bench?: number; benchLabel?: string; color?: string; lowerIsBetter?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  if (!h.n) return <div className="chart chart--empty">No samples yet</div>;
  const bins = [...h.bins, h.over];
  const max = Math.max(1, ...bins);
  const top = 18;
  const bottom = 18;
  const ih = height - top - bottom;
  const span = h.step * h.bins.length;
  const bw = w / bins.length;
  const X = (v: number) => Math.max(0, Math.min(w, ((v - h.lo) / span) * (w - bw)));
  const fmt = (v: number) => (unit === "°" ? `${v.toFixed(1)}°` : `${Math.round(v)}${unit}`);
  const peak = bins.indexOf(max);
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label={`Distribution, median ${med === null ? "none" : fmt(med)}, ${h.n} samples`}>
        {bins.map((b, i) => {
          const hh = (b / max) * ih;
          const isOver = i === h.bins.length;
          const mid = h.lo + (i + 0.5) * h.step;
          const good = bench === undefined ? true : lowerIsBetter ? mid <= bench : mid >= bench;
          return <rect key={i} x={i * bw + 1} y={top + ih - hh} width={Math.max(1, bw - 2)} height={hh} rx="1.5" fill={isOver ? "url(#hatch)" : color} opacity={isOver ? 1 : good ? 0.95 : 0.5} />;
        })}
        {peak >= 0 && max > 0 && <text x={peak * bw + bw / 2} y={top - 4} textAnchor="middle" className="ax">{max}</text>}
        {bench !== undefined && (
          <g>
            <line x1={X(bench)} x2={X(bench)} y1={top - 6} y2={top + ih} stroke="var(--ink2)" strokeDasharray="3 3" />
            <text x={X(bench) + 4} y={top - 6} className="ax">{benchLabel ?? "ref"} {fmt(bench)}</text>
          </g>
        )}
        {med !== null && (
          <g>
            <line x1={X(med)} x2={X(med)} y1={top - 2} y2={top + ih} stroke="var(--cream)" strokeWidth="1.5" />
            <text x={X(med) - 4} y={top + 10} textAnchor="end" className="ax ax--cream ax--strong">median {fmt(med)}</text>
          </g>
        )}
        <line x1="0" x2={w} y1={top + ih} y2={top + ih} stroke="var(--line2)" />
        <text x="0" y={height - 4} className="ax">{fmt(h.lo)}</text>
        <text x={w} y={height - 4} textAnchor="end" className="ax">{fmt(h.lo + span)}+</text>
        <defs>
          <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="var(--bg2)" /><line x1="0" y1="0" x2="0" y2="4" stroke="var(--track)" strokeWidth="2" />
          </pattern>
        </defs>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- spray pattern

/**
 * Places bullet-number labels so they cover no dot and no other label: each label tries eight
 * positions around its dot at two distances and takes the first clear one, with a leader line.
 */
function placeLabels(items: { i: number; x: number; y: number }[], dots: readonly (readonly [number, number])[], size: number) {
  const W = 18;
  const H = 12;
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  const hitsDot = (bx: number, by: number) => dots.some(([dx, dy]) => dx > bx - 5 && dx < bx + W + 5 && dy > by - 5 && dy < by + H + 5);
  const hitsBox = (bx: number, by: number) => boxes.some((o) => bx < o.x + o.w && bx + W > o.x && by < o.y + o.h && by + H > o.y);
  const dirs = [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
  return items.map((it) => {
    for (const r of [14, 26, 38]) {
      for (const [dx, dy] of dirs) {
        const cx = it.x + dx * r;
        const cy = it.y + dy * r;
        const bx = cx - W / 2;
        const by = cy - H / 2;
        if (bx < 0 || by < 0 || bx + W > size || by + H > size) continue;
        if (hitsDot(bx, by) || hitsBox(bx, by)) continue;
        boxes.push({ x: bx, y: by, w: W, h: H });
        return { i: it.i, ax: it.x, ay: it.y, lx: cx - dx * (W / 2 - 2), ly: cy - dy * (H / 2 - 2), tx: cx, ty: cy + 4, anchor: "middle" as const };
      }
    }
    return { i: it.i, ax: it.x, ay: it.y, lx: it.x, ly: it.y, tx: it.x + 8, ty: it.y - 6, anchor: "start" as const };
  });
}

/** A spray's view movement per bullet, from the engine's Summary.aim.path (index 0 is bullet 2). */
export interface SprayPath { n: number[]; dp: number[]; dy: number[] }
/** The pro reference per bullet (aim-ref.ts RECOIL path, index 0 is bullet 1): [pitch, yaw, pitchQ25, pitchQ75, yawQ25, yawQ75]. */
export type ProPath = readonly (readonly number[])[];

/** Your mean view movement from bullet 1, bullet by bullet (bullet 1 at the origin); bullets nobody reached are left out. */
export function meanPath(p: SprayPath): { i: number; pitch: number; yaw: number; n: number }[] {
  const out = [{ i: 0, pitch: 0, yaw: 0, n: p.n[0] ?? 0 }];
  p.n.forEach((n, j) => { if (n > 0) out.push({ i: j + 1, pitch: p.dp[j] / n, yaw: p.dy[j] / n, n }); });
  return out;
}

/** Sums of the squared view change per bullet (Summary.aim.spread), indexed as SprayPath. */
export interface SpraySpread { pp: number[]; yy: number[] }
/** Per-bullet sums with index 0 at bullet 1 (Summary.aim.heads and onTarget): bullets with a value and the summed pitch and yaw. */
export interface BulletSums { n: number[]; dp: number[]; dy: number[] }

/** Standard deviation from a count, a sum and a sum of squares; 0 under two values. */
const sd = (n: number, s: number, ss: number) => (n > 1 ? Math.sqrt(Math.max(0, ss / n - (s / n) ** 2)) : 0);

/** One standard deviation of your view movement per bullet, pitch and yaw, for the bullets in meanPath (bullet 1 has none). */
export function spreadOf(p: SprayPath, s: SpraySpread): { i: number; pitch: number; yaw: number }[] {
  return p.n.flatMap((n, j) => (n > 0 ? [{ i: j + 1, pitch: sd(n, p.dp[j], s.pp[j] ?? 0), yaw: sd(n, p.dy[j], s.yy[j] ?? 0) }] : []));
}

/** Mean per bullet of BulletSums (index 0 is bullet 1), bullets without a value left out. */
export function meanBullets(b: BulletSums): { i: number; pitch: number; yaw: number; n: number }[] {
  return b.n.flatMap((n, i) => (n > 0 ? [{ i, pitch: b.dp[i] / n, yaw: b.dy[i] / n, n }] : []));
}

/** Your average bullet counts as on target while it lands within this many degrees of the target's eye. */
export const CONTROL_DEG = 1.5;

/**
 * Bullet by bullet, how far your average bullet landed from the target's eye (the length of the mean
 * offset), for bullets with three or more values among the first 20; and the last bullet of the run from
 * bullet 1 that stayed within CONTROL_DEG (0 when bullet 1 missed or has no value).
 */
export function targetControl(b: BulletSums): { rows: { i: number; dev: number; n: number }[]; controlled: number } {
  const rows = meanBullets(b).filter((r) => r.n >= 3 && r.i < 20).map((r) => ({ i: r.i, dev: Math.hypot(r.pitch, r.yaw), n: r.n }));
  let controlled = 0;
  for (const r of rows) { if (r.i === controlled && r.dev <= CONTROL_DEG) controlled++; else break; }
  return { rows, controlled };
}

/**
 * Spray for one weapon: your mean view movement per bullet (x = −yaw, y = pitch, so pulling down
 * draws downward as in game); optionally its spread per bullet as a one-standard-deviation ellipse,
 * the median pro compensation path with the middle half of pros per bullet as a box, and where the
 * target's eye was for each bullet, in CT blue. 1° grid.
 */
export function SprayPattern({ path, pro, size = 320, bands = true, spread = null, heads = null }: { path: SprayPath; pro: ProPath | null; size?: number; bands?: boolean; spread?: SpraySpread | null; heads?: BulletSums | null }) {
  const pts = meanPath(path).map((p) => ({ i: p.i, x: -p.yaw, y: p.pitch }));
  const ref = pro && bands ? pro.slice(0, Math.max(pts.length, 1)).map((r, i) => ({ i, x: -r[1], y: r[0], x0: -r[5], x1: -r[4], y0: r[2], y1: r[3] })) : [];
  const sds = spread ? spreadOf(path, spread) : [];
  const ells = sds.map((e) => ({ ...e, x: pts.find((p) => p.i === e.i)!.x, y: pts.find((p) => p.i === e.i)!.y }));
  const eyes = heads ? meanBullets(heads).map((h) => ({ i: h.i, x: -h.yaw, y: h.pitch })) : [];
  if (pts.length < 2) return <div className="chart chart--empty">No sprays of three bullets or more</div>;
  const ext = Math.max(2, ...pts.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]), ...ref.flatMap((r) => [Math.abs(r.x0), Math.abs(r.x1), Math.abs(r.y0), Math.abs(r.y1)]),
    ...ells.flatMap((e) => [Math.abs(e.x) + e.yaw, Math.abs(e.y) + e.pitch]), ...eyes.flatMap((h) => [Math.abs(h.x), Math.abs(h.y)])) * 1.15;
  const S = size / (2 * ext);
  const X = (x: number) => size / 2 + x * S;
  const Y = (y: number) => size / 2 + y * S;
  const grid: number[] = [];
  for (let g = -Math.floor(ext); g <= Math.floor(ext); g++) grid.push(g);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="spray" role="img" aria-label={`Spray pattern over ${pts.length} bullets, ±${ext.toFixed(1)} degrees${ells.length ? ", with the spread per bullet" : ""}${ref.length ? ", with the pro path" : ""}${eyes.length ? ", with where the target's head was" : ""}`}>
      {grid.map((g) => (
        <g key={g}>
          <line x1={X(g)} x2={X(g)} y1="0" y2={size} stroke={g === 0 ? "var(--line2)" : "var(--line)"} />
          <line x1="0" x2={size} y1={Y(g)} y2={Y(g)} stroke={g === 0 ? "var(--line2)" : "var(--line)"} />
        </g>
      ))}
      {ells.map((e) => <ellipse key={`e${e.i}`} cx={X(e.x)} cy={Y(e.y)} rx={Math.max(2, e.yaw * S)} ry={Math.max(2, e.pitch * S)} fill="rgba(255,215,173,.07)" stroke="rgba(255,215,173,.42)" strokeWidth="1" />)}
      {ref.map((r) => <rect key={`b${r.i}`} x={X(Math.min(r.x0, r.x1))} y={Y(Math.min(r.y0, r.y1))} width={Math.max(2, Math.abs(r.x1 - r.x0) * S)} height={Math.max(2, Math.abs(r.y1 - r.y0) * S)} rx="2" fill="rgba(43,163,224,.07)" stroke="rgba(43,163,224,.4)" strokeWidth="1" />)}
      {ref.length > 1 && <polyline points={ref.map((r) => `${X(r.x)},${Y(r.y)}`).join(" ")} fill="none" stroke="var(--ct)" strokeWidth="1.25" strokeDasharray="3 3" opacity="0.85" />}
      <polyline points={pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")} fill="none" stroke="var(--cream)" strokeWidth="1.25" strokeLinejoin="round" opacity="0.8" />
      {eyes.map((h) => <circle key={`h${h.i}`} cx={X(h.x)} cy={Y(h.y)} r="2" fill="var(--ct)" opacity="0.8" />)}
      {pts.map((p) => <circle key={p.i} cx={X(p.x)} cy={Y(p.y)} r={p.i === 0 ? 4.5 : 3.5} fill={p.i === 0 ? "var(--bg1)" : "var(--cream)"} stroke="var(--cream)" strokeWidth="1.5" />)}
      {placeLabels(pts.filter((p) => p.i === 0 || (p.i + 1) % 5 === 0).map((p) => ({ i: p.i, x: X(p.x), y: Y(p.y) })), pts.map((p) => [X(p.x), Y(p.y)] as const), size).map((l) => (
        <g key={`l${l.i}`}>
          <line x1={l.ax} y1={l.ay} x2={l.lx} y2={l.ly} stroke="var(--ink3)" strokeWidth="1" />
          <text x={l.tx} y={l.ty} textAnchor={l.anchor} className="ax ax--strong spray__n">{l.i + 1}</text>
        </g>
      ))}
      <text x="6" y={size - 6} className="ax">1° grid</text>
    </svg>
  );
}

// ---------------------------------------------------------------- body hit map

export type BodyShare = { head: number; neck: number; chest: number; stomach: number; leftArm: number; rightArm: number; leftLeg: number; rightLeg: number };

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
