// The lists behind the career ratings and personal bests (career.ts): which metrics make each 0-100
// composite, and which per-match counts have a best. They live apart from career.ts, which imports
// every metric, so Profile can label them without loading the engine.
import type { Input, Measures } from "./facts";

/** One input of a composite: a metric, its weight, and whether a higher percentile is worse (an identity metric where more is worse). */
export interface CompositePart { id: string; weight: number; invert?: boolean }

/**
 * The composites and their inputs, every weight 1 (ours: Leetify does not publish its weights). A
 * performance metric's percentile already reads higher-is-better (compare() flips lowerIsBetter); the
 * identity inputs read as more is better except teammates flashed, which is inverted.
 */
export const COMPOSITES: Record<"aimRating" | "utilityQuantity" | "utilityQuality", CompositePart[]> = {
  aimRating: ["crosshairPlacement", "timeToDamage", "firstBulletAccuracy", "sprayAccuracy", "headAccuracy", "counterStrafe", "sightAccuracy"].map((id) => ({ id, weight: 1 })),
  utilityQuantity: ["flashesPR", "smokesPR", "hesPR", "molotovsPR"].map((id) => ({ id, weight: 1 })),
  utilityQuality: [
    ...["flashKillsPerFlash", "enemiesPerFlash", "blindPerFlash", "dmgPerHe", "molotovDmg", "utilUnused"].map((id) => ({ id, weight: 1 })),
    { id: "teamFlashPR", weight: 1, invert: true },
  ],
};

/** Per-match counts with a best: the most in one match, from a match that recorded the inputs in `needs`. */
export const BEST_COUNTS: { id: string; label: string; needs?: Input[]; of: (m: Measures) => number }[] = [
  { id: "kills", label: "Kills", of: (m) => m.kills },
  { id: "assists", label: "Assists", of: (m) => m.assists },
  { id: "hsKills", label: "Headshot kills", of: (m) => m.hsKills },
  { id: "dmg", label: "Damage", of: (m) => m.dmg },
  { id: "multiKillRounds", label: "Multi-kill rounds", of: (m) => m.multiKillRounds },
  { id: "openingKills", label: "Opening kills", of: (m) => m.openingKills },
  { id: "tradeKills", label: "Trade kills", of: (m) => m.tradeKills },
  { id: "clutchesWon", label: "Clutches won", of: (m) => m.clutchWon1 + m.clutchWon2 + m.clutchWon3 + m.clutchWon4 + m.clutchWon5 },
  { id: "enemiesFlashed", label: "Enemies flashed", needs: ["utility"], of: (m) => m.enemiesFlashed },
  { id: "utilDmg", label: "Utility damage", needs: ["utility"], of: (m) => m.utilDmg },
];
