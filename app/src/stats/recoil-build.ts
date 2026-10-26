// Builds the in-game spray patterns (recoil.ts) from demo shot tables. Pure: the reading lives in
// tools/recoil.ts. Every number comes from what the game itself recorded for each bullet.
//
// A demo has no aim punch prop (m_aimPunchAngle is not networked to GOTV; extractor/extract.py
// UNAVAILABLE), but every gun shot carries the view angle at weapon_fire (shots.pitch, yaw) and the
// bullet's own direction from fire_bullets (bullet_pitch, bullet_yaw). The game fires each bullet along
// the view plus the aim punch scaled by weapon_recoil_scale, so the bullet's direction minus the view is
// the recoil kick itself, already scaled: the "where the bullet goes with no compensation" offset.
// Recoil in CS2 is set by the shot's recoil index (shots.recoil_index), so the kick at one whole index
// is the same on every spray up to the random spread the game adds after it; the median over pro
// sprays is the pattern.
import { wrap180 } from "./aim-geometry";
import { normalRecoil } from "./shot-state";

/** One shot as the builder reads it from a shots table. */
export interface PatternShot {
  steamid: string;
  tick: number;
  weapon: string;
  recoilIndex: number | null;
  pitch: number | null;
  yaw: number | null;
  bulletPitch: number | null;
  bulletYaw: number | null;
  /** zoomed in; null when not recorded */
  scoped: boolean | null;
  /** the M4A1-S's silencer on; null when not recorded */
  silenced: boolean | null;
  /** at or under the accurate-speed limit and on the ground: a shot whose view movement is a spray's */
  steady: boolean;
}

/** A recoil index within this of a whole number is that bullet; a partly recovered index is left out. */
export const WHOLE_INDEX_EPS = 0.01;

/** Per weapon and bullet (index 0 is bullet 1): the kick samples, and over sprays from a reset the view's change from bullet 1. */
export interface PatternSamples {
  kick: Record<string, { p: number[]; y: number[] }[]>;
  view: Record<string, { p: number[]; y: number[] }[]>;
  sprays: Record<string, number>;
}

export const emptySamples = (): PatternSamples => ({ kick: {}, view: {}, sprays: {} });

const whole = (x: number | null): number | null => {
  if (x === null || !Number.isFinite(x)) return null;
  const r = Math.round(x);
  return Math.abs(x - r) <= WHOLE_INDEX_EPS && r >= 0 ? r : null;
};

/**
 * Adds one map's shots. Only shots known to have their gun's normal recoil count (shot-state.ts
 * normalRecoil: unscoped, the M4A1-S silenced; an unrecorded state is left out). Kick: every such
 * shot of a weapon in `weapons` at a whole recoil index with both angles. View path: runs of one player's shots of one weapon whose indices go 0, 1, 2, ... in tick
 * order, every shot steady; each bullet's view change from bullet 1 (pitch, and yaw summed shot to
 * shot so a turn through 180 degrees stays continuous). A run needs `minBullets` bullets.
 */
export function addShots(acc: PatternSamples, shots: PatternShot[], weapons: ReadonlySet<string>, minBullets: number): void {
  const push = (t: Record<string, { p: number[]; y: number[] }[]>, w: string, j: number, p: number, y: number) => {
    const rows = (t[w] ??= []);
    const b = (rows[j] ??= { p: [], y: [] });
    b.p.push(p);
    b.y.push(y);
  };
  const byPlayer = new Map<string, PatternShot[]>();
  for (const s of shots) {
    if (!weapons.has(s.weapon)) continue;
    const j = whole(s.recoilIndex);
    const normal = normalRecoil(s.weapon, s.scoped, s.silenced) === true;
    if (j !== null && normal && s.pitch !== null && s.yaw !== null && s.bulletPitch !== null && s.bulletYaw !== null) {
      push(acc.kick, s.weapon, j, s.bulletPitch - s.pitch, wrap180(s.bulletYaw - s.yaw));
    }
    const l = byPlayer.get(s.steamid);
    if (l) l.push(s); else byPlayer.set(s.steamid, [s]);
  }
  for (const list of byPlayer.values()) {
    list.sort((a, b) => a.tick - b.tick);
    let run: PatternShot[] = [];
    const flush = () => {
      if (run.length >= minBullets) {
        const w = run[0].weapon;
        acc.sprays[w] = (acc.sprays[w] ?? 0) + 1;
        let yaw = 0;
        run.forEach((s, j) => {
          if (j) yaw += wrap180(s.yaw! - run[j - 1].yaw!);
          push(acc.view, w, j, s.pitch! - run[0].pitch!, yaw);
        });
      }
      run = [];
    };
    for (const s of list) {
      const j = whole(s.recoilIndex);
      const ok = j !== null && s.steady && normalRecoil(s.weapon, s.scoped, s.silenced) === true && s.pitch !== null && s.yaw !== null;
      const next = ok && run.length > 0 && s.weapon === run[0].weapon && j === run.length;
      if (next) { run.push(s); continue; }
      flush();
      if (ok && j === 0) run = [s];
    }
    flush();
  }
}

