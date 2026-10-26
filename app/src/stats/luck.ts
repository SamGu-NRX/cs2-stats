// Luck, for fun: how much the dice favoured a player. Nothing here is a skill measure, so no metric is
// ranked against the pros (Metric.compared is false).
//
// Spread luck compares each shot's result with its chance. A gun shot fired at a visible enemy has a
// hit chance given the cone it was fired with and the enemy's size at that distance; luck is hits minus
// those chances, summed. The cone is CS:GO's published spread formula, which the CS2 community reads the
// same way: the bullet leaves the aim direction by r0 = inaccuracy x u0 at a uniform angle, plus r1 =
// spread x u1 at another uniform angle, u0 and u1 uniform on [0, 1], in tangent units. The aim direction
// and both cone sizes are the game's own, per bullet (fire_bullets: angles, inaccuracy, spread, which the
// extractor writes to shots). The enemy is an upright box facing the shooter: TARGET_HALF_WIDTH to each
// side, from the feet to HEAD_ABOVE_EYE above the eye.
import { ACCURATE_FRAC, lookAt, SIGHT_CONE_DEG, wrap180 } from "./aim-geometry";
import { MAX_SPEED } from "./aim-ref";
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

/** Half the width of a player's box (units). Ours: the shoulders' hitboxes span about 26 units. */
export const TARGET_HALF_WIDTH = 13;
/**
 * The box over-counts the hit area (limbs are thin, bodies are partly covered), so both half-sizes are
 * scaled by this before the chance is read. Fitted by `pnpm fit-luck` so that the geometric chances
 * sum to the hits over the even-numbered pro maps (158,299 shots at a visible enemy).
 */
export const HIT_AREA_SCALE = 0.868;
/**
 * The geometric chance is too sure at both ends: on the odd-numbered pro maps (159,100 shots), shots it
 * gave 0.4% hit 8.9% of the time, and shots it gave 95% hit 82%. A logistic map of its log-odds,
 * P = 1 / (1 + e^-(a + b logit(p))), fitted on the even-numbered maps by `pnpm fit-luck`, corrects that:
 * on the odd-numbered maps every band of P is within 0.08 of its hit rate (0.257 against 0.180 and
 * 0.681 against 0.758 are the widest), and hits are 1.006 of the expected. p is first clamped to
 * [CHANCE_FLOOR, 1 - CHANCE_FLOOR], since a box and a cone can give exactly 0 or 1.
 */
export const CALIBRATION = { a: -0.123, b: 0.371 };
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
 * The chance a bullet lands in a box of half-sizes (halfW, halfH) whose centre sits (ox, oy) off the aim
 * direction, all in tangent units (radians at small angles), for the given inaccuracy and spread.
 */
export function hitChance(inaccuracy: number, spread: number, ox: number, oy: number, halfW: number, halfH: number): number {
  let hits = 0;
  for (const [a, b] of INACC) {
    for (const [c, d] of SPREAD) {
      const x = inaccuracy * a + spread * c, y = inaccuracy * b + spread * d;
      if (Math.abs(x - ox) <= halfW && Math.abs(y - oy) <= halfH) hits++;
    }
  }
  return hits / (INACC.length * SPREAD.length);
}

const RAD = Math.PI / 180;
const finite = (...xs: (number | null | undefined)[]) => xs.every((x) => x !== null && x !== undefined && Number.isFinite(x));

/** The gun's speed above which a shot is inaccurate: ACCURATE_FRAC of its max speed (scoped speed when scoped). Null for an unknown gun. */
function accurateSpeed(weapon: string, scoped: boolean | null): number | null {
  const max = MAX_SPEED[weapon];
  if (!max) return null;
  return ACCURATE_FRAC * (scoped && max.length > 1 ? max[1] : max[0]);
}

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

  // ---- spread luck: shots at a visible enemy, for the shooter and against the target
  const shots = shotChances(c);
  if (shots === null) return;
  for (const row of c.pr) for (const p of row) if (p) p.m.spreadRounds = 1;
  for (const x of shots) {
    const p = calibrated(hitChance(x.inaccuracy, x.spread, x.ox, x.oy, (HIT_AREA_SCALE * TARGET_HALF_WIDTH) / x.dist, (HIT_AREA_SCALE * x.halfH) / x.dist));
    const shooter = m(x.ri, x.shooter), target = m(x.ri, x.target);
    if (shooter) { shooter.luckShots++; shooter.luckHits += x.hit; shooter.luckExp += p; }
    if (target) { target.luckAgShots++; target.luckAgHits += x.hit; target.luckAgExp += p; }
  }
}

