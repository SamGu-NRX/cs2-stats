// Aim: how a player meets an enemy on screen, and how they shoot. Two inputs feed it.
// - Sightings: engagement windows (SCHEMA-v1.md "Engagements") whose victim becomes visible to the
//   attacker inside the window. Reaction, crosshair placement, time to damage and the mouse-control
//   measures read the per-tick view angles there. They need mesh visibility, so maps without it
//   (pre-v1 folders, visibility_status other than "ok") give no sightings.
// - Shots: every weapon_fire, linked to hits by attacker and tick. Accuracy, first-bullet accuracy,
//   counter-strafing and sprays read them. Plugin recordings (plugin/adapter.ts) have shots without
//   view angles, recoil index or ammo; their sprays read the plugin's own per-shot aim data instead
//   (PluginShots, from the shots columns plugin rows fill).
// Radar `spotted` lags real visibility, so nothing here reads it (architecture.md).
import { ACCURATE_FRAC, aimAngle, aimError, forward, lookAt, SIGHT_CONE_DEG, wrap180 } from "./aim-geometry";
import { MAX_SPEED, RECOIL } from "./aim-ref";
import { enemyHit, type Ctx } from "./derive";
import { isGun } from "./guns";
import type { Metric } from "./metrics";
import { weaponClass } from "./weapons";

// ---- thresholds. "Ours" means no source and no fit. Distributions on the pro maps: pnpm family-check.

/**
 * An enemy counts as on screen when the aim error is within these half-angles: CS2's fixed field of
 * view, 90 degrees across a 4:3 screen and atan(0.75) = 36.87 degrees half-height. A 16:9 screen
 * sees more to the sides, so this is the view every player has. Onsets outside it feed no metric.
 */
export const VIEW_HALF_YAW = 45;
export const VIEW_HALF_PITCH = 36.87;
/**
 * Degrees from the head below which no aiming movement is needed: such a sighting counts as
 * pre-aimed, and reaction and flick measures skip it. Ours; at 1,000 units, 2 degrees is 35 units,
 * about the width of a player model.
 */
export const ON_HEAD_DEG = 2;
/** The movement that answers a sighting is the one that halves the onset error within this time. Ours. */
export const ACQUIRE_FRAC = 0.5;
export const ACQUIRE_WINDOW_S = 1;
/**
 * Time to damage of this or more is not a reaction and the metric leaves it out, as Leetify does. On
 * the pro maps a few percent of the values are 1 s or more and the 95th percentile is under it
 * (VALIDATION.md, pnpm family-check), so the cut drops the stragglers and keeps the pros' body.
 */
export const TTD_MAX_S = 1;
/** That movement's peak speed toward the head must reach this (deg/s), well above idle view drift. Ours, no fit. */
export const PEAK_MIN_DPS = 60;
/** The movement starts at the first tick of the run whose speed toward the head stays at or above this fraction of the peak. Ours, no fit. */
export const ONSET_FRAC = 0.1;
/** A shot this soon after the attacker's previous shot continues firing, so it is not a reaction (the recoil asset's reset spacing). */
export const RESET_GAP_S = 0.3;
/** recoil_index at or below this is a reset weapon (the recoil asset's segmentation rule). */
export const RESET_RECOIL = 0.01;
/** Micro-corrections: separate view movements of at least this speed (deg/s) between the flick and the shot. Ours. */
export const MICRO_DPS = 20;
/** Without a shot, micro-corrections are counted for this long after the flick. Ours. */
export const MICRO_WINDOW_S = 0.5;
/**
 * Tracking starts when the crosshair comes within ON_HEAD_DEG of the head and stops when the error
 * passes TRACK_OFF_DEG or sight is lost. Only ticks where the line of sight turns at TRACK_LOS_DPS or
 * more count, so the target is moving across the view. Both ours, no fit.
 */
export const TRACK_OFF_DEG = 10;
export const TRACK_LOS_DPS = 10;
// SIGHT_CONE_DEG and ACCURATE_FRAC live in aim-geometry.ts, which has no engine imports, so the aim
// panels can state them without loading the engine on the UI thread.
export { ACCURATE_FRAC, SIGHT_CONE_DEG };
/** Counter-strafe errors look at the velocity this long before the shot. Ours, no fit. */
export const CS_HISTORY_S = 0.25;
/** A shot at no more than this fraction of the recent peak speed came during a stop ("too early"). Ours. */
export const CS_DECEL_FRAC = 0.9;
/** Spray transfer: a bullet aims at the visible enemy nearest its direction within this angle. Ours. */
export const TRANSFER_CONE_DEG = 5;
/** A new target counts as a switch once this many consecutive bullets aim at it. Ours. */
export const TRANSFER_HOLD = 2;
/** Sprays shorter than this are bursts (the recoil asset keeps runs of three or more). */
export const SPRAY_MIN = 3;
/**
 * A shot continues a spray when it comes within this many ticks of the weapon's cycle time after the
 * previous one (the recoil asset's segmentation). Ticks quantise the cycle: the AK's 0.1 s is 6.4 ticks
 * at 64/s, so its shots land 6 or 7 ticks apart. On the user's three plugin recordings of 2026-10-25,
 * every gap between two shots of one automatic gun was within one tick of its cycle or 11 ticks or more.
 */
export const CYCLE_TOL_TICKS = 1.01;

// ---- facts

/** One sighting: an engagement whose victim became visible on screen. Times in seconds, angles in degrees. */
export interface SightFact {
  k: "sight";
  ri: number;
  pi: number;
  /** the attacker's weapon at their first shot after the onset; null without one */
  weapon: string | null;
  /** angle from the view to the victim's eye at the onset */
  place: number;
  /** onset to the attacker's first damage on the victim, within the visible stretch (the metric drops TTD_MAX_S and over) */
  ttd: number | null;
  /** onset to the attacker's kill of the victim, within the visible stretch */
  ttk: number | null;
  /** degrees the view turned from the onset to the first damage (the angle between the two view directions) */
  moved: number | null;
  /** onset to the start of the movement that brought the crosshair to the head */
  react: number | null;
  /** onset to the first shot, when the attacker was not already firing */
  shot: number | null;
  /** how far the flick went past the head, along its own direction */
  over: number | null;
  /** separate view movements between the flick and the shot */
  micro: number | null;
  /** ticks tracking a moving target and the sum of their aim errors */
  trackN: number;
  trackSum: number;
}

/** One player's shots with one gun in one round. */
export interface ShotFact {
  k: "shots";
  ri: number;
  pi: number;
  weapon: string;
  shots: number;
  /** shots with at least one enemy hit on the same tick */
  hits: number;
  /** shots with an enemy visible near the view (SIGHT_CONE_DEG), and their hits */
  sight: number;
  sightHits: number;
  /** first bullets (reset recoil, RESET_GAP_S since the last shot) fired at a visible enemy, and their hits */
  first: number;
  firstHits: number;
  /** rifle and sniper first bullets on the ground: [accurate, too early, late reversal, no stop, unknown] */
  cs: number[];
  /**
   * sight shots not fired on a tick where one of the shooter's kills went through a wall or object
   * (kills.penetrated); a sight shot on a kill tick whose penetration is not recorded is set aside, in
   * neither count. And their hits.
   */
  adj: number;
  adjHits: number;
  /** shots on a map with mesh visibility whose smoke state is known (throughSmoke), and those through a smoke */
  smokeKnown: number;
  smoke: number;
}