/** Quantile by linear interpolation between order statistics (q in 0..1). */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  return lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (at - lo) : s[lo];
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

export interface Pattern {
  /** per bullet, the middle half's width of the kick samples [pitch, yaw]: how deterministic the kick is */
  iqr: [number, number][];
  /** index 0 is bullet 1: the kick (bullet direction minus view) relative to bullet 1's, [pitch, yaw], degrees, pitch positive down */
  kick: [number, number][];
  /** the view movement that cancels it: minus kick */
  ideal: [number, number][];
  /** pros' view change from bullet 1 over sprays from a reset: [pitch, yaw, pitchQ25, pitchQ75, yawQ25, yawQ75]; shorter than kick when sprays thin out */
  pro: number[][];
  /** kick samples per bullet */
  n: number[];
  /** pro sprays per bullet */
  proN: number[];
}

/**
 * The pattern of one weapon: bullets while each has at least `minKick` kick samples (and, for the pro
 * band, `minSprays` sprays), stopping at the first bullet short of them. Bullet 1's kick is the
 * reference: the game's first bullet carries none, so it is near 0 and every row is relative to it.
 */
export function patternOf(acc: PatternSamples, weapon: string, minKick: number, minSprays: number): Pattern {
  const k = acc.kick[weapon] ?? [];
  const kick: [number, number][] = [], ideal: [number, number][] = [], n: number[] = [], iqr: [number, number][] = [];
  let k0: [number, number] | null = null;
  for (let j = 0; j < k.length; j++) {
    const b = k[j];
    if (!b || b.p.length < minKick) break;
    const m: [number, number] = [quantile(b.p, 0.5), quantile(b.y, 0.5)];
    k0 ??= m;
    const rel: [number, number] = [r4(m[0] - k0[0]), r4(m[1] - k0[1])];
    kick.push(rel);
    ideal.push([r4(-rel[0]) + 0, r4(-rel[1]) + 0]);
    n.push(b.p.length);
    iqr.push([r4(quantile(b.p, 0.75) - quantile(b.p, 0.25)), r4(quantile(b.y, 0.75) - quantile(b.y, 0.25))]);
  }
  const v = acc.view[weapon] ?? [];
  const pro: number[][] = [], proN: number[] = [];
  for (let j = 0; j < Math.min(v.length, kick.length); j++) {
    const b = v[j];
    if (!b || b.p.length < minSprays) break;
    pro.push([quantile(b.p, 0.5), quantile(b.y, 0.5), quantile(b.p, 0.25), quantile(b.p, 0.75), quantile(b.y, 0.25), quantile(b.y, 0.75)].map(r4));
    proN.push(b.p.length);
  }
  return { kick, ideal, pro, n, proN, iqr };
}

/**
 * Per bullet, the pros' median view change minus the ideal pull: 0 when pros cancel the kick exactly.
 * It also holds whatever the pros' view did besides fighting recoil (following a moving target).
 */
export const residualOf = (p: Pattern): [number, number][] => p.pro.map((row, j) => [r4(row[0] - p.ideal[j][0]), r4(row[1] - p.ideal[j][1])]);
