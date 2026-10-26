// The spray chart, drawn as Leetify draws it: where your bullets landed around bullet 1's point, over
// the game's own pattern, with the ideal pull as an overlay. Sources:
// - stats/recoil-ref.ts RECOIL: per gun `kick`, the in-game pattern (where each bullet goes from bullet 1
//   with no pull), `ideal`, the pull that cancels it (minus kick), and `path`, the ideal pull with the
//   pros' middle half of view movement around it;
// - stats/aim.ts AimAgg.land: where your bullets landed from bullet 1, per gun and bullet, measured from
//   the bullet's own direction (demos) or estimated as your view plus the game's kick (plugin 1.2.0);
// - AimAgg.path (or relPath, unknownPath): your view movement from bullet 1, "your pull";
// - AimAgg.spread and heads: the spread of your pull per bullet, and where the target's head was.
// Everything is in degrees, pitch positive down and yaw positive left (aim-geometry.ts), so the chart
// draws x = -yaw: the pattern climbs up the well and the ideal pull mirrors it below bullet 1. It
// compares and never grades: no red or green.
import type { ReactNode } from "react";
import type { RecoilRef } from "../../stats/recoil-ref";
import { plural } from "../lib/format";
import { CONTROL_DEG, meanBullets, spreadOf, targetControl, type BulletSums, type SpraySpread } from "./charts";

export interface PlayerPath { n: number[]; dp: number[]; dy: number[] }
/** AimAgg.land for one gun: per bullet from bullet 2, sprays and summed landing angles; sprays measured and estimated. */
export interface Landing extends PlayerPath { measured: number; pattern: number }
export interface PathPoint { bullet: number; pitch: number; yaw: number; n: number }

/** Bullets reached by fewer sprays than this are drawn faded and never decide a headline. */
export const MIN_SPRAYS = 3;

/** The mean point per bullet of a path or of landing points (index 0 is bullet 2); bullet 1 is the origin. */
export function meanPath(p: PlayerPath): PathPoint[] {
  if (!p.n.length) return [];
  return [{ bullet: 1, pitch: 0, yaw: 0, n: p.n[0] }, ...p.n.map((n, j) => ({ bullet: j + 2, pitch: p.dp[j] / n, yaw: p.dy[j] / n, n }))];
}

export type LandingSource = "measured" | "estimated" | "mixed";
/**
 * Whether a gun's landing points come from the bullets' own directions, from the game's pattern added
 * to your view, or both. AimAgg.land counts sprays of each kind per gun, not per bullet, so a mix cannot
 * be split point by point: its points get a glyph of their own.
 */
export function landingSource(l: Landing): LandingSource {
  return l.pattern === 0 ? "measured" : l.measured === 0 ? "estimated" : "mixed";
}

export interface SprayStay {
  /** mean distance of your average spray's bullets from bullet 1's point, degrees */
  mean: number;
  /** the same mean for the game's pattern over the same bullets: where they go with no pull; null without a pattern */
  noPull: number | null;
  /** the last bullet counted; the first is always bullet 2 */
  to: number;
  /** sprays with landing points */
  sprays: number;
}

/**
 * How far your bullets stayed from bullet 1's point: the mean over bullets 2 to `to` of each mean
 * landing point's distance from the origin. Only bullets MIN_SPRAYS sprays reached count, and with a
 * pattern only the bullets it covers, so `noPull` is measured over exactly the same bullets. Null when
 * no bullet counts.
 */
export function sprayStay(l: Landing, kick: RecoilRef["kick"] | null): SprayStay | null {
  const pts = meanPath(l).filter((p) => p.bullet > 1 && p.n >= MIN_SPRAYS && (!kick?.length || p.bullet <= kick.length));
  if (!pts.length) return null;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    mean: avg(pts.map((p) => Math.hypot(p.pitch, p.yaw))),
    noPull: kick?.length ? avg(pts.map((p) => Math.hypot(kick[p.bullet - 1][0], kick[p.bullet - 1][1]))) : null,
    to: pts[pts.length - 1].bullet,
    sprays: l.measured + l.pattern,
  };
}

