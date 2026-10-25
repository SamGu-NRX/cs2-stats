// Which spotted-mask bit means "the human can see this enemy", and whether the plugin's visibility
// signal is good enough for the stats that depend on it (time to damage, reaction time, crosshair
// placement, spotted and adjusted accuracy).
//
// The test: the human damaging an enemy with a bullet means the human could see that enemy, so a
// correct visibility signal is on for almost every such hit. aim.hitMask (plugin 1.0.0) stores the
// victim's raw m_bSpottedByMask words at each hit by the human; env.humanSlot / humanController /
// humanPawn give the indexes a bit could stand for.
//
// Finding on the three 2026-10-25 recordings (93 bullet hits, see README "Visibility"): the bit is
// the human's player slot in word 0, as the plugin already reads it. Every set bit in all 104 rows
// is the slot of a player on the human's team, and no other candidate matches a single hit. But the
// mask is on for only 53 of 93 bullet hits, and engagements often start after the human was already
// shooting at that enemy. The mask is the radar's spotted state, not line of sight, so the stats stay
// gated until a signal passes VISIBILITY_MIN_COVERAGE.
//
// Plugin 1.1.0 replaces the mask with line of sight (aim.los: transitions from 16 Hz traces). For
// those files the test reads that signal instead: a bullet hit counts as seen when the enemy was in
// line of sight at the hit, or entered it by the next check (the signal lags by up to one interval).
// aim.hitMask.los, a trace made at each hit, is reported alongside as a check of the trace itself.
import { fullRoundTest } from "./context";
import type { MatchFile } from "./schema";
import { isUtility } from "./weapons";

/** A visibility signal is trusted when it is on for at least this share of the human's bullet hits. */
export const VISIBILITY_MIN_COVERAGE = 0.9;
/** An engagement whose enemy the human shot at or damaged this long before it started counts as late. */
export const LATE_WINDOW_S = 2;
/** Line-of-sight checks per second in plugin 1.1.0; a hit may precede the check that shows its victim visible by up to one interval. */
export const LOS_HZ = 16;

/** True when bit `bit` (0..63) is set in the two 32-bit mask words. Out-of-range bits are false. */
export function maskHasBit(m0: number, m1: number, bit: number | null): boolean {
  if (bit === null || !Number.isInteger(bit) || bit < 0 || bit >= 64) return false;
  const w = bit < 32 ? m0 : m1;
  return ((w >>> (bit & 31)) & 1) === 1;
}

/** The bit mapping this app uses: the human's player slot (0-based), word 0 for slots 0..31. */
export function humanSpotBit(env: MatchFile["env"]): number | null {
  return env.humanSlot ?? null;
}

export const SPOT_CANDIDATES = ["slot", "controller", "slotMinus1", "pawn", "slotInWord1", "anyBit"] as const;
export type SpotCandidate = (typeof SPOT_CANDIDATES)[number];

/** Whether a candidate mapping says the hit victim was visible to the human. */
export function candidateSees(c: SpotCandidate, env: MatchFile["env"], m0: number, m1: number): boolean {
  const slot = env.humanSlot ?? null;
  switch (c) {
    case "slot": return maskHasBit(m0, m1, slot);
    // The controller's entity index is slot + 1, so this is also the "off by one upward" candidate.
    case "controller": return maskHasBit(m0, m1, env.humanController ?? null);
    case "slotMinus1": return slot === null ? false : maskHasBit(m0, m1, slot - 1);
    case "pawn": return maskHasBit(m0, m1, env.humanPawn ?? null);
    case "slotInWord1": return slot === null ? false : maskHasBit(m1, 0, slot);
    // m_bSpotted: any player on the human's team sees the victim.
    case "anyBit": return m0 !== 0 || m1 !== 0;
  }
}

/** Additive counts, so evidence from several matches sums. */
export interface VisibilityEvidence {
  /** aim.hitMask rows (the human damaging an enemy) */
  hitRows: number;
  /** rows whose damage came from a bullet, not a grenade or fire */
  bulletHits: number;
  /** bullet hits each candidate mapping calls visible */
  seen: Record<SpotCandidate, number>;
  /** set bits that are not the slot of a player on the human's team (pi taken as slot) */
  foreignBits: number;
  /** bullet hits by the human that fall inside an engagement with the same enemy */
  hitsInEngagement: number;
  /** human shots that hit and had a target, and those with visTarget = 1 */
  hitShots: number;
  hitShotsVisible: number;
  engagements: number;
  /** engagements whose enemy the human aimed a shot at (target) / damaged in the LATE_WINDOW_S before tVis */
  shotBeforeVisible: number;
  damagedBeforeVisible: number;
  /** files whose visibility came from line of sight (env.visSource "los"), and their bullet hits */
  losFiles: number;
  losHits: number;
  /** of those hits: the victim was in line of sight by the 16 Hz signal (aim.los) */
  losSeen: number;
  /** hits with a trace made at the hit (hitMask.los not null), and those that were clear */
  losAtHitKnown: number;
  losAtHitClear: number;
}

