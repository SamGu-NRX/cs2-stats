// Movement style: how a player peeks, how long they stand in an enemy's sight before shooting, how
// fast they move early in the round, and how much they crouch. All identity metrics.
//
// Peeks need tick resolution (a shoulder peek exposes a player for a fraction of a second), so they
// come from engagement_ticks, which v1 maps have and only where visibility_status is "ok". Speed
// and crouch time come from the 4 Hz positions.
//
// An exposure is a run of ticks with mesh line of sight from the player's eye to the enemy's eye or
// chest, not blocked by smoke (SCHEMA-v1.md, Visibility). A peek that shows only a shoulder or an arm
// never opens that line, so the mesh test cannot see the purest shoulder peeks; ours are the ones
// that showed the head or chest.
import type { Ctx } from "./derive";
import { isGun } from "./guns";
import type { Metric } from "./metrics";

/**
 * A player moving at least this fast (2D, units/s) when an exposure began caused it: they were
 * moving, not holding. Ours, no fit: shots are inaccurate above about 34% of max speed, about 73 u/s
 * for an AK-47 (research-data-sources.md, counter-strafe).
 */
export const PEEK_MIN_SPEED = 75;
/** Sight breaks shorter than this (1 to 3 ticks at 64 tick) are mesh flicker and join the exposures on either side. Ours, no fit. */
export const EXPOSURE_GAP_S = 0.05;
/**
 * A shoulder peek exposes the player for at most this long. Ours, no fit: the informal figure is about
 * 50 ms (research-data-sources.md), and mesh onsets lag a real peek, so the cut is longer.
 */
export const SHOULDER_MAX_S = 0.3;
/** The reversal that ends a shoulder peek may come this long after sight breaks, because the enemy moves too. Ours, no fit. */
export const REVERSAL_SLACK_S = 0.25;
/** Shoulder peeks at the same enemy whose onsets are at most this far apart form a jiggle. Ours: the engagement merge gap (SCHEMA-v1.md), so a jiggle stays in one window. */
export const JIGGLE_GAP_S = 1.5;
/** A wide peek keeps moving in its onset direction: at least WIDE_MIN_TRAVEL units in the first WIDE_WINDOW_S. */
export const WIDE_WINDOW_S = 0.5;
/** Ours, no fit: two player widths (the player hull is 32 units wide). A rifle at 215 u/s covers 107 units in 0.5 s. */
export const WIDE_MIN_TRAVEL = 64;

export type MoveFact =
  | {
      k: "round"; ri: number; pi: number;
      /** 4 Hz position samples from freeze end to round end while alive, and how many were crouched */
      alive: number; crouched: number;
      /** 2D speed summed over alive samples in the opening phase (openingEnd), and their count */
      speedSum: number; speedN: number;
      /** peeks (exposures the player caused) and their classes; a jiggle peek is also a shoulder peek */
      peeks: number; shoulder: number; jiggle: number; wide: number;
    }
  | {
      k: "weapon"; ri: number; pi: number; weapon: string;
      /** gun shots with a known crouch state, and how many were fired crouched */
      shots: number; crouched: number;
      /** seconds from the onset of an exposure to the player's first shot in it, one per engagement */
      exposures: number[];
    };

export interface MoveAgg {
  alive: number; crouched: number; speedSum: number; speedN: number;
  peeks: number; shoulder: number; jiggle: number; wide: number;
  shots: number; crouchedShots: number; exposures: number[];
}

export const emptyMove = (): MoveAgg => ({
  alive: 0, crouched: 0, speedSum: 0, speedN: 0, peeks: 0, shoulder: 0, jiggle: 0, wide: 0, shots: 0, crouchedShots: 0, exposures: [],
});

export function foldMove(a: MoveAgg, f: MoveFact): void {
  if (f.k === "weapon") {
    a.shots += f.shots;
    a.crouchedShots += f.crouched;
    for (const x of f.exposures) a.exposures.push(x);
    return;
  }
  a.alive += f.alive; a.crouched += f.crouched; a.speedSum += f.speedSum; a.speedN += f.speedN;
  a.peeks += f.peeks; a.shoulder += f.shoulder; a.jiggle += f.jiggle; a.wide += f.wide;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Position rows by round and player (key ri * 1024 + pi), in tick order. Empty without positions. */
export function tracks(c: Ctx): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const P = c.t.positions;
  if (!P) return out;
  for (let i = 0; i < P.n; i++) {
    const p = c.pi.get(P.steamid[i]);
    if (p === undefined) continue;
    const ri = c.riOf(P.round[i]);
    if (ri === undefined) continue;
    const key = ri * 1024 + p;
    let l = out.get(key);
    if (!l) out.set(key, (l = []));
    l.push(i);
  }
  for (const l of out.values()) l.sort((a, b) => P.tick[a] - P.tick[b]);
  return out;
}