/** One gun shot at a visible enemy: its cone, where the target sat from the aim (radians), how far, and whether it hit him. */
export interface ShotChance {
  ri: number; shooter: number; target: number;
  inaccuracy: number; spread: number; ox: number; oy: number;
  /** distance from the eye to the target's centre, and the target's half-height (units) */
  dist: number; halfH: number;
  hit: 0 | 1;
}

/**
 * Every gun shot (shotguns aside) with its cone and aim angles known, fired while an enemy was
 * mesh-visible and unsmoked within SIGHT_CONE_DEG of the aim: the target is the one whose body centre is
 * nearest the aim direction. Null when the match lacks the inputs (no engagements, no mesh visibility,
 * or shots without fire_bullets' cone).
 */
export function shotChances(c: Ctx): ShotChance[] | null {
  const S = c.t.shots, E = c.t.engagements, T = c.t.engagement_ticks, D = c.t.damages;
  if (!S || !E || !T || c.t.match.visibility_status[0] !== "ok" || !S.inaccuracy.some((x) => x !== null)) return null;
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
  // enemy gun hits by (tick, attacker): the victims hit on that tick
  const hitOn = new Map<number, Set<number>>();
  for (let i = 0; i < D.n; i++) {
    if (D.attacker_steamid[i] === null || D.is_self[i] || D.is_team_damage[i] || !D.weapon[i] || !MAX_SPEED[D.weapon[i]!]) continue;
    const k = D.tick[i] * 256 + c.idOf(D.attacker_steamid[i])!;
    (hitOn.get(k) ?? hitOn.set(k, new Set()).get(k)!).add(c.pi.get(D.victim_steamid[i])!);
  }
  const out: ShotChance[] = [];
  for (let i = 0; i < S.n; i++) {
    const pi = c.idOf(S.steamid[i]), ri = c.riOf(S.round[i]);
    if (pi === null || ri === undefined || !MAX_SPEED[S.weapon[i]] || PELLET_GUNS.has(S.weapon[i])) continue;
    const pitch = S.bullet_pitch[i], yaw = S.bullet_yaw[i], inacc = S.inaccuracy[i], spread = S.spread[i];
    const eye: [number, number, number] = [S.eye_x[i]!, S.eye_y[i]!, S.eye_z[i]!];
    if (!finite(pitch, yaw, inacc, spread, ...eye)) continue;
    let best: { v: number; off: number; ox: number; oy: number; dist: number; halfH: number } | null = null;
    for (const r of seen.get(S.tick[i] * 256 + pi) ?? []) {
      const halfH = (T.v_eye_z[r]! + HEAD_ABOVE_EYE - T.v_z[r]!) / 2;
      const centre: [number, number, number] = [T.v_x[r]!, T.v_y[r]!, T.v_z[r]! + halfH];
      const want = lookAt(eye, centre);
      const ox = wrap180(want.yaw - yaw!), oy = want.pitch - pitch!, off = Math.hypot(ox, oy);
      if (off > SIGHT_CONE_DEG || (best && off >= best.off)) continue;
      const dist = Math.hypot(centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]);
      best = { v: c.idOf(E.victim_steamid[eng.get(T.engagement_id[r])!])!, off, ox: ox * RAD, oy: oy * RAD, dist, halfH };
    }
    if (!best || best.dist <= 0) continue;
    out.push({
      ri, shooter: pi, target: best.v, inaccuracy: inacc!, spread: spread!, ox: best.ox, oy: best.oy, dist: best.dist, halfH: best.halfH,
      hit: hitOn.get(S.tick[i] * 256 + pi)?.has(best.v) ? 1 : 0,
    });
  }
  return out;
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
