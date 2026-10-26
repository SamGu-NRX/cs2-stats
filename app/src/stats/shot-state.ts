// One rule for whether a shot fired with its gun's normal recoil, shared by the spray pattern builder
// (recoil-build.ts) and the spray facts (aim.ts). Zooming changes how a scoped gun kicks and moves the
// view, and the M4A1-S kicks differently without its silencer, so a reference pattern is built only
// from shots known to be in the normal state, and a spray is compared with it only when it is too.

/** Guns with a scope (shots.scoped can be true for them). */
export const SCOPE_WEAPONS: ReadonlySet<string> = new Set(["aug", "sg556", "awp", "ssg08", "g3sg1", "scar20"]);

/**
 * Whether a shot had its gun's normal recoil: true when known (unscoped, and for the M4A1-S silenced),
 * false when known not to be, null when the state the gun depends on was not recorded. A gun without a
 * scope needs no scope state, and only the M4A1-S needs a silencer state.
 */
export function normalRecoil(weapon: string, scoped: boolean | null, silenced: boolean | null): boolean | null {
  if (scoped === true) return false;
  if (scoped === null && SCOPE_WEAPONS.has(weapon)) return null;
  if (weapon === "m4a1_silencer") return silenced;
  return true;
}