/** One player's enemy kills with one gun in one round, with the wallbang and smoke flags where the source records them. */
export interface KillAimFact {
  k: "kills";
  ri: number;
  pi: number;
  weapon: string;
  /** kills whose kills.penetrated is recorded, and those with it above 0 */
  wbKnown: number;
  wb: number;
  /** kills whose kills.thrusmoke is recorded, and those through smoke */
  smokeKnown: number;
  smoke: number;
}

/**
 * One spray: three or more shots of one automatic gun in a continuous run from a reset (the recoil
 * asset's rule). Shots without a recoil index or ammo count (plugin recordings) are cut by timing alone:
 * the run starts at a shot RESET_GAP_S after the player's previous one and continues while each shot
 * of the same gun comes within CYCLE_TOL_TICKS of its cycle time.
 */
export interface SprayFact {
  k: "spray";
  ri: number;
  pi: number;
  weapon: string;
  bullets: number;
  /**
   * The path is relative to the target (the plugin's change in aim error, which includes the target's
   * own movement), not the view's absolute change: it is shown, but never compared with the pros'.
   * True for plugin sprays with a bullet lacking view angles (every file before plugin 1.2.0).
   */
  relative: boolean;
  /**
   * View change from the first bullet, pitch and unwrapped yaw, for bullets 2.. while every shot met
   * the asset's filters and the asset has a reference; empty otherwise. Demos and plugin 1.2.0 files
   * give the view angles; on a relative spray it is the view's change relative to the line to the
   * target (aim error at bullet 1 minus aim error at this bullet), which equals the view change when
   * shooter and target hold still.
   */
  dp: number[];
  dy: number[];
  /** target switches (TRANSFER_HOLD bullets on a new visible enemy), and those that hit the new target */
  sw: number;
  swHits: number;
  /** bullets 4 and later fired at a visible enemy (as ShotFact.sight counts them), and those that hit */
  deep: number;
  deepHits: number;
  /**
   * For the bullets of the path (index 0 is bullet 1, then the bullets dp covers): the direction to
   * bullet 1's target's eye, relative to the view at bullet 1 (pitch, and yaw unwrapped as dy is), and
   * the target's eye relative to the bullet's own direction (fire_bullets' angle). Null where the target
   * was not on screen or the shot has no bullet angle; empty when no bullet has a value, and on relative
   * sprays. Demos need the target in one of the shooter's engagements, mesh-visible and not behind a
   * smoke; plugin 1.2.0 files take it from the shot's aim error.
   */
  hp: (number | null)[];
  hy: (number | null)[];
  tp: (number | null)[];
  ty: (number | null)[];
}

export type AimFact = SightFact | ShotFact | SprayFact | KillAimFact;

/**
 * The capture plugin's per-shot aim data, from the shots columns only plugin rows fill (tables.ts
 * SOURCE_COLUMNS), indexed like the shots table.
 */
export interface PluginShots {
  /** [yaw, pitch] degrees the view must turn to reach the target's eye; null without a target */
  err: ([number, number] | null)[];
  /** steamid of the target: the alive enemy nearest the view within 10 degrees; null without one */
  target: (string | null)[];
  /** the target was on screen at the shot (line of sight or the spotted mask); false without a target */
  onScreen: boolean[];
}

// ---- aggregate

export interface AimAgg {
  sightings: number;
  /** sightings with the crosshair within ON_HEAD_DEG */
  preAimed: number;
  /** samples for medians: placement (deg), time to damage, reaction and first shot (s), overshoot (deg) */
  place: number[];
  ttd: number[];
  /** sighting to kill (s), and degrees the view turned from sighting to first damage */
  ttk: number[];
  moved: number[];
  react: number[];
  shot: number[];
  over: number[];
  /** micro-corrections summed over flicks (one flick per overshoot sample) */
  micro: number;
  trackN: number;
  trackSum: number;
  shots: number;
  hits: number;
  sight: number;
  sightHits: number;
  first: number;
  firstHits: number;
  cs: number[];
  sprays: number;
  /** sprays with at least one target switch, switches, and switches that hit the new target */
  swSprays: number;
  switches: number;
  switchHits: number;
  /** bullets compared with the pro path, and sums of the residual's length and pitch part */
  cmp: number;
  dev: number;
  pull: number;
  /** per weapon and bullet (index 0 is bullet 2): bullets, and sums of the view change from bullet 1 */
  path: Record<string, { n: number[]; dp: number[]; dy: number[] }>;
  /** the same for sprays whose path is relative to the target (plugin recordings): shown, not compared with pros */
  relPath: Record<string, { n: number[]; dp: number[]; dy: number[] }>;
  /** per weapon, indexed as path: sums of the squared view change, pitch and yaw, for the spread per bullet */
  spread: Record<string, { pp: number[]; yy: number[] }>;
  /** per weapon and bullet of path's sprays (index 0 is bullet 1): bullets with a value, and sums of SprayFact.hp and hy */
  heads: Record<string, { n: number[]; dp: number[]; dy: number[] }>;
  /** the same for SprayFact.tp and ty: where the target's eye sat from each bullet's direction */
  onTarget: Record<string, { n: number[]; dp: number[]; dy: number[] }>;
  /** ShotFact.adj, adjHits, smokeKnown and smoke summed */
  adj: number;
  adjHits: number;
  smokeShotsKnown: number;
  smokeShots: number;
  /** KillAimFact sums: gun kills with penetration recorded and wallbangs, with thrusmoke recorded and through smoke */
  killsWbKnown: number;
  killsWb: number;
  killsSmokeKnown: number;
  killsSmoke: number;
  /** SprayFact.deep and deepHits summed */
  deep: number;
  deepHits: number;
}

export const emptyAim = (): AimAgg => ({
  sightings: 0, preAimed: 0, place: [], ttd: [], ttk: [], moved: [], react: [], shot: [], over: [], micro: 0, trackN: 0, trackSum: 0,
  shots: 0, hits: 0, sight: 0, sightHits: 0, first: 0, firstHits: 0, cs: [0, 0, 0, 0, 0],
  sprays: 0, swSprays: 0, switches: 0, switchHits: 0, cmp: 0, dev: 0, pull: 0, path: {}, relPath: {}, spread: {}, heads: {}, onTarget: {},
  adj: 0, adjHits: 0, smokeShotsKnown: 0, smokeShots: 0, killsWbKnown: 0, killsWb: 0, killsSmokeKnown: 0, killsSmoke: 0, deep: 0, deepHits: 0,
});

/** Adds per-bullet values (null skipped) into a { n, dp, dy } sum, index for index. */
function addBullets(into: { n: number[]; dp: number[]; dy: number[] }, p: (number | null)[], y: (number | null)[]): void {
  p.forEach((v, j) => {
    if (v === null || y[j] === null) return;
    into.n[j] = (into.n[j] ?? 0) + 1; into.dp[j] = (into.dp[j] ?? 0) + v; into.dy[j] = (into.dy[j] ?? 0) + y[j]!;
  });
}