export type SprayFinding =
  | { kind: "inside"; bullets: number }
  | { kind: "leaves"; bullet: number; how: "less pull" | "more pull" | "sideways" }
  | { kind: "thin" };

/** Where your pull first leaves the pros' middle half, counting only bullets enough sprays reached. */
export function sprayFinding(ref: RecoilRef, pts: PathPoint[]): SprayFinding {
  const counted = pts.filter((p) => p.bullet > 1 && p.n >= MIN_SPRAYS && p.bullet <= ref.path.length);
  if (!counted.length) return { kind: "thin" };
  for (const p of counted) {
    const [, , pq25, pq75, yq25, yq75] = ref.path[p.bullet - 1];
    if (p.pitch < pq25) return { kind: "leaves", bullet: p.bullet, how: "less pull" };
    if (p.pitch > pq75) return { kind: "leaves", bullet: p.bullet, how: "more pull" };
    if (p.yaw < yq25 || p.yaw > yq75) return { kind: "leaves", bullet: p.bullet, how: "sideways" };
  }
  return { kind: "inside", bullets: counted[counted.length - 1].bullet };
}

export function findingTitle(gun: string, f: SprayFinding): string {
  if (f.kind === "thin") return `${gun}: not enough sprays yet to compare`;
  if (f.kind === "inside") return `Your ${gun} pull stays inside the pros' middle half through bullet ${f.bullets}`;
  const what = f.how === "less pull" ? "falls short of" : f.how === "more pull" ? "overshoots" : "drifts sideways out of";
  return `Your ${gun} pull ${what} the pros' middle half from bullet ${f.bullet}`;
}

// ---------------------------------------------------------------- the well

/** The well's side in viewBox units; it draws at most this many CSS pixels wide (restore-aim.css). */
const V = 360;
/**
 * Degrees of margin around the drawn layers (room for the layer names above the pattern and below the
 * ideal pull at the widest frame), and the smallest and largest side in degrees.
 */
const PAD = 1.5, MIN_SIDE = 8, MAX_SIDE = 30;

export interface SprayFrame {
  /** the well's side, whole degrees */
  side: number;
  /** viewBox units per degree */
  s: number;
  /** bullet 1's point in viewBox units */
  x0: number;
  y0: number;
}

/**
 * The square frame that holds every point given, bullet 1 included, with a degree of margin: yaw
 * centred on bullet 1 (the pattern sways both ways), pitch centred on its own range. Past MAX_SIDE the
 * well clips, bullet 1 kept PAD inside the edge.
 */
export function sprayFrame(pts: readonly { pitch: number; yaw: number }[]): SprayFrame {
  let pmin = 0, pmax = 0, ymax = 0;
  for (const p of pts) { pmin = Math.min(pmin, p.pitch); pmax = Math.max(pmax, p.pitch); ymax = Math.max(ymax, Math.abs(p.yaw)); }
  const side = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.ceil(Math.max(pmax - pmin + 2 * PAD, 2 * (ymax + PAD)))));
  const s = V / side;
  const half = side / 2 - PAD;
  const mid = Math.max(-half, Math.min(half, (pmin + pmax) / 2));
  return { side, s, x0: V / 2, y0: V / 2 - mid * s };
}

/** A bullet's landing glyph: filled when measured, a ring when estimated, half filled for a mix. */
export function BulletMark({ x, y, r, source }: { x: number; y: number; r: number; source: LandingSource }) {
  if (source === "measured") return <circle cx={x} cy={y} r={r} className="spray__land" />;
  if (source === "estimated") return <circle cx={x} cy={y} r={r} className="spray__land spray__land--est" />;
  return (
    <g>
      <circle cx={x} cy={y} r={r} className="spray__land spray__land--est" />
      <path d={`M${x},${y - r}A${r},${r} 0 0 0 ${x},${y + r}Z`} className="spray__land" />
    </g>
  );
}

/** Bullets whose number is drawn: the brief's 1, 5 and 10. */
const NUMBERED = new Set([1, 5, 10]);

