// Luck, for fun: how much the dice favoured a player. Nothing here is a skill measure, so no metric is
// ranked against the pros (Metric.compared is false).
//
// Spread luck compares each shot's result with its chance. A gun shot fired at a visible enemy has a
// hit chance given the cone it was fired with and the enemy's size at that distance; luck is hits minus
// those chances, summed. The cone is CS:GO's published spread formula, which the CS2 community reads the
// same way: the bullet's direction is forward + x right + y up, where (x, y) is inaccuracy x u0 at a
// uniform angle plus spread x u1 at another, u0 and u1 uniform on [0, 1]. So (x, y) is a point on the
// plane one unit ahead of the eye, in the basis of the aim direction. The aim direction and both cone
// sizes are the game's own, per bullet (fire_bullets: angles, inaccuracy, spread, which the extractor
// writes to shots). The enemy is an upright box facing the shooter, TARGET_HALF_WIDTH to each side and
// from the feet to HEAD_ABOVE_EYE above the eye; its corners are projected onto that same plane (each
// divided by its depth along the aim), and a bullet hits when its point falls inside the projection.
import { forward, SIGHT_CONE_DEG } from "./aim-geometry";
import { MAX_SPEED } from "./aim-ref";
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";
import { accurateSpeed } from "./speed";

/** Half the width of a player's box (units). Ours: the shoulders' hitboxes span about 26 units. */
export const TARGET_HALF_WIDTH = 13;
/**
 * The box over-counts the hit area (limbs are thin, bodies are partly covered), so both half-sizes are
 * scaled by this before the chance is read. Fitted by `pnpm fit-luck` so that the geometric chances
 * sum to the hits over the even-numbered pro maps (153,583 shots at a visible enemy in covered rounds).
 */
export const HIT_AREA_SCALE = 0.869;
/**
 * The geometric chance is too sure at both ends: on the odd-numbered pro maps (154,979 shots), shots it
 * gave 0.4% hit 8.6% of the time, and shots it gave 95% hit 82%. A logistic map of its log-odds,
 * P = 1 / (1 + e^-(a + b logit(p))), fitted on the even-numbered maps by `pnpm fit-luck`, corrects that:
 * on the odd-numbered maps every band of P is within 0.08 of its hit rate (0.256 against 0.178 and
 * 0.681 against 0.758 are the widest), and hits are 1.006 of the expected. p is first clamped to
 * [CHANCE_FLOOR, 1 - CHANCE_FLOOR], since a box and a cone can give exactly 0 or 1.
 */
export const CALIBRATION = { a: -0.124, b: 0.374 };
export const CHANCE_FLOOR = 0.001;

/** The calibrated chance of a hit, from the geometric chance. */
export function calibrated(p: number, cal = CALIBRATION): number {
  const q = Math.min(1 - CHANCE_FLOOR, Math.max(CHANCE_FLOOR, p));
  return 1 / (1 + Math.exp(-(cal.a + cal.b * Math.log(q / (1 - q)))));
}
/** The top of the head above the eye (units). Ours, no fit. */
export const HEAD_ABOVE_EYE = 6;
/** A headshot fired with an inaccuracy cone this wide (radius, tangent units, about 2.9 degrees) or wider is lucky. Ours, no fit. */
export const LUCKY_CONE = 0.05;
/** A player on this much health or less is on low health. Ours, no fit. */
export const LOW_HP = 20;
/** Surviving a round on this much health or less is a close call (the user's figure). */
export const CLOSE_CALL_HP = 5;
/** Shotguns fire several pellets per shot, each with its own spread; the one-bullet model leaves them out. */
export const PELLET_GUNS = new Set(["nova", "xm1014", "sawedoff", "mag7"]);

// Midpoint grids for the two random radii and angles. 12 x 24 points for the inaccuracy term and 3 x 6
// for the spread term, which is a tenth of it or less on most shots; the known-answer test holds the
// grid within 0.01 of the exact chance.
const grid = (nr: number, nt: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < nr; i++) for (let j = 0; j < nt; j++) {
    const u = (i + 0.5) / nr, t = (2 * Math.PI * (j + 0.5)) / nt;
    out.push([u * Math.cos(t), u * Math.sin(t)]);
  }
  return out;
};
const INACC = grid(12, 24);
const SPREAD = grid(3, 6);