/**
 * The end of a player's opening phase: the round's first enemy kill, the player's death, or the
 * round end, whichever is first. Speed and push depth are measured from freeze end to here, because
 * after the first kill players react to it rather than to their plan.
 */
export function openingEnd(c: Ctx, ri: number, pi: number): number {
  let end = c.rounds[ri].endTick;
  for (const k of c.kills[ri]) {
    if (k.enemy || k.victim === pi) { end = Math.min(end, k.tick); break; }
  }
  return end;
}

/** One stretch of ticks in an engagement window where the attacker sees the victim: [on, off) as row indexes. */
export interface Exposure { on: number; off: number; observed: boolean }

/** Visible means mesh line of sight that no smoke blocks; an unknown smoke state is not visible. */
const seen = (c: Ctx, i: number) => c.t.engagement_ticks!.mesh_visible[i] === true && c.t.engagement_ticks!.smoke_blocked[i] === false;

/**
 * The exposures in one engagement window (rows a..b-1 of engagement_ticks). Gaps under EXPOSURE_GAP_S
 * are merged. An exposure that is already open at the window's first tick continues one from before
 * the window, so its onset was not observed.
 */
export function exposures(c: Ctx, a: number, b: number): Exposure[] {
  const E = c.t.engagement_ticks!;
  const gap = EXPOSURE_GAP_S * c.tickRate;
  const out: Exposure[] = [];
  for (let i = a; i < b; i++) {
    if (!seen(c, i)) continue;
    const last = out[out.length - 1];
    if (last && E.tick[i] - E.tick[last.off - 1] <= gap) last.off = i + 1;
    else out.push({ on: i, off: i + 1, observed: i > a });
  }
  return out;
}

/** Each engagement's row range in engagement_ticks, which the extractor writes sorted by (engagement_id, tick). */
export function engagementRows(c: Ctx): Map<number, [number, number]> {
  const E = c.t.engagement_ticks;
  const out = new Map<number, [number, number]>();
  if (!E) return out;
  for (let i = 0; i < E.n; ) {
    let j = i + 1;
    while (j < E.n && E.engagement_id[j] === E.engagement_id[i]) j++;
    out.set(E.engagement_id[i], [i, j]);
    i = j;
  }
  return out;
}

/**
 * Classifies one exposure the attacker caused (onset velocity non-null), from the attacker's velocity
 * and position per tick up to the window's last row `end - 1`. `shot`: they fired a gun in it.
 */
function classifyPeek(c: Ctx, e: Exposure, end: number, shot: boolean): "shoulder" | "wide" | "other" | null {
  const E = c.t.engagement_ticks!;
  const { a_vel_x: vx, a_vel_y: vy, a_x: x, a_y: y, tick } = E;
  const ux = vx[e.on], uy = vy[e.on];
  if (ux === null || uy === null) return null;
  const dur = (tick[e.off - 1] + 1 - tick[e.on]) / c.tickRate;
  if (dur <= SHOULDER_MAX_S && !shot) {
    // the reversal comes after sight breaks, within the slack
    const until = tick[e.off - 1] + REVERSAL_SLACK_S * c.tickRate;
    for (let i = e.off; i < end && tick[i] <= until; i++) {
      if (vx[i] !== null && vy[i] !== null && vx[i]! * ux + vy[i]! * uy < 0) return "shoulder";
    }
  }
  let i = e.on;
  while (i + 1 < end && tick[i + 1] - tick[e.on] <= WIDE_WINDOW_S * c.tickRate) i++;
  if (x[i] === null || y[i] === null || x[e.on] === null || y[e.on] === null) return null;
  const travel = ((x[i]! - x[e.on]!) * ux + (y[i]! - y[e.on]!) * uy) / Math.hypot(ux, uy);
  return travel >= WIDE_MIN_TRAVEL ? "wide" : "other";
}