/** A number beside its point, pushed away from the middle of the points it labels so it clears the cluster. */
function BulletNo({ x, y, cx, cy, n }: { x: number; y: number; cx: number; cy: number; n: number }) {
  const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy);
  const ux = len > 3 ? dx / len : -1, uy = len > 3 ? dy / len : 0;
  return <text x={x + ux * 10} y={y + uy * 10 + 4} textAnchor={ux > 0.35 ? "start" : ux < -0.35 ? "end" : "middle"} className="spray__n">{n}</text>;
}

/**
 * A layer's name, above its highest point or below its lowest: the pattern and the ideal pull both
 * sweep sideways at their far end, so a name beside a point lands on its neighbours.
 */
function Label({ x, y, below, children }: { x: number; y: number; below?: boolean; children: string }) {
  return <text x={Math.max(36, Math.min(V - 36, x))} y={below ? y + 15 : y - 9} textAnchor="middle" className="spray__lbl">{children}</text>;
}

/**
 * The well. `reference` null draws your own layers alone: for a relative path (plugin files before
 * 1.2.0), a path whose recoil state is unknown (AimAgg.unknownPath), or a gun with no in-game pattern
 * yet, whose demo bullets may still have landing points. With
 * landing points they are the main layer and your pull joins the ideal pull's overlay; without them
 * your pull is the main layer. Both overlays stay mounted and fade (restore-aim.css), and the frame is
 * fitted to every layer whether shown or not, so a toggle never moves what stays.
 */
