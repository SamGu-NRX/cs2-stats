// Per-match series in the v2 language (design-target-v2/SYSTEM.md, data-viz policy). Data decides the
// width: every match takes PITCH pixels and the chart left-aligns, so eight matches never stretch
// across a card. Under each match its W or L, under the axis the first, middle and last dates, as
// many of those as fit.
// - MatchLine: a line plus dots (Form, Rating by match), the pooled value as a dashed cream line, a
//   reference as a dotted grey one, the best and worst labelled and the last point ringed.
// - MatchLollipops: diverging values (round swing) as vertical lollipops from a dotted zero axis, on a
//   symmetric scale rounded up to a whole number, the mean as a dashed cream line, the best and worst
//   labelled and nothing else.
import type { ReactNode } from "react";
import { openMatch } from "../router";

/** Pixels per match. */
export const PITCH = 48;

export interface MatchPoint {
  key: string;
  value: number | null;
  /** the match's day, "Oct 24" */
  label: string;
  result?: "W" | "L" | "T";
  /** the match's page: the match's column becomes a link to it */
  href?: string;
}

const WL_H = 22;
const DATE_H = 16;

/** The W/L pips and the dates under a series; `x` places match i. */
function Foot({ points, x, top }: { points: MatchPoint[]; x: (i: number) => number; top: number }) {
  const n = points.length;
  // a date is about one PITCH wide: the middle one needs five matches and the last one three, or they overlap
  const dated = n >= 5 ? [0, Math.floor((n - 1) / 2), n - 1] : n >= 3 ? [0, n - 1] : [0];
  return (
    <g aria-hidden>
      {points.map((p, i) => p.result && (
        <g key={p.key} transform={`translate(${x(i) - 7} ${top + 4})`}>
          <rect width="14" height="14" rx="3" className={p.result === "W" ? "ms__w" : "ms__l"} />
          <text x="7" y="10.5" textAnchor="middle" className={`ms__wlt ${p.result === "W" ? "is-w" : ""}`}>{p.result}</text>
        </g>
      ))}
      {dated.map((i) => <text key={i} x={x(i)} y={top + WL_H + DATE_H - 3} textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"} className="ax">{points[i].label}</text>)}
    </g>
  );
}

/**
 * Each match's column as a link to it, one tab stop per match, named by its day and value. A click
 * opens the match as the match list does (router.ts openMatch); Enter follows the link.
 */
function Hits({ points, x, h, fmt }: { points: MatchPoint[]; x: (i: number) => number; h: number; fmt: (v: number) => string }) {
  return (
    <>
      {points.map((p, i) => p.href && (
        <a key={p.key} href={p.href} className="ms__hit" aria-label={`${p.label}${p.result ? `, ${p.result === "W" ? "won" : p.result === "L" ? "lost" : "tied"}` : ""}: ${p.value === null ? "none" : fmt(p.value)}`}
          onClick={(e) => { e.preventDefault(); openMatch(p.href!); }}>
          <rect x={x(i) - PITCH / 2} y="0" width={PITCH} height={h} rx="4" fill="transparent" />
        </a>
      ))}
    </>
  );
}

export function MatchLine({ points, fmt, pooled, refValue, refLabel, plot = 84, label }: {
  points: MatchPoint[];
  fmt: (v: number) => string;
  /** the pooled value, drawn as a dashed cream line */
  pooled: number | null;
  /** a reference (1.00, an average player), drawn as a dotted grey line */
  refValue?: number;
  refLabel?: string;
  /** the plot's height without the W/L row and the dates */
  plot?: number;
  label: string;
}) {
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (!vals.length) return <p className="meta">No rated matches yet.</p>;
  const lo0 = Math.min(...vals, refValue ?? Infinity, pooled ?? Infinity);
  const hi0 = Math.max(...vals, refValue ?? -Infinity, pooled ?? -Infinity);
  const pad = (hi0 - lo0 || 1) * 0.14;
  const top = 16;
  const Y = (v: number) => top + ((hi0 + pad - v) / (hi0 - lo0 + 2 * pad)) * (plot - top - 14);
  const left = PITCH / 2;
  const x = (i: number) => left + i * PITCH;
  const end = x(points.length - 1) + PITCH / 2;
  const w = end + 44;
  const h = plot + WL_H + DATE_H;
  const best = Math.max(...vals);
  const worst = Math.min(...vals);
  let lastAt = -1;
  points.forEach((p, i) => { if (p.value !== null) lastAt = i; });
  // one polyline per run of rated matches, so a match without a value is a gap, not a bridge
  const runs: string[][] = [[]];
  points.forEach((p, i) => {
    if (p.value === null) { if (runs[runs.length - 1].length) runs.push([]); }
    else runs[runs.length - 1].push(`${x(i)},${Y(p.value)}`);
  });
  return (
    <svg className="ms" width={w} height={h} role="img" aria-label={`${label}, oldest first: ${points.map((p) => `${p.label} ${p.value === null ? "none" : fmt(p.value)}`).join(", ")}`}>
      {refValue !== undefined && (
        <g>
          <line x1="0" x2={end} y1={Y(refValue)} y2={Y(refValue)} className="ms__ref" />
          <text x={end + 6} y={Y(refValue) + 4 + (pooled !== null && Math.abs(Y(refValue) - Y(pooled)) < 11 ? 9 : 0)} className="ax">{refLabel ?? fmt(refValue)}</text>
        </g>
      )}
      {pooled !== null && (
        <g>
          <line x1="0" x2={end} y1={Y(pooled)} y2={Y(pooled)} className="ms__mean" />
          <text x={end + 6} y={Y(pooled) + 4} className="ax ms__meanl">{fmt(pooled)}</text>
        </g>
      )}
      {runs.filter((r) => r.length > 1).map((r) => <polyline key={r[0]} points={r.join(" ")} className="ms__line" />)}
      {points.map((p, i) => {
        if (p.value === null) return null;
        const ext = vals.length > 1 && (p.value === best || p.value === worst);
        const good = p.value === best;
        return (
          <g key={p.key}>
            {i === lastAt
              ? <circle cx={x(i)} cy={Y(p.value)} r="4.5" className="ms__last" />
              : <circle cx={x(i)} cy={Y(p.value)} r={ext ? 3.5 : 3} className={ext ? (good ? "ms__dot is-good" : "ms__dot is-poor") : "ms__dot"} />}
            {ext && <text x={x(i) + 6} y={Y(p.value) + (good ? -6 : 13)} className={`ax ms__ext ${good ? "is-good" : "is-poor"}`}>{fmt(p.value)}</text>}
          </g>
        );
      })}
      <Foot points={points} x={x} top={plot} />
      <Hits points={points} x={x} h={plot} fmt={fmt} />
    </svg>
  );
}

/** A clean symmetric bound: the largest absolute value rounded up to a whole number, at least 1. */
export const symmetricMax = (vals: number[]) => Math.max(1, Math.ceil(Math.max(0, ...vals.map(Math.abs))));

export function MatchLollipops({ points, fmt, mean, plot = 128, label, axis = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}%` }: {
  /** values in display units (percent points) */
  points: MatchPoint[];
  fmt: (v: number) => string;
  /** the mean, drawn as a dashed cream line */
  mean: number | null;
  plot?: number;
  label: string;
  /** the scale's end labels */
  axis?: (v: number) => string;
}) {
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (!vals.length) return <p className="meta">No matches with swing yet.</p>;
  const max = symmetricMax(vals);
  const top = 14;
  const bottom = plot - 10;
  const zero = (top + bottom) / 2;
  const Y = (v: number) => zero - (v / max) * (bottom - top) / 2;
  const left = 40;
  const x = (i: number) => left + PITCH / 2 + i * PITCH;
  const end = x(points.length - 1) + PITCH / 2;
  const w = end + 74;
  const h = plot + WL_H + DATE_H;
  const best = Math.max(...vals);
  const worst = Math.min(...vals);
  const labelled = new Set([points.findIndex((p) => p.value === best), points.findIndex((p) => p.value === worst)]);
  return (
    <svg className="ms" width={w} height={h} role="img" aria-label={`${label}, oldest first, scale ±${max}%: ${points.map((p) => `${p.label} ${p.value === null ? "none" : fmt(p.value)}`).join(", ")}`}>
      <g aria-hidden>
        <text x={left - 8} y={top + 4} textAnchor="end" className="ax">{axis(max)}</text>
        <text x={left - 8} y={zero + 4} textAnchor="end" className="ax">0</text>
        <text x={left - 8} y={bottom + 4} textAnchor="end" className="ax">{axis(-max)}</text>
        <line x1={left} x2={end} y1={top} y2={top} className="ms__grid" />
        <line x1={left} x2={end} y1={bottom} y2={bottom} className="ms__grid" />
        <line x1={left} x2={end} y1={zero} y2={zero} className="ms__zero" />
      </g>
      {mean !== null && (
        <g>
          <line x1={left} x2={end} y1={Y(mean)} y2={Y(mean)} className="ms__mean" />
          <text x={end + 6} y={Y(mean) + 4} className="ax ms__meanl">avg {fmt(mean)}</text>
        </g>
      )}
      {points.map((p, i) => {
        if (p.value === null) return null;
        const pos = p.value >= 0;
        return (
          <g key={p.key} className={pos ? "is-good" : "is-poor"}>
            <line x1={x(i)} x2={x(i)} y1={zero} y2={Y(p.value)} className="ms__stem" />
            <circle cx={x(i)} cy={Y(p.value)} r="4.5" className="ms__pop" />
            {labelled.has(i) && vals.length > 1 && <text x={x(i)} y={pos ? Y(p.value) - 9 : Y(p.value) + 17} textAnchor="middle" className="ax ms__ext">{fmt(p.value)}</text>}
          </g>
        );
      })}
      <Foot points={points} x={x} top={plot} />
      <Hits points={points} x={x} h={plot} fmt={fmt} />
    </svg>
  );
}

/** A figure beside a chart: caps label, a display number, one meta line. `href` makes the number a link to its match. */
export function Fig({ label, value, sub, tone, href, className }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "poor"; href?: string; className?: string }) {
  const num = <b className={`disp disp--s fig__v ${tone ? `${tone}-text` : ""}`}>{value}</b>;
  return (
    <div className={`fig ${className ?? ""}`}>
      <dt className="caps">{label}</dt>
      <dd>
        {href ? <a href={href} className="fig__a">{num}</a> : num}
        {sub && <span className="meta fig__s">{sub}</span>}
      </dd>
    </div>
  );
}
