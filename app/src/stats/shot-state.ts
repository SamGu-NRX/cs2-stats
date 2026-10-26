// One rule for whether a shot fired with its gun's normal recoil, shared by the spray pattern builder
// (recoil-build.ts) and the spray facts (aim.ts). Zooming changes how a scoped gun kicks and moves the
// view, and the M4A1-S kicks differently without its silencer, so a reference pattern is built only
// from shots known to be in the normal state, and a spray is compared with it only when it is too.

import { MAX_SPEED } from "./aim-ref";
import { accurateSpeed } from "./speed";

/**
 * Whether a shot had its gun's normal recoil: true when known (unscoped, and for the M4A1-S silenced),
 * false when known not to be, null when the state the gun depends on was not recorded. A gun without a
 * scope needs no scope state (speed.ts accurateSpeed's rule: a gun has a scope when the weapon data
 * gives it a scoped speed), and only the M4A1-S needs a silencer state.
 */
export function normalRecoil(weapon: string, scoped: boolean | null, silenced: boolean | null): boolean | null {
  if (scoped === true) return false;
  if (scoped === null && MAX_SPEED[weapon] && accurateSpeed(weapon, null) === null) return null;
  if (weapon === "m4a1_silencer") return silenced;
  return true;
}
