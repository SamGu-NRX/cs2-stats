// Aim analytics for the human, from the aim.engagements and aim.shots tables, Leetify-style. CS Demo
// Manager has no aim metrics, so the definitions follow SCHEMA.md and Leetify's public descriptions.
// Everything is counted per side (T/CT) and per weapon class, so any split is a sum of buckets.
import { fullRoundTest } from "./context";
import type { MatchFile, Side, Vec3 } from "./schema";
import { weaponClass, type WeaponClass } from "./weapons";

/** A new burst starts after 0.3 s without firing (SCHEMA.md), or on a weapon or round change. */
export const BURST_GAP_S = 0.3;
/** Counter-strafed: horizontal speed at most 34 % of the weapon's max speed on a burst's first bullet. */
export const COUNTER_STRAFE_FRACTION = 0.34;
/** Spray bullets are the 4th onward in a burst. */
export const SPRAY_FROM_IDX = 4;
export const SPRAY_MAX_IDX = 30;
/** Gun classes; grenades, knife and Zeus shots do not count toward accuracy. */
export const GUN_CLASSES = ["rifle", "sniper", "smg", "heavy", "pistol"] as const;
export type GunClass = (typeof GUN_CLASSES)[number];

export interface ShotTiming { ri: number; tick: number; weapon: number }

/** Burst id and 1-based bullet index for each shot, from tick order alone. */
export function segmentBursts(shots: ShotTiming[], tickrate: number): { burst: number[]; idx: number[] } {
  const burst: number[] = [];
  const idx: number[] = [];
  const gap = BURST_GAP_S * tickrate;
  let b = -1;
  let n = 0;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const p = shots[i - 1];
    const fresh = !p || s.ri !== p.ri || s.weapon !== p.weapon || s.tick - p.tick >= gap;
    if (fresh) { b++; n = 0; }
    n++;
    burst.push(b);
    idx.push(n);
  }
  return { burst, idx };
}

/** null when speed or max speed is unknown */
export function isCounterStrafed(speed: number | null, maxSpeed: number | null): boolean | null {
  if (speed === null || maxSpeed === null || maxSpeed <= 0) return null;
  return speed <= COUNTER_STRAFE_FRACTION * maxSpeed;
}

const RAD = Math.PI / 180;