/**
 * The chance a bullet with this inaccuracy and spread lands inside `poly`, a convex polygon on the plane
 * one unit ahead of the eye, in the aim direction's right and up coordinates (projectBox).
 *
 * A grid point is inside when every edge's cross product that is not zero has the same sign (a
 * point on an edge counts). This loop ran for about 40% of derive's time as a point-in-polygon call
 * per grid point; the edges and the spread offsets are now computed once per call. Every point and
 * cross product is still the same floating-point expression in the same order, so the count is
 * unchanged: the old and new code gave the same chance on 20,000 random and degenerate polygons, and
 * the same facts on every pro map.
 */
export function hitChance(inaccuracy: number, spread: number, poly: readonly (readonly [number, number])[]): number {
  const n = poly.length;
  const x0 = new Float64Array(n), y0 = new Float64Array(n), ex = new Float64Array(n), ey = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const p = poly[j], q = poly[(j + 1) % n];
    x0[j] = p[0]; y0[j] = p[1]; ex[j] = q[0] - p[0]; ey[j] = q[1] - p[1];
  }
  const ns = SPREAD.length;
  const sc = new Float64Array(ns), sd = new Float64Array(ns);
  for (let k = 0; k < ns; k++) { sc[k] = spread * SPREAD[k][0]; sd[k] = spread * SPREAD[k][1]; }
  let hits = 0;
  for (let i = 0; i < INACC.length; i++) {
    const ia = inaccuracy * INACC[i][0], ib = inaccuracy * INACC[i][1];
    points: for (let k = 0; k < ns; k++) {
      const x = ia + sc[k], y = ib + sd[k];
      let sign = 0;
      for (let j = 0; j < n; j++) {
        const cross = ex[j] * (y - y0[j]) - ey[j] * (x - x0[j]);
        if (cross === 0) continue;
        if (sign === 0) sign = Math.sign(cross);
        else if (Math.sign(cross) !== sign) continue points;
      }
      hits++;
    }
  }
  return hits / (INACC.length * SPREAD.length);
}

type Vec3 = [number, number, number];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The aim direction's basis: forward (aim-geometry forward), right (horizontal, to the right) and up (right x forward). */
export function aimBasis(pitch: number, yaw: number): { f: Vec3; r: Vec3; u: Vec3 } {
  const f = forward(pitch, yaw);
  const r: Vec3 = [Math.sin(yaw * RAD), -Math.cos(yaw * RAD), 0];
  const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}

/** One shot's geometry: the aim basis, the target box's centre from the eye, its across direction and half-height. */
export interface ShotGeom { f: Vec3; r: Vec3; u: Vec3; c: Vec3; w: Vec3; halfH: number }

/** A point from the eye, on the plane one unit ahead in the aim's right and up coordinates; null behind the eye. */
function project(g: ShotGeom, p: Vec3): [number, number] | null {
  const depth = dot(p, g.f);
  return depth > 0 ? [dot(p, g.r) / depth, dot(p, g.u) / depth] : null;
}

/** The target box, its half-sizes scaled by `k`, projected corner by corner; null when a corner is behind the eye. */
export function projectBox(g: ShotGeom, k: number): [number, number][] | null {
  const out: [number, number][] = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const hw = sx * k * TARGET_HALF_WIDTH, hh = sy * k * g.halfH;
    const q = project(g, [g.c[0] + hw * g.w[0], g.c[1] + hw * g.w[1], g.c[2] + hh]);
    if (!q) return null;
    out.push(q);
  }
  return out;
}

const RAD = Math.PI / 180;
const finite = (...xs: (number | null | undefined)[]) => xs.every((x) => x !== null && x !== undefined && Number.isFinite(x));

/**
 * Fills the luck measures (facts.ts MEASURES, "luck"). Runs after scoreboard(): it reads the per-round
 * kill facts and adds to the rows' measures.
 */
