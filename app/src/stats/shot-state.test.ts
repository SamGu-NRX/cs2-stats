// The normal-recoil rule on every case it distinguishes.
import { expect, it } from "vitest";
import { normalRecoil } from "./shot-state";

it("calls a shot normal only when the state its gun depends on is known and normal", () => {
  // fails if an unknown scope on a scoped gun, or an unknown silencer on the M4A1-S, reads as normal
  expect([
    normalRecoil("ak47", false, null), normalRecoil("ak47", null, null), normalRecoil("ak47", true, null),
    normalRecoil("aug", false, null), normalRecoil("aug", null, null), normalRecoil("aug", true, null),
    normalRecoil("m4a1_silencer", false, true), normalRecoil("m4a1_silencer", false, false), normalRecoil("m4a1_silencer", null, null),
  ]).toEqual([true, true, false, true, null, false, true, false, null]);
});
