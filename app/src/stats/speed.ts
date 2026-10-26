// The speed above which a gun shoots inaccurately, shared by the luck family and the tools.
import { ACCURATE_FRAC } from "./aim-geometry";
import { MAX_SPEED } from "./aim-ref";

/**
 * ACCURATE_FRAC of the gun's max speed (research-data-sources.md, NextFrag): its scoped max speed when
 * scoped, else its unscoped one. Null for a gun the weapon data lacks, and for a gun with a scoped speed
 * whose scope state is not recorded: then the limit is unknown, not the unscoped one.
 */
export function accurateSpeed(weapon: string, scoped: boolean | null): number | null {
  const max = MAX_SPEED[weapon];
  if (!max) return null;
  if (max.length > 1 && scoped === null) return null;
  return ACCURATE_FRAC * (scoped && max.length > 1 ? max[1] : max[0]);
}