export function emptyEvidence(): VisibilityEvidence {
  return {
    hitRows: 0, bulletHits: 0, seen: Object.fromEntries(SPOT_CANDIDATES.map((c) => [c, 0])) as Record<SpotCandidate, number>,
    foreignBits: 0, hitsInEngagement: 0, hitShots: 0, hitShotsVisible: 0, engagements: 0, shotBeforeVisible: 0, damagedBeforeVisible: 0,
    losFiles: 0, losHits: 0, losSeen: 0, losAtHitKnown: 0, losAtHitClear: 0,
  };
}

export function mergeEvidence(a: VisibilityEvidence, b: VisibilityEvidence): VisibilityEvidence {
  for (const k of Object.keys(b) as (keyof VisibilityEvidence)[]) {
    if (k === "seen") for (const c of SPOT_CANDIDATES) a.seen[c] += b.seen[c];
    else a[k] += b[k];
  }
  return a;
}

/** Evidence from one match. Null when the file has no hit masks (legacy files, older plugins). */
export function visibilityEvidence(m: MatchFile): VisibilityEvidence | null {
  const h = m.aim.hitMask;
  if (!h || h.ri.length === 0) return null;
  const ev = emptyEvidence();
  const isFull = fullRoundTest(m);
  const tr = m.env.tickrate || 64;
  const d = m.damage;
  // weapon of the human's damage row at (ri, tick, victim)
  const hitWeapon = new Map<string, string>();
  for (let j = 0; j < d.ri.length; j++) {
    if (d.attacker[j] === m.human) hitWeapon.set(`${d.ri[j]}:${d.tick[j]}:${d.victim[j]}`, m.weapons[d.weapon[j]] ?? "");
  }
  const e = m.aim.engagements;
  const losAt = m.env.visSource === "los" && m.aim.los ? losLookup(m) : null;
  if (losAt) ev.losFiles++;
  for (let i = 0; i < h.ri.length; i++) {
    if (!isFull(h.ri[i])) continue;
    ev.hitRows++;
    const team = m.rounds.side[h.ri[i]]?.[m.human] ?? null;
    for (let bit = 0; bit < 64; bit++) {
      if (!maskHasBit(h.m0[i], h.m1[i], bit)) continue;
      const s = bit < m.players.key.length ? m.rounds.side[h.ri[i]]?.[bit] ?? null : null;
      if (s === null || s !== team) ev.foreignBits++;
    }
    const w = hitWeapon.get(`${h.ri[i]}:${h.tick[i]}:${h.victim[i]}`);
    if (w === undefined || isUtility(w)) continue;
    ev.bulletHits++;
    for (const c of SPOT_CANDIDATES) if (candidateSees(c, m.env, h.m0[i], h.m1[i])) ev.seen[c]++;
    if (losAt) { ev.losHits++; if (losAt(h.ri[i], h.victim[i], h.tick[i])) ev.losSeen++; }
    const traced = h.los?.[i];
    if (traced === 0 || traced === 1) { ev.losAtHitKnown++; if (traced === 1) ev.losAtHitClear++; }
    for (let k = 0; k < e.ri.length; k++) {
      if (e.ri[k] === h.ri[i] && e.enemy[k] === h.victim[i] && h.tick[i] >= e.tVis[k] && h.tick[i] <= e.tEnd[k]) { ev.hitsInEngagement++; break; }
    }
  }
  const s = m.aim.shots;
  for (let i = 0; i < s.ri.length; i++) {
    if (!isFull(s.ri[i]) || s.hit[i] === null || s.target[i] === null || !s.visTarget) continue;
    ev.hitShots++;
    if (s.visTarget[i] === 1) ev.hitShotsVisible++;
  }
  const window = LATE_WINDOW_S * tr;
  for (let k = 0; k < e.ri.length; k++) {
    if (!isFull(e.ri[k])) continue;
    ev.engagements++;
    const ri = e.ri[k];
    const t0 = e.tVis[k];
    let shot = false;
    for (let i = 0; i < s.ri.length && !shot; i++) shot = s.ri[i] === ri && s.target[i] === e.enemy[k] && s.tick[i] < t0 && s.tick[i] >= t0 - window;
    let dmg = false;
    for (let j = 0; j < d.ri.length && !dmg; j++) dmg = d.ri[j] === ri && d.attacker[j] === m.human && d.victim[j] === e.enemy[k] && d.tick[j] < t0 && d.tick[j] >= t0 - window;
    if (shot) ev.shotBeforeVisible++;
    if (dmg) ev.damagedBeforeVisible++;
  }
  return ev;
}