export function luck(c: Ctx): void {
  const S = c.t.shots, D = c.t.damages, K = c.t.kills;
  const m = (ri: number, pi: number | null) => (pi === null ? null : c.pr[ri]?.[pi]?.m ?? null);

  // shot rows by (tick, shooter), gun shots only, for the killing shot of a kill
  const shotAt = new Map<number, number>();
  if (S) for (let i = 0; i < S.n; i++) {
    const p = c.idOf(S.steamid[i]);
    if (p !== null && MAX_SPEED[S.weapon[i]]) shotAt.set(S.tick[i] * 256 + p, i);
  }

  // ---- health from the damage taken in the round (every source), for close calls and low-health duels
  const healthAt = (ri: number, pi: number, tick: number): number => {
    let hp = 100;
    for (const i of c.byRound("damages")[ri]) {
      if (D.tick[i] > tick || c.pi.get(D.victim_steamid[i]) !== pi) continue;
      hp = D.health_after[i] ?? Math.max(0, hp - D.dmg_health_capped[i]);
    }
    return hp;
  };

  for (let ri = 0; ri < c.nRounds; ri++) {
    const rf = c.rounds[ri];
    for (const p of c.pr[ri]) {
      if (!p || !p.m.survived) continue;
      const hp = healthAt(ri, p.pi, rf.endTick);
      if (hp > 0 && hp <= CLOSE_CALL_HP) p.m.closeCalls = 1;
    }
    for (const k of c.kills[ri]) {
      if (!k.enemy || k.killer === null) continue;
      const killer = m(ri, k.killer), victim = m(ri, k.victim);
      if (healthAt(ri, k.killer, k.tick) <= LOW_HP) {
        if (killer) killer.lowHpKills++;
        if (victim) victim.lowHpDeaths++;
      }
      if (victim) victim.enemyDeaths++;
      // the killing shot: the killer's gun shot on the kill's tick
      const s = shotAt.get(k.tick * 256 + k.killer);
      if (!MAX_SPEED[k.weapon]) continue;
      if (killer) killer.gunKills++;
      if (victim) victim.gunDeaths++;
      if (s !== undefined && S) {
        const limit = accurateSpeed(S.weapon[s], S.scoped[s]);
        const speed = S.speed_2d[s];
        if (limit !== null && finite(speed)) {
          const running = speed! > limit;
          if (killer) { killer.rgKnown++; if (running) killer.rgKills++; }
          if (victim) { victim.rgDeathsKnown++; if (running) victim.rgDeaths++; }
        }
      }
      if (!k.headshot) continue;
      if (killer) killer.hsGunKills++;
      if (victim) victim.hsGunDeaths++;
      const inacc = s === undefined || !S ? null : S.inaccuracy[s];
      if (finite(inacc)) {
        const lucky = inacc! >= LUCKY_CONE;
        if (killer) { killer.lhKnown++; if (lucky) killer.lhKills++; }
        if (victim) { victim.lhDeathsKnown++; if (lucky) victim.lhDeaths++; }
      }
    }
  }

  // ---- flag kills, from the kills table's nullable flags (#27): known only when all four are recorded
  for (let i = 0; i < K.n; i++) {
    const ri = c.riOf(K.round[i]);
    if (ri === undefined) continue;
    const killer = c.idOf(K.attacker_steamid[i]), victim = c.pi.get(K.victim_steamid[i])!;
    const kf = c.kills[ri].find((k) => k.tick === K.tick[i] && k.killer === killer && k.victim === victim);
    if (!kf?.enemy) continue;
    const flags = [K.attackerblind[i], K.attackerinair[i], K.noscope[i], K.thrusmoke[i]];
    if (flags.some((f) => f === null)) continue;
    const [blind, air, noscope, smoke] = flags as boolean[];
    const km = m(ri, killer), vm = m(ri, victim);
    if (km) {
      km.flagsKnown++;
      if (blind) km.blindKills++;
      if (air) km.airKills++;
      if (noscope) km.noscopeKills++;
      if (smoke) km.smokeKills++;
    }
    if (vm) { vm.flagDeathsKnown++; if (blind || air || noscope || smoke) vm.flagDeaths++; }
  }

  // ---- spread luck: shots at a visible enemy, for the shooter and against the target, over the
  // rounds whose every gun shot has its inputs (a round with one missing stays unknown, not 0)
  const found = shotChances(c);
  if (found === null) return;
  for (const ri of found.covered) for (const p of c.pr[ri]) if (p) p.m.spreadRounds = 1;
  for (const x of found.shots) {
    if (!found.covered.has(x.ri)) continue;
    const box = projectBox(x.g, HIT_AREA_SCALE);
    if (!box) continue;
    const p = calibrated(hitChance(x.inaccuracy, x.spread, box));
    const shooter = m(x.ri, x.shooter), target = m(x.ri, x.target);
    if (shooter) { shooter.luckShots++; shooter.luckHits += x.hit; shooter.luckExp += p; }
    if (target) { target.luckAgShots++; target.luckAgHits += x.hit; target.luckAgExp += p; }
  }
}

