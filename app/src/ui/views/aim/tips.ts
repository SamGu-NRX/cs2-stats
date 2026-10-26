// Hover text for the aim metrics, one sentence of twelve words or fewer each. The engine's own
// definitions (stats/aim.ts AIM_METRICS def) run to several sentences with thresholds; metrics-v2
// shortens them, and a metric without an entry here shows its engine definition.
import { metric } from "../../data/meta";

export const AIM_TIP: Record<string, string> = {
  accuracy: "Gun shots that hit an enemy, of all gun shots.",
  firstBulletAccuracy: "Hits per first bullet fired at a visible enemy.",
  sightAccuracy: "Hits per shot fired while an enemy was visible near your crosshair.",
  timeToDamage: "Median time from an enemy appearing to your first damage.",
  timeToKill: "Median time from an enemy appearing to your kill on him.",
  reactionTime: "Median time from an enemy appearing to your aim moving toward him.",
  timeToShot: "Median time from an enemy appearing to your first shot.",
  crosshairPlacement: "Median angle from your crosshair to his head when he appears.",
  crosshairMoved: "Median angle your view turned between seeing an enemy and damaging him.",
  preAim: "Sightings with your crosshair already near the enemy's head.",
  counterStrafe: "Rifle and sniper first bullets fired slow enough to be accurate.",
  csTooEarly: "Mistimed shots fired while still slowing down.",
  csLateReversal: "Mistimed shots fired while already moving back the other way.",
  csNoStop: "Mistimed shots fired with no attempt to stop.",
  sprayDeviation: "Mean distance per bullet from the median pro spray path.",
  sprayPull: "Pull-down against pros: positive pulls more, negative pulls less.",
  flickOvershoot: "Median angle a reaction flick carried past the head.",
  microCorrections: "Small view corrections after a flick, before the first shot.",
  trackingError: "Mean angle to the enemy's head while tracking him.",
  sprayTransfers: "Sprays where you switched to a new target.",
  transferHits: "Target switches mid-spray where the rest hit the new target.",
};

export const aimTip = (id: string) => AIM_TIP[id] ?? metric(id).def;