export function foldAim(a: AimAgg, f: AimFact): void {
  if (f.k === "sight") {
    a.sightings++;
    if (f.place <= ON_HEAD_DEG) a.preAimed++;
    a.place.push(f.place);
    if (f.ttd !== null) a.ttd.push(f.ttd);
    if (f.ttk !== null) a.ttk.push(f.ttk);
    if (f.moved !== null) a.moved.push(f.moved);
    if (f.react !== null) a.react.push(f.react);
    if (f.shot !== null) a.shot.push(f.shot);
    if (f.over !== null) a.over.push(f.over);
    a.micro += f.micro ?? 0;
    a.trackN += f.trackN;
    a.trackSum += f.trackSum;
  } else if (f.k === "shots") {
    a.shots += f.shots; a.hits += f.hits; a.sight += f.sight; a.sightHits += f.sightHits;
    a.first += f.first; a.firstHits += f.firstHits;
    for (let i = 0; i < 5; i++) a.cs[i] += f.cs[i];
    a.adj += f.adj; a.adjHits += f.adjHits; a.smokeShotsKnown += f.smokeKnown; a.smokeShots += f.smoke;
  } else if (f.k === "kills") {
    a.killsWbKnown += f.wbKnown; a.killsWb += f.wb; a.killsSmokeKnown += f.smokeKnown; a.killsSmoke += f.smoke;
  } else {
    a.sprays++;
    if (f.sw > 0) a.swSprays++;
    a.switches += f.sw;
    a.switchHits += f.swHits;
    a.deep += f.deep;
    a.deepHits += f.deepHits;
    if (!f.dp.length) return;
    if (f.relative) {
      const r = (a.relPath[f.weapon] ??= { n: [], dp: [], dy: [] });
      f.dp.forEach((dp, j) => { r.n[j] = (r.n[j] ?? 0) + 1; r.dp[j] = (r.dp[j] ?? 0) + dp; r.dy[j] = (r.dy[j] ?? 0) + f.dy[j]; });
      return;
    }
    const ref = RECOIL[f.weapon].path;
    const w = (a.path[f.weapon] ??= { n: [], dp: [], dy: [] });
    const sq = (a.spread[f.weapon] ??= { pp: [], yy: [] });
    f.dp.forEach((dp, j) => {
      const rp = dp - ref[j + 1][0], ry = f.dy[j] - ref[j + 1][1];
      a.cmp++; a.dev += Math.hypot(rp, ry); a.pull += rp;
      w.n[j] = (w.n[j] ?? 0) + 1; w.dp[j] = (w.dp[j] ?? 0) + dp; w.dy[j] = (w.dy[j] ?? 0) + f.dy[j];
      sq.pp[j] = (sq.pp[j] ?? 0) + dp * dp; sq.yy[j] = (sq.yy[j] ?? 0) + f.dy[j] * f.dy[j];
    });
    if (f.hp.length) addBullets((a.heads[f.weapon] ??= { n: [], dp: [], dy: [] }), f.hp, f.hy);
    if (f.tp.length) addBullets((a.onTarget[f.weapon] ??= { n: [], dp: [], dy: [] }), f.tp, f.ty);
  }
}

/**
 * Share of the player's gun hits fired while an enemy was mesh-visible near the view: how much of their
 * shooting the visibility data explains, which is the visibility coverage meter. Null without hits, and
 * on maps without mesh visibility (no shot there counts as fired at a visible enemy).
 */
export const visibilityCoverage = (a: AimAgg): number | null => (a.hits && a.sightHits ? a.sightHits / a.hits : null);

// ---- derive

type Vec3 = [number, number, number];

export function deriveAim(c: Ctx): AimFact[] {
  const out: AimFact[] = [];
  const view = viewIndex(c);
  if (view?.visible) for (let e = 0; e < c.t.engagements!.n; e++) {
    const f = sighting(c, view, e);
    if (f) out.push(f);
  }
  if (c.t.shots) { shotFacts(c, view, out); killFacts(c, out); }
  return out;
}

/** Enemy gun kills (the kills guns.ts counts per weapon), per round, player and gun, with the source's wallbang and smoke flags. */
function killFacts(c: Ctx, out: AimFact[]): void {
  const K = c.t.kills;
  const row = new Map<string, number>();
  for (let i = 0; i < K.n; i++) row.set(`${K.tick[i]}:${c.idOf(K.attacker_steamid[i])}:${c.pi.get(K.victim_steamid[i])}`, i);
  c.kills.forEach((ks, ri) => {
    const per = new Map<string, KillAimFact>();
    for (const k of ks) {
      if (!k.enemy || k.killer === null || !isGun(k.weapon) || !c.pr[ri]?.[k.killer]) continue;
      const i = row.get(`${k.tick}:${k.killer}:${k.victim}`);
      if (i === undefined) continue;
      const id = `${k.killer}:${k.weapon}`;
      let f = per.get(id);
      if (!f) per.set(id, (f = { k: "kills", ri, pi: k.killer, weapon: k.weapon, wbKnown: 0, wb: 0, smokeKnown: 0, smoke: 0 }));
      const pen = K.penetrated[i], smoke = K.thrusmoke[i];
      if (pen !== null) { f.wbKnown++; if (pen > 0) f.wb++; }
      if (smoke !== null) { f.smokeKnown++; if (smoke) f.smoke++; }
    }
    for (const f of per.values()) out.push(f);
  });
}

interface View {
  /** mesh visibility is valid on this map */
  visible: boolean;
  /** engagement tick rows per engagement row, tick order, cut at either player's death */
  rows: number[][];
  /** engagement tick rows by (tick, attacker) */
  atTick: Map<number, number[]>;
  /** a player's velocity [x, y] at a tick, from any engagement window they are in */
  vel: Map<number, [number, number]>;
  /** shots row by (tick, shooter) */
  shotAt: Map<number, number>;
  /** engagement row of each engagement tick row */
  eng: Int32Array;
}

const key = (tick: number, pi: number) => tick * 256 + pi;
/**
 * Angles in facts keep 0.001 degrees: aim facts shrink from about 115 to 97 KB per map, and nothing
 * reads finer. Adding 0 turns -0 (a level lookAt pitch) into 0, as JSON would.
 */
const r3 = (x: number) => Math.round(x * 1000) / 1000 + 0;

function viewIndex(c: Ctx): View | null {
  const E = c.t.engagements, T = c.t.engagement_ticks;
  if (!E || !T) return null;
  const death = new Map<number, number>();
  c.kills.forEach((ks, ri) => { for (const k of ks) death.set(ri * 1024 + k.victim, k.tick); });
  const ofId = new Map<number, number>();
  for (let e = 0; e < E.n; e++) ofId.set(E.engagement_id[e], e);
  const rows: number[][] = Array.from({ length: E.n }, () => []);
  const eng = new Int32Array(T.n).fill(-1);
  const atTick = new Map<number, number[]>();
  const vel = new Map<number, [number, number]>();
  const cut = E.end_tick.map((end, e) => {
    const ri = c.riOf(E.round[e]);
    const a = c.idOf(E.attacker_steamid[e]), v = c.idOf(E.victim_steamid[e]);
    if (ri === undefined || a === null || v === null) return -1;
    return Math.min(end, death.get(ri * 1024 + a) ?? end, death.get(ri * 1024 + v) ?? end);
  });
  for (let i = 0; i < T.n; i++) {
    const e = ofId.get(T.engagement_id[i]!);
    if (e === undefined || T.tick[i]! > cut[e]) continue;
    // a tick without both players' eyes and the attacker's view cannot be measured
    if (T.a_x[i] === null || T.a_y[i] === null || T.a_eye_z[i] === null || T.a_pitch[i] === null || T.a_yaw[i] === null
      || T.v_x[i] === null || T.v_y[i] === null || T.v_eye_z[i] === null) continue;
    eng[i] = e;
    rows[e].push(i);
    const a = c.idOf(E.attacker_steamid[e])!, v = c.idOf(E.victim_steamid[e])!;
    const k = key(T.tick[i]!, a);
    const l = atTick.get(k);
    if (l) l.push(i); else atTick.set(k, [i]);
    if (T.a_vel_x[i] !== null && T.a_vel_y[i] !== null) vel.set(k, [T.a_vel_x[i]!, T.a_vel_y[i]!]);
    if (T.v_vel_x[i] !== null && T.v_vel_y[i] !== null) vel.set(key(T.tick[i]!, v), [T.v_vel_x[i]!, T.v_vel_y[i]!]);
  }
  for (const r of rows) r.sort((x, y) => T.tick[x]! - T.tick[y]!);
  const shotAt = new Map<number, number>();
  const S = c.t.shots;
  if (S) for (let i = 0; i < S.n; i++) { const p = c.idOf(S.steamid[i]); if (p !== null) shotAt.set(key(S.tick[i], p), i); }
  return { visible: c.t.match.visibility_status[0] === "ok", rows, atTick, vel, shotAt, eng };
}