/** One gun shot at a visible enemy: its cone, its geometry, and whether it hit him. */
export interface ShotChance { ri: number; shooter: number; target: number; inaccuracy: number; spread: number; g: ShotGeom; hit: 0 | 1 }

/** Whether a shots row has every input spread luck reads: the cone, both aim angles and the eye. */
const complete = (S: NonNullable<Ctx["t"]["shots"]>, i: number) =>
  finite(S.inaccuracy[i], S.spread[i], S.bullet_pitch[i], S.bullet_yaw[i], S.eye_x[i], S.eye_y[i], S.eye_z[i]);

/**
 * Every gun shot (shotguns aside) fired while an enemy was mesh-visible and unsmoked within
 * SIGHT_CONE_DEG of the aim; the target is the one whose box centre projects nearest the aim point.
 * `covered` holds the rounds whose every gun shot has its inputs; a shot in another round is listed
 * but must not be scored. Each hit on the target on a shot's tick is given to one shot of that tick,
 * in shot order, so two shot rows on one tick do not count one hit twice. Null when the match has no
 * mesh visibility, no engagements or no shots.
 */
export function shotChances(c: Ctx): { shots: ShotChance[]; covered: Set<number> } | null {
  const S = c.t.shots, E = c.t.engagements, T = c.t.engagement_ticks, D = c.t.damages;
  if (!S || !E || !T || c.t.match.visibility_status[0] !== "ok") return null;
  const gun = (i: number) => MAX_SPEED[S.weapon[i]] !== undefined && !PELLET_GUNS.has(S.weapon[i]);
  const covered = new Set<number>();
  for (let ri = 0; ri < c.nRounds; ri++) covered.add(ri);
  for (let i = 0; i < S.n; i++) {
    const ri = c.riOf(S.round[i]);
    if (ri !== undefined && gun(i) && !complete(S, i)) covered.delete(ri);
  }
  const death = new Map<number, number>();
  c.kills.forEach((ks, ri) => { for (const k of ks) death.set(ri * 1024 + k.victim, k.tick); });
  const eng = new Map<number, number>();
  for (let e = 0; e < E.n; e++) eng.set(E.engagement_id[e], e);
  // visible engagement rows by (tick, attacker), cut at either player's death
  const seen = new Map<number, number[]>();
  for (let i = 0; i < T.n; i++) {
    if (T.mesh_visible[i] !== true || T.smoke_blocked[i] !== false) continue;
    const e = eng.get(T.engagement_id[i]);
    if (e === undefined) continue;
    const ri = c.riOf(E.round[e]), a = c.idOf(E.attacker_steamid[e]), v = c.idOf(E.victim_steamid[e]);
    if (ri === undefined || a === null || v === null) continue;
    const cut = Math.min(death.get(ri * 1024 + a) ?? Infinity, death.get(ri * 1024 + v) ?? Infinity);
    if (T.tick[i] > cut || !finite(T.v_x[i], T.v_y[i], T.v_z[i], T.v_eye_z[i])) continue;
    const k = T.tick[i] * 256 + a;
    (seen.get(k) ?? seen.set(k, []).get(k)!).push(i);
  }
  // enemy gun hits by (tick, attacker, victim): how many, to be given out one per shot of that tick
  const hitsLeft = new Map<string, number>();
  for (let i = 0; i < D.n; i++) {
    if (D.attacker_steamid[i] === null || D.is_self[i] || D.is_team_damage[i] || !D.weapon[i] || !MAX_SPEED[D.weapon[i]!]) continue;
    const k = `${D.tick[i]}:${c.idOf(D.attacker_steamid[i])}:${c.pi.get(D.victim_steamid[i])}`;
    hitsLeft.set(k, (hitsLeft.get(k) ?? 0) + 1);
  }
  const gate = Math.tan(SIGHT_CONE_DEG * RAD);
  const shots: ShotChance[] = [];
  const order = [...Array(S.n).keys()].sort((x, y) => S.tick[x] - S.tick[y]);
  for (const i of order) {
    const pi = c.idOf(S.steamid[i]), ri = c.riOf(S.round[i]);
    if (pi === null || ri === undefined || !gun(i) || !complete(S, i)) continue;
    const { f, r, u } = aimBasis(S.bullet_pitch[i]!, S.bullet_yaw[i]!);
    const eye: Vec3 = [S.eye_x[i]!, S.eye_y[i]!, S.eye_z[i]!];
    let best: { v: number; off: number; g: ShotGeom } | null = null;
    for (const row of seen.get(S.tick[i] * 256 + pi) ?? []) {
      const halfH = (T.v_eye_z[row]! + HEAD_ABOVE_EYE - T.v_z[row]!) / 2;
      const cc: Vec3 = [T.v_x[row]! - eye[0], T.v_y[row]! - eye[1], T.v_z[row]! + halfH - eye[2]];
      const flat = Math.hypot(cc[0], cc[1]);
      if (!flat) continue;
      const g: ShotGeom = { f, r, u, c: cc, w: [-cc[1] / flat, cc[0] / flat, 0], halfH };
      const at = project(g, cc);
      if (!at) continue;
      const off = Math.hypot(at[0], at[1]);
      if (off > gate || (best && off >= best.off)) continue;
      best = { v: c.idOf(E.victim_steamid[eng.get(T.engagement_id[row])!])!, off, g };
    }
    if (!best) continue;
    const k = `${S.tick[i]}:${pi}:${best.v}`;
    const left = hitsLeft.get(k) ?? 0;
    if (left > 0) hitsLeft.set(k, left - 1);
    shots.push({ ri, shooter: pi, target: best.v, inaccuracy: S.inaccuracy[i]!, spread: S.spread[i]!, g: best.g, hit: left > 0 ? 1 : 0 });
  }
  return { shots, covered };
}