/**
 * Whether an enemy was in the human's line of sight at a tick, by the aim.los transitions: the last
 * transition at or before the tick says visible, or one within the next check interval does.
 */
export function losLookup(m: MatchFile): (ri: number, enemy: number, tick: number) => boolean {
  const l = m.aim.los!;
  const lag = Math.ceil((m.env.tickrate || 64) / LOS_HZ);
  const by = new Map<string, [number, number][]>();
  for (let i = 0; i < l.ri.length; i++) {
    const k = `${l.ri[i]}:${l.enemy[i]}`;
    let a = by.get(k);
    if (!a) by.set(k, (a = []));
    a.push([l.tick[i], l.vis[i]]);
  }
  for (const a of by.values()) a.sort((x, y) => x[0] - y[0]);
  return (ri, enemy, tick) => {
    const a = by.get(`${ri}:${enemy}`);
    if (!a) return false;
    let state = 0;
    for (const [t, v] of a) {
      if (t <= tick) state = v;
      else { if (v === 1 && t - tick <= lag) return true; break; }
    }
    return state === 1;
  };
}

export interface VisibilityVerdict {
  /** the visibility-dependent stats can be shown without a "Validating" flag */
  validated: boolean;
  /** what the verdict tested: line of sight (plugin 1.1.0) or the spotted mask */
  signal: "los" | "mask" | null;
  /** share of bullet hits the signal calls visible, null without evidence */
  hitCoverage: number | null;
  /** share of bullet hits inside an engagement with that enemy */
  engagementCoverage: number | null;
  /** one sentence for a tooltip */
  reason: string;
}

const pct = (a: number, b: number) => `${Math.round((100 * a) / b)}%`;

/**
 * Validated when the mapped bit and the engagements both cover at least VISIBILITY_MIN_COVERAGE of
 * the human's bullet hits. Without hit masks the plugin's own env.visibilityValidated flag decides.
 */
export function visibilityVerdict(ev: VisibilityEvidence | null, pluginFlag = false): VisibilityVerdict {
  if (!ev || ev.bulletHits === 0) {
    return { validated: pluginFlag, signal: null, hitCoverage: null, engagementCoverage: null,
      reason: pluginFlag ? "The capture plugin marks visibility as validated." : "No hit masks recorded, so the visibility signal cannot be checked." };
  }
  if (ev.losFiles > 0 && ev.losHits > 0) {
    // Mixed sets (some files with line of sight, some without) are judged on the line-of-sight files only.
    const hitCoverage = ev.losSeen / ev.losHits;
    const engagementCoverage = ev.hitsInEngagement / ev.bulletHits;
    const validated = hitCoverage >= VISIBILITY_MIN_COVERAGE && engagementCoverage >= VISIBILITY_MIN_COVERAGE;
    const atHit = ev.losAtHitKnown ? ` A trace at each hit was clear for ${pct(ev.losAtHitClear, ev.losAtHitKnown)}.` : "";
    const reason = validated
      ? `Line of sight showed the enemy for ${pct(ev.losSeen, ev.losHits)} of ${ev.losHits} hits.${atHit}`
      : `Line of sight showed the enemy for only ${pct(ev.losSeen, ev.losHits)} of your ${ev.losHits} hits (${pct(ev.hitsInEngagement, ev.bulletHits)} inside an encounter), below the ${VISIBILITY_MIN_COVERAGE * 100}% needed.${atHit}`;
    return { validated, signal: "los", hitCoverage, engagementCoverage, reason };
  }
  const hitCoverage = ev.seen.slot / ev.bulletHits;
  const engagementCoverage = ev.hitsInEngagement / ev.bulletHits;
  const validated = hitCoverage >= VISIBILITY_MIN_COVERAGE && engagementCoverage >= VISIBILITY_MIN_COVERAGE;
  const reason = validated
    ? `The visibility signal was on for ${pct(ev.seen.slot, ev.bulletHits)} of ${ev.bulletHits} hits.`
    : `The game's spotted flag was on for only ${pct(ev.seen.slot, ev.bulletHits)} of your ${ev.bulletHits} hits, and ` +
      `${ev.shotBeforeVisible} of ${ev.engagements} encounters started after you were already shooting at that enemy, so these timings start late and miss encounters.`;
  return { validated, signal: "mask", hitCoverage, engagementCoverage, reason };
}
