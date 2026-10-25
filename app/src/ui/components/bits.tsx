// Small display pieces shared by every view.
import { useState, type CSSProperties, type ReactNode } from "react";
import { scoreText } from "../lib/scale";
import { initials } from "../lib/format";
import { meterGeometry, verdictOf, VERDICT_LABEL, type Bench, type Verdict } from "../lib/verdict";
import type { SourceInfo } from "../data/sources";
import { emblemUrl, mapAccent } from "../data/maps";
import { mapName } from "../lib/format";

/** A formatted number with its unit set smaller and muted: "71.0%" → 71.0 + small "%". */
export function Num({ v, className, style }: { v: string; className?: string; style?: CSSProperties }) {
  const m = /^([−+]?\$?[\d.,]+)(\s?)(%|ms|s|°|k|x)?$/.exec(v);
  if (!m || !m[3]) return <span className={className} style={style}>{v}</span>;
  return <span className={className} style={style}>{m[1]}<small className="unit">{m[3]}</small></span>;
}

/** ▲ / ▼ and the difference, coloured good or poor; within the dead zone it is neutral. */
export function Delta({ d, fmt, lowerIsBetter, span, title }: { d: number | null; fmt: (v: number) => string; lowerIsBetter?: boolean; span: number; title?: string }) {
  if (d === null || !Number.isFinite(d)) return null;
  const t = Math.max(-1, Math.min(1, (lowerIsBetter ? -d : d) / span));
  const up = d > 0;
  const flat = Math.abs(t) < 0.05;
  return (
    <span className="delta" style={{ color: flat ? "var(--ink3)" : scoreText(t, 0.05) }} data-tip={title}>
      {!flat && (
        <svg width="7" height="6" viewBox="0 0 7 6" aria-hidden><path d={up ? "M3.5 0L7 6H0z" : "M3.5 6L0 0h7z"} fill="currentColor" /></svg>
      )}
      <span>{fmt(Math.abs(d))}</span>
    </span>
  );
}

/** HLTV's meter: the zone your value falls in lights up; a cream tick marks you, a white one the average. */
export function Meter({ v, bench, animate }: { v: number | null; bench: Bench; animate?: boolean }) {
  const g = meterGeometry(v, bench);
  const verdict = verdictOf(v, bench);
  // zone extents for the lit verdict
  const zone = verdict === "na" ? null
    : verdict === "avg" ? { left: g.low, width: g.high - g.low }
    : (verdict === "good") === g.goodOnRight ? { left: g.high, width: 1 - g.high }
    : { left: 0, width: g.low };
  return (
    <div className="meter" aria-hidden>
      {zone && <i className={`meter__zone ${animate ? "wake-bar" : ""}`} data-v={verdict} style={{ left: `${zone.left * 100}%`, width: `${zone.width * 100}%` }} />}
      <i className="meter__ref" style={{ left: `${g.ref * 100}%` }} />
      {g.value !== null && <i className="meter__you" style={{ left: `${g.value * 100}%` }} />}
    </div>
  );
}

export function VerdictLabel({ v }: { v: Verdict }) {
  if (v === "na") return <span className="verdict" data-v="na">n/a</span>;
  return <span className="verdict" data-v={v}>{VERDICT_LABEL[v]}</span>;
}

/** Sparkline with the last point marked; optional reference line (e.g. 1.00 rating). */
export function Spark({ values, w = 96, h = 28, refLine, color = "var(--tan)", min: minV, max: maxV, label }: {
  values: (number | null)[];
  w?: number;
  h?: number;
  refLine?: number;
  color?: string;
  min?: number;
  max?: number;
  label?: string;
}) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null && Number.isFinite(p.v));
  if (pts.length < 2) return <svg width={w} height={h} aria-hidden />;
  const lo = Math.min(minV ?? Infinity, ...pts.map((p) => p.v), refLine ?? Infinity);
  const hi = Math.max(maxV ?? -Infinity, ...pts.map((p) => p.v), refLine ?? -Infinity);
  const span = hi - lo || 1;
  const X = (i: number) => 2 + (i / Math.max(1, values.length - 1)) * (w - 4);
  const Y = (v: number) => h - 3 - ((v - lo) / span) * (h - 6);
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="spark">
      {refLine !== undefined && <line x1="0" x2={w} y1={Y(refLine)} y2={Y(refLine)} stroke="var(--line2)" strokeDasharray="2 3" />}
      <polyline points={pts.map((p) => `${X(p.i)},${Y(p.v)}`).join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={X(last.i)} cy={Y(last.v)} r="2.5" fill="var(--cream)" />
    </svg>
  );
}

export function SourceBadge({ s, compact }: { s: SourceInfo; compact?: boolean }) {
  const tip = s.id === "converted"
    ? "Converted from the game's console log. No aim or movement data; early rounds may have totals only."
    : s.id === "synthetic" ? "Generated demo data, not a real match."
    : s.id === "valve" ? "Your Valve matchmaking demo, extracted from the game's replays folder."
    : s.missing.length ? `Recorded by the capture plugin, without ${s.missing.join(" or ")} data.` : "Recorded by the capture plugin: aim, movement, economy and utility.";
  return (
    <span className="src" data-src={s.id} data-tip={tip} tabIndex={0}>
      <i aria-hidden />
      <span>{s.label}</span>
      {!compact && s.missing.length > 0 && <small>no {s.missing.join(", ")}</small>}
    </span>
  );
}

/** An image from the web with a fallback when it does not load (offline, blocked). */
export function RemoteImg({ src, alt, fallback, className, style }: { src: string | null; alt: string; fallback: ReactNode; className?: string; style?: CSSProperties }) {
  const [state, setState] = useState<"loading" | "ok" | "failed">(src ? "loading" : "failed");
  if (!src || state === "failed") return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={{ ...style, opacity: state === "ok" ? 1 : 0, transition: "opacity var(--d-pro) ease" }}
      onLoad={() => setState("ok")}
      onError={() => setState("failed")}
      referrerPolicy="no-referrer"
      draggable={false}
    />
  );
}

export function Initials({ name, className }: { name: string; className?: string }) {
  return <span className={`initials ${className ?? ""}`} aria-hidden>{initials(name)}</span>;
}

/** Map emblem thumbnail; offline it falls back to a monogram on the map's accent. */
export function MapThumb({ map, size = 28 }: { map: string; size?: number }) {
  const accent = mapAccent(map);
  return (
    <span className="map-thumb" style={{ width: size, height: size, ["--accent" as string]: accent }}>
      <RemoteImg src={emblemUrl(map)} alt="" fallback={<span className="map-thumb__mono">{mapName(map).replace(/[^A-Z0-9]/g, "").slice(0, 2) || mapName(map).slice(0, 2)}</span>} />
    </span>
  );
}

/** "3K", "4K", "Ace" badge; tiers brighten with the count. */
export function MultiBadge({ k }: { k: number }) {
  if (k < 2) return null;
  return <span className="mk" data-k={Math.min(5, k)}>{k >= 5 ? "ACE" : `${k}K`}</span>;
}

/** "1v3" clutch badge, filled when won. */
export function ClutchBadge({ vs, won }: { vs: number; won: boolean }) {
  return <span className="clutch" data-won={won}>1v{vs}</span>;
}

/** Score and W/L. */
export function ScoreCell({ us, them, result }: { us: number; them: number; result: "W" | "L" | "T" }) {
  return (
    <span className="scorecell">
      <span className={`wl wl--${result}`}>{result}</span>
      <span className="num"><b className={result === "W" ? "cream" : undefined}>{us}</b><span className="faint">:</span>{them}</span>
    </span>
  );
}