/** The victim is on screen and not behind a smoke (smoke_blocked is an approximation, SCHEMA-v1.md). */
function seen(c: Ctx, i: number): boolean {
  const T = c.t.engagement_ticks!;
  return T.mesh_visible[i] === true && T.smoke_blocked[i] === false;
}

function sighting(c: Ctx, view: View, e: number): SightFact | null {
  const E = c.t.engagements!, T = c.t.engagement_ticks!;
  const r = view.rows[e];
  const ri = c.riOf(E.round[e]);
  const pi = c.idOf(E.attacker_steamid[e]);
  if (ri === undefined || pi === null || !c.pr[ri]?.[pi] || r.length < 2) return null;
  const rate = c.tickRate;
  const tick = (k: number) => T.tick[r[k]]!;
  const eye = (k: number): Vec3 => [T.a_x[r[k]]!, T.a_y[r[k]]!, T.a_eye_z[r[k]]!];
  const head = (k: number): Vec3 => [T.v_x[r[k]]!, T.v_y[r[k]]!, T.v_eye_z[r[k]]!];
  const err = (k: number) => aimError(T.a_pitch[r[k]]!, T.a_yaw[r[k]]!, eye(k), head(k));
  const angle = (k: number) => aimAngle(T.a_pitch[r[k]]!, T.a_yaw[r[k]]!, eye(k), head(k));
  /** view turn from tick k-1 to tick k, [yaw, pitch] deg/s */
  const turn = (k: number): [number, number] => [wrap180(T.a_yaw[r[k]]! - T.a_yaw[r[k - 1]]!) * rate, (T.a_pitch[r[k]]! - T.a_pitch[r[k - 1]]!) * rate];
  const dot = (u: [number, number], v: [number, number]) => u[0] * v[0] + u[1] * v[1];
  /** speed of the turn into tick k along the direction to the head at tick k-1 */
  const toward = (k: number) => { const d = err(k - 1), n = Math.hypot(d[0], d[1]); return n ? dot(turn(k), d) / n : 0; };

  // The onset: the first visible tick after a tick without sight.
  let o = -1;
  for (let k = 1; k < r.length && o < 0; k++) if (seen(c, r[k]) && !seen(c, r[k - 1])) o = k;
  if (o < 0) return null;
  const e0 = err(o);
  if (Math.abs(e0[0]) > VIEW_HALF_YAW || Math.abs(e0[1]) > VIEW_HALF_PITCH) return null;
  const t0 = tick(o);
  const place = angle(o);

  // Timings run within the visible stretch that starts at the onset: v is the first tick after it
  // (r.length when the enemy stays visible to the window's end). Damage, a shot or a flick after the
  // enemy left sight measures a later sighting, not this one.
  let v = o;
  while (v < r.length && seen(c, r[v])) v++;
  const visibleUntil = v < r.length ? tick(v) : Infinity;

  const fd = E.first_damage_tick[e];
  const ttd = fd !== null && fd >= t0 && fd < visibleUntil ? (fd - t0) / rate : null;
  const victim = c.idOf(E.victim_steamid[e]);
  const kill = c.kills[ri].find((k) => k.killer === pi && k.victim === victim && k.tick >= t0 && k.tick < visibleUntil);
  const ttk = kill ? (kill.tick - t0) / rate : null;
  // the view turn from the onset to the first damage tick (or the nearest tick before it)
  let moved: number | null = null;
  if (ttd !== null) {
    let kd = o;
    while (kd + 1 < v && tick(kd + 1) <= fd!) kd++;
    moved = r3(aimAngle(T.a_pitch[r[o]]!, T.a_yaw[r[o]]!, [0, 0, 0], forward(T.a_pitch[r[kd]]!, T.a_yaw[r[kd]]!)));
  }

  let firing = false;
  for (let k = o - 1; k >= 0 && t0 - tick(k) <= RESET_GAP_S * rate; k--) if (T.a_shot_fired[r[k]]) firing = true;
  let shotK = -1;
  for (let k = o; k < v && shotK < 0; k++) if (T.a_shot_fired[r[k]]) shotK = k;
  const shotRow = shotK < 0 ? undefined : view.shotAt.get(key(tick(shotK), pi));
  const shotWeapon = shotRow === undefined ? null : c.t.shots!.weapon[shotRow];
  const weapon = shotWeapon !== null && isGun(shotWeapon) ? shotWeapon : null;

  let react: number | null = null, over: number | null = null, micro: number | null = null;
  const n0 = Math.hypot(e0[0], e0[1]);
  if (place > ON_HEAD_DEG) {
    let a = -1;
    for (let k = o + 1; k < v && tick(k) - t0 <= ACQUIRE_WINDOW_S * rate && a < 0; k++) {
      const d = err(k);
      if (Math.hypot(d[0], d[1]) <= ACQUIRE_FRAC * n0) a = k;
    }
    let p = -1, peak = -Infinity;
    for (let k = o; k <= a; k++) { const s = toward(k); if (s > peak) { peak = s; p = k; } }
    if (a > 0 && peak >= PEAK_MIN_DPS) {
      let k0 = p;
      while (k0 - 1 >= o && toward(k0 - 1) >= ONSET_FRAC * peak) k0--;
      // k0 === o: the view was already turning toward the enemy when he appeared; not a reaction.
      if (k0 > o) {
        react = (tick(k0) - t0) / rate;
        // The flick, measured along its starting direction u: it ends when the turn along u drops
        // under ONSET_FRAC of the peak; the overshoot is how far past the head it carried.
        const d = err(k0 - 1), m = Math.hypot(d[0], d[1]);
        const u: [number, number] = [d[0] / m, d[1] / m];
        let f = k0;
        while (f + 1 < r.length && (f < p || dot(turn(f + 1), u) >= ONSET_FRAC * peak)) f++;
        over = 0;
        for (let k = k0; k <= f; k++) over = Math.max(over, -dot(err(k), u));
        let end = f;
        while (end + 1 < r.length && !T.a_shot_fired[r[end]] && tick(end + 1) - tick(f) <= MICRO_WINDOW_S * rate) end++;
        micro = 0;
        let moving = Math.hypot(...turn(f)) >= MICRO_DPS;
        for (let k = f + 1; k <= end; k++) {
          const now = Math.hypot(...turn(k)) >= MICRO_DPS;
          if (now && !moving) micro++;
          moving = now;
        }
      }
    }
  }

  let trackN = 0, trackSum = 0, on = false;
  for (let k = o; k < r.length; k++) {
    if (!seen(c, r[k])) { on = false; continue; }
    const ang = angle(k);
    on = on ? ang <= TRACK_OFF_DEG : ang <= ON_HEAD_DEG;
    if (!on || k === o || !seen(c, r[k - 1])) continue;
    const now = lookAt(eye(k), head(k)), before = lookAt(eye(k - 1), head(k - 1));
    if (Math.hypot(wrap180(now.yaw - before.yaw), now.pitch - before.pitch) * rate < TRACK_LOS_DPS) continue;
    trackN++;
    trackSum += ang;
  }

  return {
    k: "sight", ri, pi, weapon, place: r3(place), ttd, ttk, moved, react, shot: !firing && shotK >= 0 ? (tick(shotK) - t0) / rate : null,
    over: over === null ? null : r3(over), micro, trackN, trackSum: r3(trackSum),
  };
}