/** Unit view vector for Source angles (yaw around z, pitch positive looking down). */
export function viewVector(yawDeg: number, pitchDeg: number): Vec3 {
  const y = yawDeg * RAD;
  const p = pitchDeg * RAD;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

/** Angle in degrees between the view direction and the line from eye to target. */
export function crosshairAngleDeg(yawDeg: number, pitchDeg: number, eye: Vec3, target: Vec3): number {
  const v = viewVector(yawDeg, pitchDeg);
  const d: Vec3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len === 0) return 0;
  const cos = (v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / len;
  return Math.acos(Math.max(-1, Math.min(1, cos))) / RAD;
}

/** Total angle for a signed yaw/pitch offset from the view direction, in degrees. */
export function combinedAngleDeg(dyawDeg: number, dpitchDeg: number): number {
  return crosshairAngleDeg(0, 0, [0, 0, 0], viewVector(dyawDeg, dpitchDeg));
}

/** Angle between two yaw/pitch offsets from the same view direction (e.g. impact vs target). */
export function angleBetweenDeg(a: [number, number], b: [number, number]): number {
  const u = viewVector(a[0], a[1]);
  const v = viewVector(b[0], b[1]);
  const cos = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  return Math.acos(Math.max(-1, Math.min(1, cos))) / RAD;
}

// ---- mergeable histograms
export interface Hist { lo: number; step: number; bins: number[]; over: number; n: number; sum: number }
const hist = (lo: number, step: number, count: number): Hist => ({ lo, step, bins: new Array(count).fill(0), over: 0, n: 0, sum: 0 });
function put(h: Hist, v: number) {
  const i = Math.floor((v - h.lo) / h.step);
  if (i >= h.bins.length) h.over++;
  else h.bins[Math.max(0, i)]++;
  h.n++;
  h.sum += v;
}
export function mergeHist(a: Hist, b: Hist): Hist {
  b.bins.forEach((x, i) => (a.bins[i] += x));
  a.over += b.over; a.n += b.n; a.sum += b.sum;
  return a;
}
/** Median read from the bins (bin midpoint), null when empty. */
export function histMedian(h: Hist): number | null {
  if (!h.n) return null;
  let acc = 0;
  for (let i = 0; i < h.bins.length; i++) {
    acc += h.bins[i];
    if (acc >= h.n / 2) return h.lo + (i + 0.5) * h.step;
  }
  return h.lo + h.bins.length * h.step;
}

/** Engagement timings for one side. */
export interface EngStats {
  n: number;
  /** ms from the enemy becoming visible to your first damage on them */
  ttd: Hist;
  /** ms from visible to the first tick your aim moves toward them at ≥ 30°/s */
  react: Hist;
  /** degrees between your crosshair and the enemy's head when they became visible */
  xhair: Hist;
}
const emptyEng = (): EngStats => ({ n: 0, ttd: hist(0, 50, 40), react: hist(0, 25, 40), xhair: hist(0, 1, 30) });

/** Shot and kill counters for one side and weapon class. "Known" counters gate fields older files lack. */
export interface ShotStats {
  shots: number;
  hits: number;
  headHits: number;
  /** shots fired while a visible enemy was the target (visTarget = 1) */
  spotted: number;
  spottedHits: number;
  /** spotted shots with smoke = 0 and pen = 0 */
  adjusted: number;
  adjustedHits: number;
  /** spotted shots whose smoke or pen is unknown: neither counted nor excluded */
  adjUnknown: number;
  /** shots with any enemy within 10° of the aim (target), used by first-bullet and spray accuracy */
  onTarget: number;
  smokeKnown: number;
  smokeShots: number;
  penKnown: number;
  wallbangHits: number;
  first: number;
  firstStrafeKnown: number;
  firstStrafed: number;
  firstOnTarget: number;
  firstHits: number;
  sprayOnTarget: number;
  sprayHits: number;
  /** spray control: per bullet index, the count and summed angle (°) between impact and target */
  ctrlN: number[];
  ctrlSum: number[];
  kills: number;
  hsKills: number;
  wallbangKills: number;
  smokeKills: number;
}
export const emptyShots = (): ShotStats => ({
  shots: 0, hits: 0, headHits: 0, spotted: 0, spottedHits: 0, adjusted: 0, adjustedHits: 0, adjUnknown: 0, onTarget: 0, smokeKnown: 0, smokeShots: 0,
  penKnown: 0, wallbangHits: 0, first: 0, firstStrafeKnown: 0, firstStrafed: 0, firstOnTarget: 0, firstHits: 0,
  sprayOnTarget: 0, sprayHits: 0, ctrlN: new Array(SPRAY_MAX_IDX).fill(0), ctrlSum: new Array(SPRAY_MAX_IDX).fill(0),
  kills: 0, hsKills: 0, wallbangKills: 0, smokeKills: 0,
});

export interface SprayStep { n: number; sy: number; sp: number; syy: number; spp: number; en: number; ey: number; ep: number }
const step = (): SprayStep => ({ n: 0, sy: 0, sp: 0, syy: 0, spp: 0, en: 0, ey: 0, ep: 0 });

type SideKey = "t" | "ct";
export interface AimAgg {
  /** plugin flag: engagement visibility has been validated (visibility metrics are "validating" until then) */
  validated: boolean;
  /** spotted came from visTarget in every file (false: an older file's target column stood in) */
  visFromVisTarget: boolean;
  eng: Record<SideKey, EngStats>;
  shots: Record<SideKey, Record<GunClass, ShotStats>>;
  /** by weapon name: bullet index 1..30 → impact and aim-error sums (degrees) */
  spray: Record<string, SprayStep[]>;
}

export function emptyAim(validated = true): AimAgg {
  const classes = () => Object.fromEntries(GUN_CLASSES.map((c) => [c, emptyShots()])) as Record<GunClass, ShotStats>;
  return { validated, visFromVisTarget: true, eng: { t: emptyEng(), ct: emptyEng() }, shots: { t: classes(), ct: classes() }, spray: {} };
}

function addShots(a: ShotStats, b: ShotStats) {
  for (const k of Object.keys(b) as (keyof ShotStats)[]) {
    const v = b[k];
    if (Array.isArray(v)) v.forEach((x, i) => ((a[k] as number[])[i] += x));
    else (a[k] as number) += v;
  }
}

/** a += b (b is only read). The merged aim is validated only if every part is. */
export function mergeAim(a: AimAgg, b: AimAgg): AimAgg {
  a.validated = a.validated && b.validated;
  a.visFromVisTarget = a.visFromVisTarget && b.visFromVisTarget;
  for (const s of ["t", "ct"] as const) {
    a.eng[s].n += b.eng[s].n;
    mergeHist(a.eng[s].ttd, b.eng[s].ttd); mergeHist(a.eng[s].react, b.eng[s].react); mergeHist(a.eng[s].xhair, b.eng[s].xhair);
    for (const c of GUN_CLASSES) addShots(a.shots[s][c], b.shots[s][c]);
  }
  for (const [w, steps] of Object.entries(b.spray)) {
    const into = (a.spray[w] ??= Array.from({ length: SPRAY_MAX_IDX }, step));
    steps.forEach((s, i) => { for (const f of Object.keys(s) as (keyof SprayStep)[]) into[i][f] += s[f]; });
  }
  return a;
}

export type SideFilter = "all" | "t" | "ct";
export type ClassFilter = "all" | GunClass;

/** Sum of the buckets matching a side and weapon-class filter. */
export function shotsFor(a: AimAgg, side: SideFilter, cls: ClassFilter): ShotStats {
  const out = emptyShots();
  for (const s of side === "all" ? (["t", "ct"] as const) : [side]) {
    for (const c of cls === "all" ? GUN_CLASSES : [cls]) addShots(out, a.shots[s][c]);
  }
  return out;
}

export function engFor(a: AimAgg, side: SideFilter): EngStats {
  if (side !== "all") return a.eng[side];
  const out = emptyEng();
  for (const s of ["t", "ct"] as const) {
    out.n += a.eng[s].n;
    mergeHist(out.ttd, a.eng[s].ttd); mergeHist(out.react, a.eng[s].react); mergeHist(out.xhair, a.eng[s].xhair);
  }
  return out;
}

/** Spray control score: mean angle (°) between bullet and target over spray bullets (index 4+); lower is better. */
export function sprayControl(s: ShotStats): number | null {
  let n = 0;
  let sum = 0;
  for (let i = SPRAY_FROM_IDX - 1; i < SPRAY_MAX_IDX; i++) { n += s.ctrlN[i]; sum += s.ctrlSum[i]; }
  return n ? sum / n : null;
}

const isGun = (c: WeaponClass): c is GunClass => (GUN_CLASSES as readonly string[]).includes(c);
const truthy = (v: unknown) => v === true || v === 1;

/** Aggregates one match. Null when the match has no aim data (legacy files, or an old plugin). */
export function aimAggregate(m: MatchFile): AimAgg | null {
  const e = m.aim.engagements;
  const s = m.aim.shots;
  if (!e.ri.length && !s.ri.length) return null;
  const tr = m.env.tickrate || 64;
  const a = emptyAim(m.env.visibilityValidated === true);
  a.visFromVisTarget = !!s.visTarget;
  const isFull = fullRoundTest(m);
  const sideOf = (ri: number): SideKey | null => {
    const v: Side | null = m.rounds.side[ri]?.[m.human] ?? null;
    return v === 3 ? "ct" : v === 2 ? "t" : null;
  };

  for (let i = 0; i < e.ri.length; i++) {
    const sd = sideOf(e.ri[i]);
    if (!isFull(e.ri[i]) || !sd) continue;
    const g = a.eng[sd];
    g.n++;
    const tVis = e.tVis[i];
    const fd = e.tFirstDmg[i];
    const as = e.tAimStart[i];
    if (fd !== null) put(g.ttd, ((fd - tVis) * 1000) / tr);
    if (as !== null) put(g.react, ((as - tVis) * 1000) / tr);
    if (e.angVis[i] !== null) put(g.xhair, e.angVis[i]! / 100);
  }

  // Bursts are re-derived from ticks so the definition lives here, not in the plugin.
  const order: number[] = [];
  for (let i = 0; i < s.ri.length; i++) if (isFull(s.ri[i])) order.push(i);
  const { idx } = segmentBursts(order.map((i) => ({ ri: s.ri[i], tick: s.tick[i], weapon: s.weapon[i] })), tr);
  order.forEach((i, j) => {
    const sd = sideOf(s.ri[i]);
    const w = m.weapons[s.weapon[i]] ?? "unknown";
    // The plugin's class when recorded (its "shotgun" is part of our heavy class); null = taser.
    const pc = s.cls ? s.cls[i] : undefined;
    const cls: WeaponClass = pc === undefined ? weaponClass(w) : pc === null ? "other" : pc === "shotgun" ? "heavy" : pc;
    if (!sd || !isGun(cls)) return;
    const b = a.shots[sd][cls];
    const n = idx[j];
    const hit = s.hit[i];
    const hasTarget = s.target[i] !== null;
    // Spotted needs visTarget = 1. Files without the column predate it; there target meant "visible".
    const spotted = s.visTarget ? s.visTarget[i] === 1 : hasTarget;
    const smoke = s.smoke ? s.smoke[i] : undefined;
    const pen = s.pen ? s.pen[i] : undefined;
    b.shots++;
    if (hit !== null) { b.hits++; if (hit === 1) b.headHits++; }
    if (hasTarget) b.onTarget++;
    if (spotted) {
      b.spotted++;
      if (hit !== null) b.spottedHits++;
      // Adjusted: spotted, not through smoke, not a wallbang. Unknown smoke or pen is set aside.
      const smokeKnown = smoke !== undefined && smoke !== null;
      const penKnown = pen !== undefined && pen !== null;
      if ((smokeKnown && truthy(smoke)) || pen === 1) { /* excluded */ }
      else if (!smokeKnown || !penKnown) b.adjUnknown++;
      else { b.adjusted++; if (hit !== null) b.adjustedHits++; }
    }
    if (smoke !== undefined && smoke !== null) { b.smokeKnown++; if (truthy(smoke)) b.smokeShots++; }
    if (pen !== undefined && pen !== null) { b.penKnown++; if (pen === 1) b.wallbangHits++; }
    if (n === 1) {
      b.first++;
      const cs = isCounterStrafed(s.speed[i], s.maxSpeed[i]);
      if (cs !== null) { b.firstStrafeKnown++; if (cs) b.firstStrafed++; }
      if (hasTarget) { b.firstOnTarget++; if (hit !== null) b.firstHits++; }
    }
    if (n >= SPRAY_FROM_IDX && hasTarget) { b.sprayOnTarget++; if (hit !== null) b.sprayHits++; }
    const imp = s.impact[i];
    const err = s.aimErr[i];
    if (n <= SPRAY_MAX_IDX) {
      if (imp && err) {
        b.ctrlN[n - 1]++;
        b.ctrlSum[n - 1] += angleBetweenDeg([imp[0] / 100, imp[1] / 100], [err[0] / 100, err[1] / 100]);
      }
      const st = (a.spray[w] ??= Array.from({ length: SPRAY_MAX_IDX }, step))[n - 1];
      if (imp) { st.n++; st.sy += imp[0] / 100; st.sp += imp[1] / 100; st.syy += (imp[0] / 100) ** 2; st.spp += (imp[1] / 100) ** 2; }
      if (err) { st.en++; st.ey += err[0] / 100; st.ep += err[1] / 100; }
    }
  });

  // Kill-based aim stats from the kills table (flags: 1 headshot, 2 wallbang, 4 through smoke).
  const k = m.kills;
  for (let i = 0; i < k.ri.length; i++) {
    if (!isFull(k.ri[i]) || k.killer[i] !== m.human) continue;
    if ((k.kBody?.[i] ?? null) !== null || (k.flags[i] & 128) !== 0) continue; // bot body or freeze time
    const victimSide = m.rounds.side[k.ri[i]]?.[k.victim[i]];
    const sd = sideOf(k.ri[i]);
    const cls = weaponClass(m.weapons[k.weapon[i]] ?? "");
    if (!sd || !isGun(cls) || victimSide === m.rounds.side[k.ri[i]]?.[m.human]) continue;
    const b = a.shots[sd][cls];
    b.kills++;
    if (k.flags[i] & 1) b.hsKills++;
    if (k.flags[i] & 2) b.wallbangKills++;
    if (k.flags[i] & 4) b.smokeKills++;
  }
  return a;
}