export function SprayWell({ label, reference, landing, path, heads = null, spread = null, showIdeal, showSpread }: {
  label: string;
  reference: RecoilRef | null;
  landing: Landing | null;
  path: PlayerPath | null;
  heads?: BulletSums | null;
  spread?: SpraySpread | null;
  showIdeal: boolean;
  showSpread: boolean;
}) {
  const land = landing ? meanPath(landing) : [];
  const pull = path ? meanPath(path) : [];
  const main = land.length ? land : pull;
  const source = land.length && landing ? landingSource(landing) : null;
  const kick = reference?.kick ?? [];
  const ideal = reference?.ideal ?? [];
  const rows = reference?.path ?? [];
  const eyes = heads ? meanBullets(heads) : [];
  // spreadOf's i is the bullet's index from 0, so bullet i + 1; its mean is that bullet's point on your pull
  const ells = path && spread ? spreadOf(path, spread).flatMap((e) => {
    const p = pull.find((q) => q.bullet === e.i + 1);
    return p && p.n >= MIN_SPRAYS ? [{ bullet: p.bullet, yaw: p.yaw, pitch: p.pitch, rx: e.yaw, ry: e.pitch }] : [];
  }) : [];
  // the pros' band only where your sprays reach (ten bullets at least): past them it compares with
  // nothing of yours, and the full magazine's band piles into a blob where the pull curls
  const band = rows.slice(0, Math.max(10, main.length, pull.length));
  // every point drawn, faded bullets too, so nothing drawn falls outside; the spread ellipses may clip
  const f = sprayFrame([
    ...kick.map(([pitch, yaw]) => ({ pitch, yaw })), ...ideal.map(([pitch, yaw]) => ({ pitch, yaw })),
    ...band.flatMap((r) => [{ pitch: r[2], yaw: r[4] }, { pitch: r[3], yaw: r[5] }]),
    ...land, ...pull, ...eyes,
  ]);
  const X = (yaw: number) => f.x0 - yaw * f.s, Y = (pitch: number) => f.y0 + pitch * f.s;
  const pts = (ps: readonly { pitch: number; yaw: number }[]) => ps.map((p) => `${X(p.yaw)},${Y(p.pitch)}`).join(" ");
  // whole-degree lines from bullet 1's point both ways
  const lines = (o: number) => Array.from({ length: f.side * 2 + 1 }, (_, i) => o + (i - f.side) * f.s).filter((v) => v >= 0 && v <= V);
  const bandPts = band.length ? [...band.map((r) => `${X(r[4])},${Y(r[0])}`), ...[...band].reverse().map((r) => `${X(r[5])},${Y(r[0])}`)].join(" ") : "";
  const top = kick.length ? kick.reduce((a, b) => (b[0] < a[0] ? b : a)) : null;
  const end = ideal.length > 1 ? ideal.reduce((a, b) => (b[0] > a[0] ? b : a)) : null;
  const cx = main.reduce((t, p) => t + X(p.yaw), 0) / (main.length || 1), cy = main.reduce((t, p) => t + Y(p.pitch), 0) / (main.length || 1);
  const pullLayer = land.length > 0;
  return (
    <svg viewBox={`0 0 ${V} ${V}`} className="spray__plot well" role="img" aria-label={label}>
      <g className="spray__grid" aria-hidden>
        {lines(f.x0).map((x) => <line key={`x${x}`} x1={x} x2={x} y1={0} y2={V} />)}
        {lines(f.y0).map((y) => <line key={`y${y}`} x1={0} x2={V} y1={y} y2={y} />)}
      </g>
      {kick.length > 1 && (
        <g className="spray__pattern">
          {kick.slice(1).map(([p, y], i) => <circle key={i} cx={X(y)} cy={Y(p)} r={2.2} className="spray__kick" />)}
          {top && <Label x={X(top[1])} y={Y(top[0])}>game pattern</Label>}
        </g>
      )}
      {ideal.length > 1 && (
        <g className="spray__layer" data-layer="ideal" data-off={!showIdeal || undefined}>
          {bandPts && <polygon points={bandPts} className="spray__band" />}
          {band.slice(1).map((r, i) => (r[2] === r[3] ? null : <line key={i} x1={X(r[1])} x2={X(r[1])} y1={Y(r[2])} y2={Y(r[3])} className="spray__tick" />))}
          <polyline points={pts(ideal.map(([pitch, yaw]) => ({ pitch, yaw })))} className="spray__pro" />
          {end && <Label x={X(end[1])} y={Y(end[0])} below>ideal pull</Label>}
        </g>
      )}
      {pullLayer && pull.length > 1 && (
        <g className="spray__layer" data-layer="pull" data-off={!(showIdeal || showSpread) || undefined}>
          <polyline points={pts(pull)} className="spray__pull" />
          {pull.slice(1).map((p) => <circle key={p.bullet} cx={X(p.yaw)} cy={Y(p.pitch)} r={1.6} className="spray__pulldot" opacity={p.n >= MIN_SPRAYS ? 1 : 0.4} />)}
        </g>
      )}
      {ells.length > 0 && (
        <g className="spray__layer" data-layer="spread" data-off={!showSpread || undefined}>
          {ells.map((e) => <ellipse key={e.bullet} cx={X(e.yaw)} cy={Y(e.pitch)} rx={Math.max(2, e.rx * f.s)} ry={Math.max(2, e.ry * f.s)} className="spray__sd" />)}
        </g>
      )}
      {eyes.map((h) => <circle key={`h${h.i}`} cx={X(h.yaw)} cy={Y(h.pitch)} r={2.5} className="spray__head" opacity={h.n >= MIN_SPRAYS ? 0.85 : 0.35} />)}
      {main.length > 1 && <polyline points={pts(main)} className="spray__mine" />}
      {main.slice(1).map((p) => (
        <g key={p.bullet} opacity={p.n >= MIN_SPRAYS ? 1 : 0.4}>
          {source ? <BulletMark x={X(p.yaw)} y={Y(p.pitch)} r={3.5} source={source} /> : <circle cx={X(p.yaw)} cy={Y(p.pitch)} r={3} className="spray__dot" />}
          {NUMBERED.has(p.bullet) && <BulletNo x={X(p.yaw)} y={Y(p.pitch)} cx={cx} cy={cy} n={p.bullet} />}
        </g>
      ))}
      {/* bullet 1's point, the aim point every other bullet is measured from */}
      <circle cx={f.x0} cy={f.y0} r={5} className="spray__origin" />
      {main.length > 0 && <BulletNo x={f.x0} y={f.y0} cx={cx} cy={cy} n={1} />}
      <text x={8} y={V - 8} className="spray__lbl">1° per cell</text>
    </svg>
  );
}

// ---------------------------------------------------------------- the key