/**
 * The visible enemy nearest a shot's direction, within `cone` degrees: [victim player, angle], or
 * null. The direction is fire_bullets' bullet angle when present, else the view: in a spray the view
 * sits below the target by the recoil compensation, while the bullet angle follows the target.
 */
function aimedAt(c: Ctx, view: View | null, shot: number, pi: number, cone: number): [number, number] | null {
  if (!view?.visible) return null;
  const S = c.t.shots!, T = c.t.engagement_ticks!, E = c.t.engagements!;
  const pitch = S.bullet_pitch[shot] ?? S.pitch[shot], yaw = S.bullet_yaw[shot] ?? S.yaw[shot];
  if (pitch === null || yaw === null) return null;
  let best: [number, number] | null = null;
  for (const i of view.atTick.get(key(S.tick[shot], pi)) ?? []) {
    if (!seen(c, i)) continue;
    const ang = aimAngle(pitch, yaw, [T.a_x[i]!, T.a_y[i]!, T.a_eye_z[i]!], [T.v_x[i]!, T.v_y[i]!, T.v_eye_z[i]!]);
    if (ang <= cone && (!best || ang < best[1])) best = [c.idOf(E.victim_steamid[view.eng[i]])!, ang];
  }
  return best;
}

/**
 * Whether a shot went through a smoke: every enemy mesh-visible within SIGHT_CONE_DEG of its
 * direction (as aimedAt reads it) is behind one, and there is at least one. False when one of them is
 * clear (a shot at a visible enemy) or none is near; null on maps without mesh visibility, for a shot
 * without angles, and when a candidate's smoke_blocked is not recorded.
 */
function throughSmoke(c: Ctx, view: View | null, shot: number, pi: number): boolean | null {
  if (!view?.visible) return null;
  const S = c.t.shots!, T = c.t.engagement_ticks!;
  const pitch = S.bullet_pitch[shot] ?? S.pitch[shot], yaw = S.bullet_yaw[shot] ?? S.yaw[shot];
  if (pitch === null || yaw === null) return null;
  let smoke = false, unknown = false;
  for (const i of view.atTick.get(key(S.tick[shot], pi)) ?? []) {
    if (T.mesh_visible[i] !== true) continue;
    if (aimAngle(pitch, yaw, [T.a_x[i]!, T.a_y[i]!, T.a_eye_z[i]!], [T.v_x[i]!, T.v_y[i]!, T.v_eye_z[i]!]) > SIGHT_CONE_DEG) continue;
    if (T.smoke_blocked[i] === false) return false;
    if (T.smoke_blocked[i] === true) smoke = true; else unknown = true;
  }
  return unknown ? null : smoke;
}

/** Counter-strafe class of a first bullet: 0 accurate, 1 too early, 2 late reversal, 3 no stop, 4 unknown. */
function strafeClass(c: Ctx, view: View | null, i: number, pi: number): number {
  const S = c.t.shots!;
  const max = MAX_SPEED[S.weapon[i]];
  const limit = ACCURATE_FRAC * (S.scoped[i] && max.length > 1 ? max[1] : max[0]);
  const s0 = S.speed_2d[i];
  if (s0 === null) return 4;
  if (s0 <= limit) return 0;
  let peak = 0, pv: [number, number] | null = null;
  for (let j = 1; j <= Math.round(CS_HISTORY_S * c.tickRate); j++) {
    const v = view?.vel.get(key(S.tick[i] - j, pi));
    if (v && Math.hypot(v[0], v[1]) > peak) { peak = Math.hypot(v[0], v[1]); pv = v; }
  }
  if (!pv || S.vel_x[i] === null || S.vel_y[i] === null) return 4;
  if (peak <= s0) return 3;
  if (S.vel_x[i]! * pv[0] + S.vel_y[i]! * pv[1] < 0) return 2;
  return s0 <= CS_DECEL_FRAC * peak ? 1 : 3;
}

/**
 * The recoil asset's per-shot filter for reference sprays (recoil_patterns.json methodology.filtering).
 * Plugin shots record only speed and scope, so for them the airborne, flash, pitch and silencer tests
 * are skipped.
 */
function refEligible(c: Ctx, i: number, plugin: boolean): boolean {
  const S = c.t.shots!;
  const w = S.weapon[i];
  const steady = S.speed_2d[i] !== null && S.scoped[i] === false && S.speed_2d[i]! <= ACCURATE_FRAC * MAX_SPEED[w][0];
  if (plugin) return steady;
  return steady && S.pitch[i] !== null && S.yaw[i] !== null && S.airborne[i] === false
    && S.flash_duration[i] !== null && S.flash_duration[i]! <= 0 && Math.abs(S.pitch[i]!) < 85
    && (w !== "m4a1_silencer" || S.silenced[i] === true);
}

/** The plugin's per-shot aim data, or null when no shot carries it (every source but the plugin). */
function pluginShots(c: Ctx): PluginShots | null {
  const S = c.t.shots!;
  if (!S.target_on_screen.some((x) => x !== null)) return null;
  return {
    err: S.aim_err_yaw.map((y, i) => (y === null || S.aim_err_pitch[i] === null ? null : [y, S.aim_err_pitch[i]!])),
    target: S.target_steamid,
    onScreen: S.target_on_screen.map((x) => x === true),
  };
}

/** A plugin shot's on-screen target within `cone` degrees of the view, as a player index; null otherwise. */
function pluginAimedAt(c: Ctx, ps: PluginShots, i: number, cone: number): number | null {
  const e = ps.err[i];
  if (!ps.onScreen[i] || !e) return null;
  return aimAngle(0, 0, [0, 0, 0], forward(e[1], e[0])) <= cone ? c.idOf(ps.target[i]) : null;
}