export function deriveMove(c: Ctx): MoveFact[] {
  const rounds = new Map<number, Extract<MoveFact, { k: "round" }>>();
  const weapons = new Map<string, Extract<MoveFact, { k: "weapon" }>>();
  for (let ri = 0; ri < c.nRounds; ri++) {
    for (const p of c.pr[ri]) {
      if (p) rounds.set(ri * 1024 + p.pi, { k: "round", ri, pi: p.pi, alive: 0, crouched: 0, speedSum: 0, speedN: 0, peeks: 0, shoulder: 0, jiggle: 0, wide: 0 });
    }
  }
  const weaponFact = (ri: number, pi: number, weapon: string) => {
    const key = `${ri}:${pi}:${weapon}`;
    let f = weapons.get(key);
    if (!f) weapons.set(key, (f = { k: "weapon", ri, pi, weapon, shots: 0, crouched: 0, exposures: [] }));
    return f;
  };

  // crouched shots, and each player's gun shot ticks for exposures
  const S = c.t.shots;
  const gunShot = new Map<number, string>(); // tick * 1024 + pi -> weapon
  if (S) for (let i = 0; i < S.n; i++) {
    const pi = c.pi.get(S.steamid[i]);
    const ri = c.riOf(S.round[i]);
    if (pi === undefined || ri === undefined || !rounds.has(ri * 1024 + pi) || !isGun(S.weapon[i])) continue;
    if (!gunShot.has(S.tick[i] * 1024 + pi)) gunShot.set(S.tick[i] * 1024 + pi, S.weapon[i]);
    if (S.ducked[i] === null) continue;
    const f = weaponFact(ri, pi, S.weapon[i]);
    f.shots++;
    if (S.ducked[i]) f.crouched++;
  }

  // crouch time and opening speed from positions
  const P = c.t.positions;
  if (P) for (const [key, rows] of tracks(c)) {
    const f = rounds.get(key);
    const fe = c.rounds[Math.floor(key / 1024)]?.freezeEndTick;
    if (!f || fe === null || fe === undefined) continue;
    const end = c.rounds[f.ri].endTick;
    const open = openingEnd(c, f.ri, f.pi);
    for (const i of rows) {
      if (!P.is_alive[i] || P.tick[i] < fe || P.tick[i] > end) continue;
      f.alive++;
      if (P.ducked[i]) f.crouched++;
      if (P.tick[i] <= open && P.vel_x[i] !== null && P.vel_y[i] !== null) { f.speedSum += Math.hypot(P.vel_x[i]!, P.vel_y[i]!); f.speedN++; }
    }
  }

  // peeks and exposure before the first shot, from the attacker's side of each engagement
  const G = c.t.engagements, E = c.t.engagement_ticks;
  if (G && E && c.t.match.visibility_status[0] === "ok") {
    const spans = engagementRows(c);
    // attacker:victim -> the last shoulder peek's onset tick, and whether it is already counted as a jiggle
    const lastShoulder = new Map<string, { tick: number; jiggle: boolean }>();
    const order = [...Array(G.n).keys()].sort((a, b) => G.start_tick[a] - G.start_tick[b]);
    for (const g of order) {
      const ri = c.riOf(G.round[g]);
      const pi = c.pi.get(G.attacker_steamid[g])!;
      const span = spans.get(G.engagement_id[g]);
      if (ri === undefined || !span) continue;
      const f = rounds.get(ri * 1024 + pi);
      if (!f) continue;
      const [a, b] = span;
      let exposureDone = false;
      for (const e of exposures(c, a, b)) {
        let shotTick: number | null = null, weapon: string | null = null;
        for (let i = e.on; i < e.off && shotTick === null; i++) {
          const w = gunShot.get(E.tick[i] * 1024 + pi);
          if (w) { shotTick = E.tick[i]; weapon = w; }
        }
        if (!exposureDone && shotTick !== null) {
          exposureDone = true;
          if (e.observed) weaponFact(ri, pi, weapon!).exposures.push((shotTick - E.tick[e.on]) / c.tickRate);
        }
        const vx = E.a_vel_x[e.on], vy = E.a_vel_y[e.on];
        if (!e.observed || vx === null || vy === null || Math.hypot(vx, vy) < PEEK_MIN_SPEED) continue;
        const cls = classifyPeek(c, e, b, shotTick !== null);
        if (cls === null) continue;
        f.peeks++;
        if (cls === "wide") f.wide++;
        if (cls !== "shoulder") continue;
        f.shoulder++;
        // The first shoulder peek of a jiggle is counted when the second one arrives.
        const pair = `${pi}:${G.victim_steamid[g]}`;
        const prev = lastShoulder.get(pair);
        const jiggle = prev !== undefined && E.tick[e.on] - prev.tick <= JIGGLE_GAP_S * c.tickRate;
        if (jiggle) f.jiggle += prev.jiggle ? 1 : 2;
        lastShoulder.set(pair, { tick: E.tick[e.on], jiggle });
      }
    }
  }
  return [...rounds.values(), ...weapons.values()];
}

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

