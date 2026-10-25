// Aim stat definitions (label, tooltip, value), shared by the Aim views and the profile's Aim card.
// Kept apart from the chart code so the profile overview does not load the charts.
import { COUNTER_STRAFE_FRACTION, SPRAY_FROM_IDX, sprayControl, type ShotStats } from "../../stats/aim";

const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : "–");
export const NEEDS = "Needs the shot field from capture plugin 1.0.0 or later.";
export const CLASS_LABEL: Record<string, string> = { rifle: "Rifles", sniper: "Snipers", smg: "SMGs", heavy: "Heavy", pistol: "Pistols" };

/**
 * validating: depends on visibility (visTarget, engagements), not yet validated in-game;
 * provisional: depends on the plugin's target selection (any enemy within 10°);
 * smoke: uses the plugin's approximate smoke volume.
 */
export type AimFlag = "validating" | "provisional" | "smoke";
export interface AimStat { id: string; label: string; tip: string; value: (s: ShotStats) => string; flags?: AimFlag[]; extra?: (s: ShotStats) => string | null }
export const AIM_STATS: AimStat[] = [
  { id: "acc", label: "Accuracy", tip: "Hits divided by shots, for every gun shot.", value: (s) => pct(s.hits, s.shots) },
  { id: "spotted", label: "Spotted accuracy", tip: "Hits divided by shots fired while your target was visible to you (Leetify's definition), so spraying at nothing does not count.", value: (s) => pct(s.spottedHits, s.spotted), flags: ["validating"] },
  { id: "adjusted", label: "Adjusted accuracy", tip: `Spotted accuracy without shots through smoke or wallbang kills. Shots whose smoke or wallbang state is unknown are set aside, not counted. ${NEEDS}`, value: (s) => (s.adjusted ? pct(s.adjustedHits, s.adjusted) : "–"), flags: ["validating", "smoke"], extra: (s) => (s.adjUnknown ? `${s.adjUnknown} shots unknown` : null) },
  { id: "head", label: "Head accuracy", tip: "Hits on the head divided by all your hits.", value: (s) => pct(s.headHits, s.hits) },
  { id: "hsk", label: "Headshot kills", tip: "Share of your kills that were headshots.", value: (s) => pct(s.hsKills, s.kills) },
  { id: "first", label: "First-bullet accuracy", tip: "Hit rate of the first bullet of each burst fired with an enemy within 10° of your aim (visible or not).", value: (s) => pct(s.firstHits, s.firstOnTarget), flags: ["provisional"] },
  { id: "spray", label: "Spray accuracy", tip: `Hit rate of bullets ${SPRAY_FROM_IDX} and later in a burst fired with an enemy within 10° of your aim (visible or not).`, value: (s) => pct(s.sprayHits, s.sprayOnTarget), flags: ["provisional"] },
  { id: "control", label: "Spray control", tip: `Mean angle between each bullet and the target's head for bullets ${SPRAY_FROM_IDX} and later, from where the bullet hit and where the target was. Lower is better.`, value: (s) => { const v = sprayControl(s); return v === null ? "–" : `${v.toFixed(2)}°`; } },
  { id: "strafe", label: "Counter-strafing", tip: `First bullets of a burst fired at no more than ${COUNTER_STRAFE_FRACTION * 100}% of the weapon's max speed.`, value: (s) => pct(s.firstStrafed, s.firstStrafeKnown) },
  { id: "wbHits", label: "Wallbang kill shots", tip: `Shots that killed through a wall or object (the game's penetration flag on the kill). Shown on their own, not counted in adjusted accuracy. ${NEEDS}`, value: (s) => (s.penKnown ? String(s.wallbangHits) : "–") },
  { id: "wbKills", label: "Wallbang kills", tip: "Your kills through a wall or object.", value: (s) => String(s.wallbangKills) },
  { id: "smokeKills", label: "Smoke kills", tip: "Your kills through smoke.", value: (s) => String(s.smokeKills) },
  { id: "smokeSpam", label: "Smoke spam", tip: `Share of your shots fired through smoke. ${NEEDS}`, value: (s) => (s.smokeKnown ? pct(s.smokeShots, s.smokeKnown) : "–"), flags: ["smoke"] },
];


export const FLAG_LABEL: Record<AimFlag, string> = { validating: "Validating", provisional: "Provisional", smoke: "Smoke approximated" };
export const FLAG_TIP: Record<AimFlag, string> = {
  validating: "Depends on the plugin's visibility detection, which is still being checked against the game. Provisional until the plugin marks visibility as validated.",
  provisional: "Depends on which enemy the plugin picks as your target (the closest alive enemy within 10° of your aim). Provisional.",
  smoke: "Uses the plugin's approximate smoke volume (a 144-unit sphere for 22 s), which has not been validated in-game.",
};
