// A spray compared with the pro path. The reference is stats/aim-ref.ts RECOIL: per bullet the median
// pro view compensation from the first shot and its quartiles, pitch positive down (provisional, an
// empirical median of pro sprays, not the game's recoil table; scoring is off, architecture.md). So the
// chart compares and never grades: no red or green. The player's path is stats/aim.ts AimAgg.path,
// per bullet sums of the view movement from the first bullet; AimAgg.spread, heads and onTarget add the
// spread per bullet, where the target's head was and how far each bullet landed from it.
import type { RecoilRef } from "../../stats/aim-ref";
import { CONTROL_DEG, meanBullets, spreadOf, targetControl, type BulletSums, type SpraySpread } from "./charts";

export interface PlayerPath { n: number[]; dp: number[]; dy: number[] }
export interface PathPoint { bullet: number; pitch: number; yaw: number; n: number }

/** Bullets reached by fewer sprays than this are drawn faded and never decide the title. */
export const MIN_SPRAYS = 3;

/** The player's mean path; bullet 1 is the origin. */
export function meanPath(p: PlayerPath): PathPoint[] {
  if (!p.n.length) return [];
  return [{ bullet: 1, pitch: 0, yaw: 0, n: p.n[0] }, ...p.n.map((n, j) => ({ bullet: j + 2, pitch: p.dp[j] / n, yaw: p.dy[j] / n, n }))];
}

export type SprayFinding =
  | { kind: "inside"; bullets: number }
  | { kind: "leaves"; bullet: number; how: "less pull" | "more pull" | "sideways" }
  | { kind: "thin" };

/** Where the path first leaves the pros' middle half, counting only bullets enough sprays reached. */
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
  if (f.kind === "inside") return `Your ${gun} spray stays inside the pros' middle half through bullet ${f.bullets}`;
  const what = f.how === "less pull" ? "pulls down less than" : f.how === "more pull" ? "pulls down more than" : "drifts sideways out of";
  return `Your ${gun} spray ${what} the pros' middle half from bullet ${f.bullet}`;
}

/** 26 px per degree on both axes, so the 1° bar measures every gun; the height follows the deepest bullet drawn. */
const S = 26, W = 330, TOP = 24, MIN_H = 160;

/**
 * `relative`: the path is measured against the target, not as absolute view angles (plugin recordings
 * until the plugin stores view angles), so it cannot be set against the pro path: the chart draws your
 * path only, says why in one sentence, and shows no band, no pro line and no distance bars.
 * `reference` null: the recoil reference has no pro path for the gun, so only your path draws.
 * `pro` false hides the pro band and line (the Pro path toggle); `spread` draws each bullet's spread as
 * a one-standard-deviation ellipse and `heads` where the target's head was for each bullet, both in the
 * absolute frame, so neither draws on a relative path.
 */
export function SprayPath({ gun, reference, path, relative = false, pro = true, spread = null, heads = null }: {
  gun: string; reference: RecoilRef | null; path: PlayerPath | null; relative?: boolean; pro?: boolean; spread?: SpraySpread | null; heads?: BulletSums | null;
}) {
  const pts = path ? meanPath(path) : [];
  const ref = relative || !pro || !reference ? [] : reference.path;
  const until = Math.min(ref.length, Math.max(pts.length, 12));
  const X = (yaw: number) => W / 2 + yaw * S, Y = (pitch: number) => TOP + pitch * S;
  // spreadOf's i is the bullet's index from 0, so bullet i + 1; its mean is that bullet's point on the path
  const ells = path && spread && !relative ? spreadOf(path, spread).flatMap((e) => {
    const p = pts.find((q) => q.bullet === e.i + 1);
    return p && p.n >= MIN_SPRAYS ? [{ bullet: p.bullet, x: p.yaw, y: p.pitch, rx: e.yaw, ry: e.pitch }] : [];
  }) : [];
  const eyes = heads && !relative ? meanBullets(heads) : [];
  const deepest = Math.max(0, ...ref.slice(0, until).map((b) => b[3]), ...pts.map((p) => p.pitch), ...ells.map((e) => e.y + e.ry), ...eyes.map((h) => h.pitch));
  const H = Math.max(MIN_H, Math.ceil(Y(deepest) + 24));
  const band = [...ref.slice(0, until).map((b) => `${X(b[4])},${Y(b[0])}`), ...ref.slice(0, until).reverse().map((b) => `${X(b[5])},${Y(b[0])}`)].join(" ");
  const finding = relative ? `Your ${gun} spray, relative to the target` : !reference ? `Your ${gun} spray` : path ? findingTitle(gun, sprayFinding(reference, pts)) : `${gun}: the pro path`;
  return (
    <figure className="spray">
      <figcaption className="spray__title">{finding}</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 30}`} className="spray__plot" role="img" aria-label={finding}>
        {ref.length ? <polygon points={band} className="spray__band" /> : null}
        {ells.map((e) => <ellipse key={`e${e.bullet}`} cx={X(e.x)} cy={Y(e.y)} rx={Math.max(2, e.rx * S)} ry={Math.max(2, e.ry * S)} className="spray__sd" />)}
        {ref.slice(1, until).map((b, i) => <line key={i} x1={X(b[1])} x2={X(b[1])} y1={Y(b[2])} y2={Y(b[3])} className="spray__tick" />)}
        {ref.length ? <polyline points={ref.slice(0, until).map((b) => `${X(b[1])},${Y(b[0])}`).join(" ")} className="spray__pro" /> : null}
        {pts.length ? <polyline points={pts.map((p) => `${X(p.yaw)},${Y(p.pitch)}`).join(" ")} className="spray__mine" /> : null}
        {eyes.map((h) => <circle key={`h${h.i}`} cx={X(h.yaw)} cy={Y(h.pitch)} r="2.5" className="spray__head" />)}
        {pts.map((p, i) => (
          <g key={p.bullet} opacity={p.n >= MIN_SPRAYS ? 1 : 0.4}>
            <circle cx={X(p.yaw)} cy={Y(p.pitch)} r={p.bullet === 1 ? 5 : 4} className={p.bullet === 1 ? "spray__origin" : "spray__dot"} />
            <text x={X(p.yaw) + (i % 2 ? 9 : -9)} y={Y(p.pitch) + 4} textAnchor={i % 2 ? "start" : "end"} className="spray__n">{p.bullet}</text>
          </g>
        ))}
        <g transform={`translate(16,${H + 10})`} className="spray__scale">
          <line x1="0" x2={S} y1="0" y2="0" /><line x1="0" x2="0" y1="-4" y2="4" /><line x1={S} x2={S} y1="-4" y2="4" />
          <text x={S + 8} y="4">1°</text>
        </g>
      </svg>
      {relative ? <p className="spray__note">Measured against the target, not view angles, so not compared with pros.</p> : !reference ? <p className="spray__note">There is no pro path for this gun in the recoil reference.</p> : null}
    </figure>
  );
}

/** Distance of each bullet from the pro median, with the edge of the pros' middle half for reference. */
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
      <div className="caps">Distance from the pro path, bullet by bullet</div>
      <div className="sprayd__plot">
        {rows.map((r) => <i key={r.b} data-thin={r.n < MIN_SPRAYS || undefined} style={{ height: `${(100 * r.d) / max}%` }} title={`Bullet ${r.b}: ${r.d.toFixed(2)}° from the pro median, ${r.n} sprays`} />)}
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