function shotFacts(c: Ctx, view: View | null, out: AimFact[]): void {
  const S = c.t.shots!, D = c.t.damages;
  const rate = c.tickRate;
  const ps = pluginShots(c);
  // Enemies hit by gunfire, by (tick, attacker). A bullet's hit lands on its shot's tick; damages
  // names some guns differently from shots (m4a1 for the M4A1-S, hkp2000 for the USP-S), so the
  // link is by tick and attacker only.
  const hitOn = new Map<number, Set<number>>();
  for (let i = 0; i < D.n; i++) {
    if (!enemyHit(c.t, i) || !D.weapon[i] || !isGun(D.weapon[i]!)) continue;
    const k = key(D.tick[i], c.idOf(D.attacker_steamid[i])!);
    const v = c.pi.get(D.victim_steamid[i])!;
    const s = hitOn.get(k);
    if (s) s.add(v); else hitOn.set(k, new Set([v]));
  }
  // Kill ticks by (tick, killer): "wall" when a kill there went through a wall or object, "unknown"
  // when one has no penetration recorded, else "clear". Adjusted accuracy leaves out the first two.
  const killAt = new Map<number, "wall" | "unknown" | "clear">();
  const K = c.t.kills;
  for (let i = 0; i < K.n; i++) {
    const p = c.idOf(K.attacker_steamid[i]);
    if (p === null) continue;
    const k = key(K.tick[i], p), pen = K.penetrated[i], was = killAt.get(k);
    const now = pen === null ? "unknown" : pen > 0 ? "wall" : "clear";
    if (was !== "wall" && (was !== "unknown" || now === "wall")) killAt.set(k, now);
  }

  c.byRound("shots").forEach((rowsOfRound, ri) => {
    const byPlayer = new Map<number, number[]>();
    for (const i of rowsOfRound) {
      const p = c.idOf(S.steamid[i]);
      if (p === null || !c.pr[ri]?.[p]) continue;
      const l = byPlayer.get(p);
      if (l) l.push(i); else byPlayer.set(p, [i]);
    }
    for (const [pi, list] of byPlayer) {
      list.sort((x, y) => S.tick[x] - S.tick[y]);
      const perGun = new Map<string, ShotFact>();
      let run: number[] = [];
      const finish = () => { if (run.length >= SPRAY_MIN) out.push(spray(c, view, ps, ri, pi, run, hitOn)); run = []; };
      let prev = -1;
      for (const i of list) {
        const w = S.weapon[i];
        const spaced = prev < 0 || (S.tick[i] - S.tick[prev]) / rate >= RESET_GAP_S;
        const reset = S.recoil_index[i] !== null && S.recoil_index[i]! >= 0 && S.recoil_index[i]! <= RESET_RECOIL && spaced;
        if (isGun(w)) {
          let f = perGun.get(w);
          if (!f) perGun.set(w, (f = { k: "shots", ri, pi, weapon: w, shots: 0, hits: 0, sight: 0, sightHits: 0, first: 0, firstHits: 0, cs: [0, 0, 0, 0, 0], adj: 0, adjHits: 0, smokeKnown: 0, smoke: 0 }));
          const h = hitOn.has(key(S.tick[i], pi));
          f.shots++;
          if (h) f.hits++;
          if (aimedAt(c, view, i, pi, SIGHT_CONE_DEG)) {
            f.sight++;
            if (h) f.sightHits++;
            if (reset) { f.first++; if (h) f.firstHits++; }
            if ((killAt.get(key(S.tick[i], pi)) ?? "clear") === "clear") { f.adj++; if (h) f.adjHits++; }
          }
          const smoked = throughSmoke(c, view, i, pi);
          if (smoked !== null) { f.smokeKnown++; if (smoked) f.smoke++; }
          const cls = weaponClass(w);
          if (reset && (cls === "rifle" || cls === "sniper") && S.airborne[i] === false && S.speed_2d[i] !== null) f.cs[strafeClass(c, view, i, pi)]++;
        }
        // Spray runs, as recoil_patterns.json methodology.segmentation describes them. Shots without a
        // recoil index or ammo count (plugin recordings) are cut by timing alone, and a run starts at a
        // spaced shot: a shot after a shorter pause fires with recoil not yet reset, so it cannot be bullet 1.
        const ref = RECOIL[w];
        const last = run[run.length - 1];
        const timed = run.length > 0 && [S.recoil_index[i], S.recoil_index[last], S.ammo_clip[i], S.ammo_clip[last]].includes(null);
        const continuous = ref && run.length > 0 && S.weapon[last] === w && run.length < ref.mag
          && Math.abs((S.tick[i] - S.tick[last]) / rate - ref.cycle) <= CYCLE_TOL_TICKS / rate
          && (timed || (Math.abs(S.recoil_index[i]! - S.recoil_index[last]! - 1) <= 0.05 && S.ammo_clip[i] === S.ammo_clip[last]! - 1));
        if (continuous) run.push(i);
        else { finish(); if (ref && (S.recoil_index[i] === null ? spaced : reset)) run = [i]; }
        prev = i;
      }
      finish();
      for (const f of perGun.values()) out.push(f);
    }
  });
}

function spray(c: Ctx, view: View | null, ps: PluginShots | null, ri: number, pi: number, run: number[], hitOn: Map<number, Set<number>>): SprayFact {
  const S = c.t.shots!;
  const weapon = S.weapon[run[0]];
  const ref = RECOIL[weapon].path;
  // The reference part: the run's prefix whose every shot passes the asset's filters and was fired with
  // an enemy on screen, so the path is a spray at someone, comparable with the pros'. On screen: in one
  // of the shooter's engagements, mesh-visible and not behind a smoke; for plugin shots, bullet 1's
  // target on screen by the plugin's own test (an aim error to another enemy is not a path).
  const target0 = ps?.target[run[0]] ?? null;
  const atVisible = ps
    ? (i: number) => ps.onScreen[i] && ps.err[i] !== null && ps.target[i] === target0
    : (i: number) => !!view?.visible && (view.atTick.get(key(S.tick[i], pi)) ?? []).some((row) => seen(c, row));
  let n = 0;
  while (n < run.length && refEligible(c, run[n], ps !== null) && atVisible(run[n])) n++;
  const dp: number[] = [], dy: number[] = [];
  // plugin shots give an absolute path only when every bullet carries view angles (plugin 1.2.0); else
  // the path is relative to the target and is not compared with the pros'
  const relative = ps !== null && run.slice(0, Math.max(n, 1)).some((i) => S.pitch[i] === null || S.yaw[i] === null);
  if (n >= SPRAY_MIN && relative) {
    const e0 = ps.err[run[0]]!;
    for (let j = 1; j < Math.min(n, ref.length); j++) {
      const e = ps.err[run[j]]!;
      dp.push(r3(e0[1] - e[1]));
      dy.push(r3(wrap180(e0[0] - e[0])));
    }
  } else if (n >= SPRAY_MIN) {
    let yaw = 0;
    for (let j = 1; j < Math.min(n, ref.length); j++) {
      yaw += wrap180(S.yaw[run[j]]! - S.yaw[run[j - 1]]!);
      dp.push(r3(S.pitch[run[j]]! - S.pitch[run[0]]!));
      dy.push(r3(yaw));
    }
  }
  // Target switches: the aimed-at enemy changes and the new one holds for TRANSFER_HOLD bullets.
  let sw = 0, swHits = 0, cur: number | null = null;
  const target = run.map((i) => (ps ? pluginAimedAt(c, ps, i, TRANSFER_CONE_DEG) : aimedAt(c, view, i, pi, TRANSFER_CONE_DEG)?.[0] ?? null));
  for (let j = 0; j < run.length; j++) {
    const t = target[j];
    if (t === null || t === cur) continue;
    if (cur === null) { cur = t; continue; }
    let hold = 1;
    while (hold < TRANSFER_HOLD && j + hold < run.length && target[j + hold] === t) hold++;
    if (hold < TRANSFER_HOLD) continue;
    sw++;
    cur = t;
    if (run.slice(j).some((i) => hitOn.get(key(S.tick[i], pi))?.has(t))) swHits++;
  }
  // Spray accuracy: bullets 4 and later fired at a visible enemy, as first-bullet accuracy counts them.
  let deep = 0, deepHits = 0;
  for (let j = 3; j < run.length; j++) {
    if (!aimedAt(c, view, run[j], pi, SIGHT_CONE_DEG)) continue;
    deep++;
    if (hitOn.has(key(S.tick[run[j]], pi))) deepHits++;
  }
  const { hp, hy, tp, ty } = relative || !dp.length ? { hp: [], hy: [], tp: [], ty: [] } : targetPath(c, view, ps, pi, run.slice(0, dp.length + 1), dy);
  return { k: "spray", ri, pi, weapon, bullets: run.length, relative, dp, dy, sw, swHits, deep, deepHits, hp, hy, tp, ty };
}

