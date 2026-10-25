// Per-gun rows take each hit's gun from the shot on the same tick.
import { expect, it } from "vitest";
import { oneRound } from "./testing/match";

it("files a hit under its shot's gun when damages name it differently or not at all", () => {
  // fails if an M4A1-S hit lands under the M4A4 (damages call both "m4a1"), or a rebuilt hit with no weapon is dropped
  const hit = (tick: number, weapon: string | null) => ({ tick, attacker_steamid: "a", victim_steamid: "b", weapon, dmg_health: weapon ? 30 : null, dmg_health_capped: 30, health_before: 100, a_side: "CT", v_side: "T" });
  const f = oneRound({
    players: { a: "CT", b: "T" },
    shots: [{ tick: 1000, steamid: "a", weapon: "m4a1_silencer" }, { tick: 1100, steamid: "a", weapon: "m4a1_silencer" }],
    damages: [hit(1000, "m4a1"), hit(1100, null)],
  });
  expect(f.weapons.map((w) => [w.weapon, w.shots, w.hits, w.dmg])).toEqual([["m4a1_silencer", 2, 2, 60]]);
});