// ---- metrics

/** Per 24 rounds (a regulation match), over the rounds an input covers; null when it covers none. */
const per24 = (a: number, rounds: number) => (rounds > 0 ? (24 * a) / rounds : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

/** Luck metrics are for fun: none is ranked against the pros. */
const FUN = { kind: "identity", group: "luck", status: "approx", compared: false } as const;

export const LUCK_METRICS: Metric[] = [
  { id: "luckHits", label: "Lucky hits", ...FUN, unit: "count", needs: ["spread"],
    tip: "Hits you landed beyond what your bullet spread made likely.",
    def: "Your hits on visible enemies minus their summed hit chances, per 24 rounds.",
    value: (s) => per24(s.m.luckHits - s.m.luckExp, s.m.spreadRounds) },
  { id: "luckAgainst", label: "Luck against you", ...FUN, unit: "count", needs: ["spread"],
    tip: "Hits enemies landed on you beyond what their spread made likely.",
    def: "Enemy hits on you minus their summed hit chances, per 24 rounds.",
    value: (s) => per24(s.m.luckAgHits - s.m.luckAgExp, s.m.spreadRounds) },
  { id: "luckScore", label: "Luck score", ...FUN, unit: "count", needs: ["spread"],
    tip: "Above zero, the dice favoured you; below, they favoured the enemy.",
    def: "Your lucky hits minus the enemies' lucky hits on you, per 24 rounds.",
    value: (s) => per24(s.m.luckHits - s.m.luckExp - (s.m.luckAgHits - s.m.luckAgExp), s.m.spreadRounds) },
  { id: "runAndGunKills", label: "Run-and-gun kills", ...FUN, unit: "pct", needs: ["killShot"],
    tip: "Kills you got while running too fast to shoot accurately.",
    def: "Gun kills whose killing shot you fired above the gun's accurate moving speed.",
    value: (s) => pct(s.m.rgKills, s.m.rgKnown) },
  { id: "runAndGunDeaths", label: "Run-and-gun deaths", ...FUN, unit: "pct", needs: ["deathShot"],
    tip: "Deaths to enemies who were running when they shot you.",
    def: "Gun deaths whose killing shot was fired above the gun's accurate moving speed.",
    value: (s) => pct(s.m.rgDeaths, s.m.rgDeathsKnown) },
  { id: "luckyHeadshots", label: "Lucky headshots", ...FUN, unit: "pct", needs: ["hsShot"],
    tip: "Headshot kills fired with a very wide bullet spread.",
    def: "Headshot kills whose killing shot had an inaccuracy cone of 0.05 or wider.",
    value: (s) => pct(s.m.lhKills, s.m.lhKnown) },
  { id: "luckyHeadshotDeaths", label: "Lucky headshots against you", ...FUN, unit: "pct", needs: ["hsDeathShot"],
    tip: "Headshot deaths to bullets fired with a very wide spread.",
    def: "Headshot deaths whose killing shot had an inaccuracy cone of 0.05 or wider.",
    value: (s) => pct(s.m.lhDeaths, s.m.lhDeathsKnown) },
  { id: "blindKills", label: "Kills while blind", ...FUN, unit: "pct", needs: ["flags"],
    tip: "Kills you got while flashed.",
    def: "Share of your kills made while you were blind (the game's flag).",
    value: (s) => pct(s.m.blindKills, s.m.flagsKnown) },
  { id: "airKills", label: "Kills in the air", ...FUN, unit: "pct", needs: ["flags"],
    tip: "Kills you got while jumping or falling.",
    def: "Share of your kills made while you were in the air (the game's flag).",
    value: (s) => pct(s.m.airKills, s.m.flagsKnown) },
  { id: "noscopeKills", label: "No-scope kills", ...FUN, unit: "pct", needs: ["flags"],
    tip: "Sniper kills you got without scoping in.",
    def: "Share of your kills made with an unscoped sniper rifle (the game's flag).",
    value: (s) => pct(s.m.noscopeKills, s.m.flagsKnown) },
  { id: "smokeKills", label: "Kills through smoke", ...FUN, unit: "pct", needs: ["flags"],
    tip: "Kills you got through a smoke.",
    def: "Share of your kills that went through a smoke (the game's flag).",
    value: (s) => pct(s.m.smokeKills, s.m.flagsKnown) },
  { id: "flagDeaths", label: "Flag deaths", ...FUN, unit: "pct", needs: ["deathFlags"],
    tip: "Deaths to blind, jumping, no-scope or through-smoke kills.",
    def: "Share of your deaths to an enemy kill that was blind, in the air, no-scope or through smoke.",
    value: (s) => pct(s.m.flagDeaths, s.m.flagDeathsKnown) },
  { id: "closeCalls", label: "Close calls", ...FUN, unit: "count",
    tip: `Rounds you survived on ${CLOSE_CALL_HP} health or less, per 24 rounds.`,
    def: `Rounds you survived with ${CLOSE_CALL_HP} health or less at the round's end, per 24 rounds.`,
    value: (s) => per24(s.m.closeCalls, s.m.rounds) },
  { id: "lowHpKills", label: "Low-health kills", ...FUN, unit: "count",
    tip: `Kills you got on ${LOW_HP} health or less, per 24 rounds.`,
    def: `Enemy kills you made with ${LOW_HP} health or less, per 24 rounds.`,
    value: (s) => per24(s.m.lowHpKills, s.m.rounds) },
  { id: "lowHpDeaths", label: "Deaths to low-health enemies", ...FUN, unit: "count",
    tip: `Deaths to enemies on ${LOW_HP} health or less, per 24 rounds.`,
    def: `Your deaths to an enemy with ${LOW_HP} health or less, per 24 rounds.`,
    value: (s) => per24(s.m.lowHpDeaths, s.m.rounds) },
];