export const MOVEMENT_METRICS: Metric[] = [
  { id: "shoulderPeekPct", label: "Shoulder peeks", kind: "identity", group: "movement", unit: "pct", status: "approx",
    tip: "Peeks where you showed yourself briefly and pulled back.", def: `Share of your peeks that were shoulder peeks: exposed at most ${SHOULDER_MAX_S} s, no shot, and you reversed direction by ${REVERSAL_SLACK_S} s after sight broke. A peek is an exposure to one enemy (mesh line of sight not blocked by smoke, breaks under ${EXPOSURE_GAP_S} s merged) that began while you moved at ${PEEK_MIN_SPEED} u/s or more.`,
    value: (s) => pct(s.movement.shoulder, s.movement.peeks) },
  { id: "jigglePeekPct", label: "Jiggle peeks", kind: "identity", group: "movement", unit: "pct", status: "approx",
    tip: "Repeated quick peeks at the same enemy.", def: `Share of your peeks that were shoulder peeks repeated at the same enemy, each within ${JIGGLE_GAP_S} s of the previous one.`,
    value: (s) => pct(s.movement.jiggle, s.movement.peeks) },
  { id: "widePeekPct", label: "Wide peeks", kind: "identity", group: "movement", unit: "pct", status: "approx",
    tip: "Peeks where you kept running out into the open.", def: `Share of your peeks where you kept moving the way you came out: ${WIDE_MIN_TRAVEL} units or more in the first ${WIDE_WINDOW_S} s.`,
    value: (s) => pct(s.movement.wide, s.movement.peeks) },
  { id: "exposureBeforeShot", label: "Exposure before first shot", kind: "identity", group: "movement", unit: "secs", status: "approx",
    tip: "How long you are seen before you fire.", def: "Median seconds from the start of an exposure to an enemy (mesh line of sight not blocked by smoke) to your first gun shot in it, one per engagement. Exposures that began before the engagement window are left out.",
    value: (s) => median(s.movement.exposures) },
  { id: "openingSpeed", label: "Speed before the first kill", kind: "identity", group: "movement", unit: "speed", status: "approx",
    tip: "How fast you move before the round's first kill.", def: "Mean 2D speed in units/s while alive, from freeze end to the round's first kill or your death, from 4 Hz positions.",
    value: (s) => (s.movement.speedN ? s.movement.speedSum / s.movement.speedN : null) },
  { id: "pathEfficiency", label: "Path efficiency", kind: "identity", group: "movement", unit: "pct", status: "unavailable",
    tip: "How direct your routes are; not measurable yet.", def: "Your path length against the nav-mesh shortest path. The tables carry no nav mesh (only nav place names), so it cannot be computed.",
    value: () => null },
  { id: "crouchShotPct", label: "Shots fired crouched", kind: "identity", group: "movement", unit: "pct", status: "exact",
    tip: "Share of your shots fired crouching.", def: "Share of your gun shots fired fully crouched (the game's ducked flag at the shot).",
    value: (s) => pct(s.movement.crouchedShots, s.movement.shots) },
  { id: "crouchTimePct", label: "Time crouched", kind: "identity", group: "movement", unit: "pct", status: "approx",
    tip: "Share of your time alive spent crouching.", def: "Share of your time alive from freeze end to round end spent fully crouched, from 4 Hz positions.",
    value: (s) => pct(s.movement.crouched, s.movement.alive) },
];