/**
 * SprayFact.hp, hy, tp and ty for a spray's path bullets (`bullets`, bullet 1 first; `dy` the path's
 * unwrapped yaw change for bullets 2..). The target is bullet 1's: on a demo the visible enemy nearest
 * its direction (aimedAt), looked up in the shooter's engagement rows at each bullet; on a plugin file
 * the shot's own target, whose eye sits at the view plus the aim error.
 */
function targetPath(c: Ctx, view: View | null, ps: PluginShots | null, pi: number, bullets: number[], dy: number[]) {
  const S = c.t.shots!, T = c.t.engagement_ticks, E = c.t.engagements;
  const target = ps ? null : aimedAt(c, view, bullets[0], pi, SIGHT_CONE_DEG)?.[0] ?? null;
  /** the pitch and yaw from the shooter's eye to the target's eye at bullet j; null when not known */
  const eyeAt = (j: number): { pitch: number; yaw: number } | null => {
    const i = bullets[j];
    if (ps) {
      const e = ps.err[i];
      return e && S.pitch[i] !== null && S.yaw[i] !== null ? { pitch: S.pitch[i]! + e[1], yaw: S.yaw[i]! + e[0] } : null;
    }
    if (target === null || !view || !T || !E) return null;
    const row = (view.atTick.get(key(S.tick[i], pi)) ?? []).find((r) => c.idOf(E.victim_steamid[view.eng[r]]) === target && seen(c, r));
    return row === undefined ? null : lookAt([T.a_x[row]!, T.a_y[row]!, T.a_eye_z[row]!], [T.v_x[row]!, T.v_y[row]!, T.v_eye_z[row]!]);
  };
  const hp: (number | null)[] = [], hy: (number | null)[] = [], tp: (number | null)[] = [], ty: (number | null)[] = [];
  const p0 = S.pitch[bullets[0]]!;
  bullets.forEach((i, j) => {
    const want = eyeAt(j);
    const bp = S.bullet_pitch[i], by = S.bullet_yaw[i];
    hp.push(want ? r3(want.pitch - p0) : null);
    hy.push(want ? r3((j ? dy[j - 1] : 0) + wrap180(want.yaw - S.yaw[i]!)) : null);
    tp.push(want && bp !== null && by !== null ? r3(want.pitch - bp) : null);
    ty.push(want && bp !== null && by !== null ? r3(wrap180(want.yaw - by)) : null);
  });
  const none = (xs: (number | null)[]) => xs.every((x) => x === null);
  return { hp: none(hp) ? [] : hp, hy: none(hp) ? [] : hy, tp: none(tp) ? [] : tp, ty: none(tp) ? [] : ty };
}

// ---- metrics

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ms = (secs: number | null) => (secs === null ? null : 1000 * secs);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const per = (a: number, b: number) => (b > 0 ? a / b : null);
const csKnown = (s: { aim: AimAgg }) => s.aim.cs[1] + s.aim.cs[2] + s.aim.cs[3];
/** How sprays differ on plugin recordings, which have no recoil index or ammo count (and before plugin 1.2.0 no view angles). */
const PLUGIN_SPRAYS = `On plugin recordings a spray is cut by timing alone (shots of one gun each within one tick of its cycle time, from a shot ${RESET_GAP_S} s after the previous one), and only speed and scope filter its bullets.`;
const PLUGIN_PATH = "Plugin 1.2.0 records view angles, so its sprays use them as a demo's do. On earlier plugin files the path is the change in aim error to bullet 1's target (the alive enemy nearest the view within 10 degrees, on screen by the plugin's line of sight, else the game's spotted flags), which includes the target's own movement: those sprays are shown relative to the target and are not compared with the pros.";