/** A key entry: its glyph, its words, and a tooltip when the words need one. */
function KeyItem({ glyph, tip, children }: { glyph: ReactNode; tip?: string; children: ReactNode }) {
  return <span data-tip={tip} tabIndex={tip ? 0 : undefined}><svg width="16" height="10" viewBox="0 0 16 10" aria-hidden>{glyph}</svg>{children}</span>;
}

const MEASURED_TIP = "From each bullet's own direction in the demo.";
const ESTIMATED_TIP = "Your view plus the game's kick: these files record the view, not the bullet.";

/** The key under the well: one entry per layer drawn, the overlays' entries only while they show. */
export function SprayKey({ reference, landing, path, heads, showIdeal, showSpread, spread }: {
  reference: RecoilRef | null; landing: Landing | null; path: PlayerPath | null; heads: boolean; showIdeal: boolean; showSpread: boolean; spread: boolean;
}) {
  const source = landing?.n.length ? landingSource(landing) : null;
  const pull = !!path?.n.length;
  const thin = [landing, path].some((p) => p?.n.some((n) => n < MIN_SPRAYS));
  const band = !!reference?.path.some((r) => r[2] !== r[3]);
  return (
    <div className="legend spray-key">
      {source === "measured" && <KeyItem glyph={<BulletMark x={8} y={5} r={3.5} source="measured" />} tip={MEASURED_TIP}>Your bullets, measured</KeyItem>}
      {source === "estimated" && <KeyItem glyph={<BulletMark x={8} y={5} r={3.5} source="estimated" />} tip={ESTIMATED_TIP}>Your bullets, estimated</KeyItem>}
      {source === "mixed" && landing && (
        <KeyItem glyph={<BulletMark x={8} y={5} r={3.5} source="mixed" />} tip={`Measured: ${MEASURED_TIP} Estimated: ${ESTIMATED_TIP}`}>
          Your bullets: {plural(landing.measured, "spray")} measured, {landing.pattern} estimated
        </KeyItem>
      )}
      {!source && pull && <KeyItem glyph={<><line x1="0" x2="16" y1="5" y2="5" className="spray__mine" /><circle cx="8" cy="5" r="2.5" className="spray__dot" /></>}>Your pull</KeyItem>}
      <KeyItem glyph={<circle cx="8" cy="5" r="4" className="spray__origin" />}>Bullet 1's point</KeyItem>
      {reference && reference.kick.length > 1 && <KeyItem glyph={<circle cx="8" cy="5" r="2.2" className="spray__kick" />} tip="Where each bullet goes from bullet 1 if you don't pull at all.">Game pattern, {reference.kick.length} bullets</KeyItem>}
      {reference && showIdeal && <KeyItem glyph={<line x1="0" x2="16" y1="5" y2="5" className="spray__pro" />} tip="The pull that keeps every bullet on bullet 1's point: the game pattern, mirrored.">Ideal pull</KeyItem>}
      {reference && showIdeal && band && <KeyItem glyph={<rect x="2" width="12" height="10" rx="2" className="spray__band" />}>Pros' middle half</KeyItem>}
      {source && pull && (showIdeal || showSpread) && <KeyItem glyph={<line x1="0" x2="16" y1="5" y2="5" className="spray__pull" />} tip="Your average view movement from bullet 1.">Your pull</KeyItem>}
      {spread && showSpread && <KeyItem glyph={<ellipse cx="8" cy="5" rx="6" ry="4" className="spray__sd" />}>Your spread, one standard deviation</KeyItem>}
      {heads && <KeyItem glyph={<circle cx="8" cy="5" r="2.5" className="spray__head" />}>Where the target's head was</KeyItem>}
      {thin && <span className="faint">Faded: under {MIN_SPRAYS} sprays</span>}
    </div>
  );
}

// ---------------------------------------------------------------- beside the well

/** Your average spray's distance from bullet 1's point against the game's pattern with no pull, on one scale. */
export function SprayStayBars({ stay }: { stay: SprayStay }) {
  if (stay.noPull === null) return null;
  const max = Math.max(stay.mean, stay.noPull);
  const rows = [{ k: "you", label: "Your average spray", v: stay.mean }, { k: "ref", label: "With no pull", v: stay.noPull }];
  return (
    <div className="stay" role="img" aria-label={`Your average spray ${stay.mean.toFixed(2)} degrees from bullet 1's point; the game's pattern with no pull ${stay.noPull.toFixed(2)} degrees`}>
      {rows.map((r) => (
        <div key={r.k} className="stay__row" data-k={r.k}>
          <span className="stay__l">{r.label}</span>
          <span className="stay__bar"><i style={{ width: `${(100 * r.v) / max}%` }} /></span>
          <b className="num">{r.v.toFixed(2)}°</b>
        </div>
      ))}
    </div>
  );
}

/** Distance of each bullet of your pull from the ideal pull, with the edge of the pros' middle half for reference. */
export function SprayDistance({ reference, path }: { reference: RecoilRef; path: PlayerPath }) {
  const pts = meanPath(path).filter((p) => p.bullet > 1 && p.bullet <= reference.path.length);
  if (!pts.length) return null;
  const rows = pts.map((p) => {
    const [pm, ym, pq25, pq75, yq25, yq75] = reference.path[p.bullet - 1];
    return { b: p.bullet, n: p.n, d: Math.hypot(p.pitch - pm, p.yaw - ym), half: Math.hypot((pq75 - pq25) / 2, (yq75 - yq25) / 2) };
  });
  const max = Math.max(2, ...rows.map((r) => r.d)), edge = rows.reduce((s, r) => s + r.half, 0) / rows.length;
  return (
    <div className="sprayd">
      <div className="caps">Distance from the ideal pull, bullet by bullet</div>
      <div className="sprayd__plot">
        {rows.map((r) => <i key={r.b} data-thin={r.n < MIN_SPRAYS || undefined} style={{ height: `${(100 * r.d) / max}%` }} title={`Bullet ${r.b}: ${r.d.toFixed(2)}° from the ideal pull, ${r.n} sprays`} />)}
        <span className="sprayd__edge" style={{ bottom: `${(100 * edge) / max}%` }}><span>edge of the pros' middle half</span></span>
      </div>
      <div className="sprayd__x mono">{rows.map((r) => <span key={r.b}>{r.b}</span>)}</div>
    </div>
  );
}

/**
 * Bullet by bullet, how far your average bullet landed from the target's head (stats/aim.ts
 * AimAgg.onTarget, by each shot's fire direction), against CONTROL_DEG; "Controlled through bullet N"
 * is the run from bullet 1 that stayed within it. Needs bullet angles and the target's head, so plugin
 * files have no data and the caller draws nothing.
 */
export function SprayOnTarget({ sums }: { sums: BulletSums }) {
  const { rows, controlled } = targetControl(sums);
  if (rows.length < 2) return <p className="meta sprayd">Not enough sprays to judge against the target yet.</p>;
  const max = Math.max(CONTROL_DEG * 2, ...rows.map((r) => r.dev));
  return (
    <div className="sprayd sprayt">
      <div className="sprayt__head">
        <span className="caps" data-tip="Your average bullet's distance from the target's head." tabIndex={0}>On target, bullet by bullet</span>
        <b className="num">{controlled ? `Controlled through bullet ${controlled}` : "Bullet 1 off target"}</b>
      </div>
      <div className="sprayd__plot" role="img" aria-label={`Distance from the target by bullet: ${rows.map((r) => `${r.i + 1}: ${r.dev.toFixed(1)} degrees`).join(", ")}`}>
        {rows.map((r) => <i key={r.i} data-off={r.dev > CONTROL_DEG || undefined} style={{ height: `${(100 * r.dev) / max}%` }} title={`Bullet ${r.i + 1}: ${r.dev.toFixed(2)}° from the target's head, ${r.n} sprays`} />)}
        <span className="sprayd__edge" style={{ bottom: `${(100 * CONTROL_DEG) / max}%` }}><span>{CONTROL_DEG}° on target</span></span>
      </div>
      <div className="sprayd__x mono">{rows.map((r) => <span key={r.i}>{r.i + 1}</span>)}</div>
    </div>
  );
}
