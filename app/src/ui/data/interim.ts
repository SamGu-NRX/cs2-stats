// Interim: the human's hits by body part, read from the raw match file. The engine's per-round aim
// carries hit groups only inside bursts of two or more bullets, so the full hit map comes from the
// shots table here until the engine aggregates it; then this file is deleted.
import { fullRoundTest } from "../../stats/context";
import type { MatchFile } from "../../stats/schema";
import { weaponClass } from "../../stats/weapons";

export type NadeType = "he" | "flash" | "smoke" | "molotov" | "decoy";
export const NADE_TYPES: NadeType[] = ["flash", "smoke", "he", "molotov", "decoy"];

const GUNS = new Set(["rifle", "sniper", "smg", "heavy", "pistol"]);

export type BodyPart = "head" | "neck" | "chest" | "stomach" | "leftArm" | "rightArm" | "leftLeg" | "rightLeg";
export const BODY_PARTS: { id: BodyPart; label: string }[] = [
  { id: "head", label: "Head" }, { id: "neck", label: "Neck" }, { id: "chest", label: "Chest" }, { id: "stomach", label: "Stomach" },
  { id: "leftArm", label: "Left arm" }, { id: "rightArm", label: "Right arm" }, { id: "leftLeg", label: "Left leg" }, { id: "rightLeg", label: "Right leg" },
];
// Source hit groups: 1 head, 2 chest, 3 stomach, 4 left arm, 5 right arm, 6 left leg, 7 right leg, 8 neck.
const HITGROUP: Record<number, BodyPart> = { 1: "head", 2: "chest", 3: "stomach", 4: "leftArm", 5: "rightArm", 6: "leftLeg", 7: "rightLeg", 8: "neck" };

export interface HitMap { counts: Record<BodyPart, number>; total: number; other: number }

export function emptyHitMap(): HitMap {
  return { counts: Object.fromEntries(BODY_PARTS.map((b) => [b.id, 0])) as Record<BodyPart, number>, total: 0, other: 0 };
}

/** The human's gun hits by body part over the match's full rounds; optionally one weapon class. */
export function hitMap(m: MatchFile, cls?: string | null): HitMap | null {
  const s = m.aim.shots;
  if (!s.ri.length) return null;
  const isFull = fullRoundTest(m);
  const out = emptyHitMap();
  for (let i = 0; i < s.ri.length; i++) {
    const h = s.hit[i];
    if (h === null || !isFull(s.ri[i])) continue;
    const pc = s.cls?.[i];
    const c = pc === undefined ? weaponClass(m.weapons[s.weapon[i]] ?? "") : pc === "shotgun" ? "heavy" : pc;
    if (!c || !GUNS.has(c) || (cls && c !== cls)) continue;
    out.total++;
    const part = HITGROUP[h];
    if (part) out.counts[part]++;
    else out.other++;
  }
  return out;
}

export function mergeHitMaps(a: HitMap, b: HitMap): HitMap {
  for (const p of BODY_PARTS) a.counts[p.id] += b.counts[p.id];
  a.total += b.total;
  a.other += b.other;
  return a;
}

// ---------------------------------------------------------------- per weapon
// The engine's aim aggregate splits by weapon class; the per-gun table and the Weapons view need
// single weapons, so the human's shots and kills are tallied here from the raw file. Interim, like
// the hit map above.

export interface WeaponTally {
  weapon: string;
  cls: string;
  shots: number;
  hits: number;
  headHits: number;
  /** first bullets of a burst fired with an enemy within 10° of the aim, and how many hit */
  firstOnTarget: number;
  firstHits: number;
  kills: number;
  hsKills: number;
  /** rounds in which the weapon fired or killed */
  rounds: number;
}

const emptyTally = (weapon: string, cls: string): WeaponTally => ({ weapon, cls, shots: 0, hits: 0, headHits: 0, firstOnTarget: 0, firstHits: 0, kills: 0, hsKills: 0, rounds: 0 });

/** The human's tallies per weapon over full rounds. Kills come from the kill log (every file); shots only from recorded files. */
export function weaponTallies(m: MatchFile): Map<string, WeaponTally> {
  const out = new Map<string, WeaponTally>();
  const isFull = fullRoundTest(m);
  const roundsSeen = new Map<string, Set<number>>();
  const get = (w: string) => {
    let t = out.get(w);
    if (!t) { t = emptyTally(w, weaponClass(w)); out.set(w, t); roundsSeen.set(w, new Set()); }
    return t;
  };
  const s = m.aim.shots;
  const tr = m.env.tickrate || 64;
  let prev = -1;
  for (let i = 0; i < s.ri.length; i++) {
    if (!isFull(s.ri[i])) continue;
    const w = m.weapons[s.weapon[i]] ?? "unknown";
    const cls = weaponClass(w);
    if (!GUNS.has(cls)) continue;
    const t = get(w);
    roundsSeen.get(w)!.add(s.ri[i]);
    t.shots++;
    const h = s.hit[i];
    if (h !== null) { t.hits++; if (h === 1) t.headHits++; }
    // a burst's first bullet: weapon or round change, or 0.3 s since the previous shot (stats/aim.ts)
    const first = prev < 0 || s.ri[prev] !== s.ri[i] || s.weapon[prev] !== s.weapon[i] || s.tick[i] - s.tick[prev] >= 0.3 * tr;
    if (first && s.target[i] !== null) { t.firstOnTarget++; if (h !== null) t.firstHits++; }
    prev = i;
  }
  const k = m.kills;
  for (let i = 0; i < k.ri.length; i++) {
    if (!isFull(k.ri[i]) || k.killer[i] !== m.human || (k.kBody?.[i] ?? null) !== null) continue;
    const side = m.rounds.side[k.ri[i]];
    if (side?.[k.victim[i]] === side?.[m.human]) continue;
    const w = m.weapons[k.weapon[i]] ?? "unknown";
    const t = get(w);
    roundsSeen.get(w)!.add(k.ri[i]);
    t.kills++;
    if (k.flags[i] & 1) t.hsKills++;
  }
  for (const [w, set] of roundsSeen) out.get(w)!.rounds = set.size;
  return out;
}

export function mergeTallies(into: Map<string, WeaponTally>, from: Map<string, WeaponTally>) {
  for (const [w, t] of from) {
    const a = into.get(w) ?? emptyTally(w, t.cls);
    for (const key of ["shots", "hits", "headHits", "firstOnTarget", "firstHits", "kills", "hsKills", "rounds"] as const) a[key] += t[key];
    into.set(w, a);
  }
  return into;
}