export const AIM_METRICS: Metric[] = [
  { id: "timeToDamage", label: "Time to damage", kind: "performance", group: "aim", unit: "ms", status: "approx", lowerIsBetter: true,
    def: `Median time from an enemy becoming visible on your screen (mesh line of sight, not behind a smoke, within 45 by 36.87 degrees of your view) to your first damage on him while he stayed visible; values of ${TTD_MAX_S} s or more are left out, as Leetify does.`,
    value: (s) => ms(median(s.aim.ttd.filter((x) => x < TTD_MAX_S))) },
  { id: "timeToKill", label: "Time to kill", kind: "performance", group: "aim", unit: "ms", status: "approx", lowerIsBetter: true,
    def: "Median time from an enemy becoming visible on your screen to your kill on him while he stayed visible.",
    value: (s) => ms(median(s.aim.ttk)) },
  { id: "reactionTime", label: "Reaction time", kind: "performance", group: "aim", unit: "ms", status: "approx", lowerIsBetter: true,
    def: `Median time from a sighting to the start of the mouse movement that halves the error to his head within ${ACQUIRE_WINDOW_S} s. The movement must peak at ${PEAK_MIN_DPS} deg/s or more toward the head; it starts where its speed first stays above ${ONSET_FRAC * 100}% of that peak. Sightings within ${ON_HEAD_DEG} degrees of the head, and movements already under way at the onset, are left out.`,
    value: (s) => ms(median(s.aim.react)) },
  { id: "timeToShot", label: "Time to first shot", kind: "performance", group: "aim", unit: "ms", status: "approx", lowerIsBetter: true,
    def: `Median time from a sighting to your first shot, leaving out sightings where you had fired in the ${RESET_GAP_S} s before it.`,
    value: (s) => ms(median(s.aim.shot)) },
  { id: "crosshairPlacement", label: "Crosshair placement", kind: "performance", group: "aim", unit: "deg", status: "approx", lowerIsBetter: true,
    def: "Median angle between your view and the enemy's eye at the first tick he is visible on your screen.",
    value: (s) => median(s.aim.place) },
  { id: "crosshairMoved", label: "Degrees moved to damage", kind: "performance", group: "aim", unit: "deg", status: "approx", lowerIsBetter: true,
    def: "Median angle your view turned from the tick an enemy became visible to your first damage on him (Leetify reports it beside the error at sighting): placement says where the crosshair was, this how far it had to travel.",
    value: (s) => median(s.aim.moved) },
  { id: "preAim", label: "Pre-aimed sightings", kind: "performance", group: "aim", unit: "pct", status: "approx",
    def: `Sightings where your crosshair was already within ${ON_HEAD_DEG} degrees of the enemy's eye when he became visible.`,
    value: (s) => pct(s.aim.preAimed, s.aim.sightings) },
  { id: "flickOvershoot", label: "Flick overshoot", kind: "performance", group: "aim", unit: "deg", status: "approx", lowerIsBetter: true,
    def: `Median angle by which a reaction flick carried past the head, measured along the flick's starting direction until its speed dropped under ${ONSET_FRAC * 100}% of its peak (0 when it stopped short).`,
    value: (s) => median(s.aim.over) },
  { id: "microCorrections", label: "Micro-corrections per flick", kind: "performance", group: "aim", unit: "count", status: "approx", lowerIsBetter: true,
    def: `Separate view movements of ${MICRO_DPS} deg/s or more after a reaction flick ends and before the first shot (or ${MICRO_WINDOW_S} s), per flick.`,
    value: (s) => per(s.aim.micro, s.aim.over.length) },
  { id: "trackingError", label: "Tracking error", kind: "performance", group: "aim", unit: "deg", status: "approx", lowerIsBetter: true,
    def: `Mean angle to the enemy's eye while tracking him: from the crosshair reaching ${ON_HEAD_DEG} degrees of the head until it passes ${TRACK_OFF_DEG} degrees or sight is lost, on ticks where the line of sight turns at ${TRACK_LOS_DPS} deg/s or more.`,
    value: (s) => per(s.aim.trackSum, s.aim.trackN) },
  { id: "accuracy", label: "Accuracy", kind: "performance", group: "aim", unit: "pct", status: "exact",
    def: "Gun shots that hit an enemy (a hit on the same tick by the same player), of all gun shots. Filter by weapon for accuracy per gun.",
    value: (s) => pct(s.aim.hits, s.aim.shots) },
  { id: "sightAccuracy", label: "Accuracy at visible enemies", kind: "performance", group: "aim", unit: "pct", status: "approx",
    def: `Hits per gun shot fired while an enemy was mesh-visible within ${SIGHT_CONE_DEG} degrees of the view.`,
    value: (s) => pct(s.aim.sightHits, s.aim.sight) },
  { id: "headAccuracy", label: "Head accuracy", kind: "performance", group: "aim", unit: "pct", status: "exact",
    def: "Gun hits on the head, of all your gun hits on enemies (a hit the game files under no body part counts in the total only).",
    value: (s) => { let head = 0, hits = 0; for (const [w, t] of Object.entries(s.weapons)) if (isGun(w)) { head += t.groups[0]; hits += t.hits; } return pct(head, hits); } },
  { id: "adjustedAccuracy", label: "Adjusted accuracy", kind: "performance", group: "aim", unit: "pct", status: "approx",
    def: `Accuracy at visible enemies without the shots fired on a tick where your kill went through a wall or object (the game's penetration flag); a kill shot whose penetration is not recorded is set aside. Shots at an enemy behind a smoke are already out of the visible-enemy shots.`,
    value: (s) => pct(s.aim.adjHits, s.aim.adj) },
  { id: "shotsThroughSmoke", label: "Shots through smoke", kind: "identity", group: "aim", unit: "pct", status: "approx",
    def: `Gun shots fired while every enemy mesh-visible within ${SIGHT_CONE_DEG} degrees of the shot stood behind a smoke (the extractor's smoke spheres, an approximation), of your gun shots on maps with mesh visibility.`,
    value: (s) => pct(s.aim.smokeShots, s.aim.smokeShotsKnown) },
  { id: "sprayAccuracy", label: "Spray accuracy", kind: "performance", group: "aim", unit: "pct", status: "approx",
    def: `Hits per bullet 4 and later of a spray fired at an enemy mesh-visible within ${SIGHT_CONE_DEG} degrees. A spray is ${SPRAY_MIN} or more shots of one automatic gun in a continuous run from a reset (the recoil asset's rule).`,
    value: (s) => pct(s.aim.deepHits, s.aim.deep) },
  { id: "firstBulletAccuracy", label: "First-bullet accuracy", kind: "performance", group: "aim", unit: "pct", status: "approx",
    def: `Hits per first bullet (recoil index reset, ${RESET_GAP_S} s since your previous shot) fired at a visible enemy within ${SIGHT_CONE_DEG} degrees.`,
    value: (s) => pct(s.aim.firstHits, s.aim.first) },
  { id: "counterStrafe", label: "Counter-strafed first shots", kind: "performance", group: "aim", unit: "pct", status: "approx",
    def: `Rifle and sniper first bullets fired on the ground at or under ${ACCURATE_FRAC * 100}% of the weapon's max speed (scoped speed when scoped; the game's weapon data).`,
    value: (s) => pct(s.aim.cs[0], s.aim.cs.reduce((a, b) => a + b, 0)) },
  { id: "csTooEarly", label: "Shot during the stop", kind: "identity", group: "aim", unit: "pct", status: "approx",
    def: `Of first bullets fired too fast with the last ${CS_HISTORY_S} s of velocity known: still slowing down, at or under ${CS_DECEL_FRAC * 100}% of the recent peak speed and in the same direction.`,
    value: (s) => pct(s.aim.cs[1], csKnown(s)) },
  { id: "csLateReversal", label: "Late reversal", kind: "identity", group: "aim", unit: "pct", status: "approx",
    def: `Of first bullets fired too fast with the last ${CS_HISTORY_S} s of velocity known: moving against the direction of the recent peak speed (held the counter-strafe key too long).`,
    value: (s) => pct(s.aim.cs[2], csKnown(s)) },
  { id: "csNoStop", label: "No counter-strafe", kind: "identity", group: "aim", unit: "pct", status: "approx",
    def: `Of first bullets fired too fast with the last ${CS_HISTORY_S} s of velocity known: no stop attempted (speed above ${CS_DECEL_FRAC * 100}% of the recent peak, or rising).`,
    value: (s) => pct(s.aim.cs[3], csKnown(s)) },
  { id: "sprayDeviation", label: "Spray path vs pros", kind: "identity", group: "aim", unit: "deg", status: "approx",
    def: `Mean distance per bullet between your view path in a spray (relative to the first bullet) and the median pro compensation path for that gun and bullet (recoil_patterns.json, provisional). Relative to pro compensation, not a grade: target movement changes the path too. ${PLUGIN_SPRAYS} ${PLUGIN_PATH}`,
    value: (s) => per(s.aim.dev, s.aim.cmp) },
  { id: "sprayPull", label: "Spray pull-down vs pros", kind: "identity", group: "aim", unit: "deg", status: "approx",
    def: `Mean pitch difference per bullet from the median pro compensation path: positive pulls down more than pros, negative less. ${PLUGIN_SPRAYS} ${PLUGIN_PATH}`,
    value: (s) => per(s.aim.pull, s.aim.cmp) },
  { id: "sprayTransfers", label: "Spray transfers", kind: "identity", group: "aim", unit: "pct", status: "approx",
    def: `Sprays (${SPRAY_MIN}+ bullets) where you switched targets: the enemy nearest your view (within ${TRANSFER_CONE_DEG} degrees, visible) changed and the new one stayed nearest for ${TRANSFER_HOLD} bullets. ${PLUGIN_SPRAYS} The nearest enemy there is the plugin's shot target, when on screen.`,
    value: (s) => pct(s.aim.swSprays, s.aim.sprays) },
  { id: "transferHits", label: "Spray transfers that hit", kind: "performance", group: "aim", unit: "pct", status: "approx",
    def: `Target switches inside a spray where the rest of the spray hit the new target. ${PLUGIN_SPRAYS}`,
    value: (s) => pct(s.aim.switchHits, s.aim.switches) },
];
