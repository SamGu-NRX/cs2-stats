// Reloads and wasted magazine (handling.ts) from the clip count each shot carries.
import { expect, it } from "vitest";
import { METRIC } from "./metrics";
import { rollup } from "./rollup";
import { FREEZE_END, oneRound, type OneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;
const shot = (s: number, ammo: number | null, weapon = "ak47") => ({ tick: t(s), steamid: "a", weapon, ammo_clip: ammo, x: 0, y: 0 });
/** a's 4 Hz samples at the origin from `from` to `to` seconds, holding `weapon` (a display name) */
const holding = (from: number, to: number, weapon = "AK-47") =>
  Array.from({ length: (to - from) * 4 + 1 }, (_, i) => ({ steamid: "a", tick: t(from) + 16 * i, x: 0, y: 0, active_weapon: weapon }));
/** a fires the AK at 10 (9 left) at 3 s and at 30 at 5 s, holding it throughout unless `m` says otherwise */
const rise = (m: Partial<OneRound> = {}) => rollup([oneRound({
  players: { a: "CT", b: "CT", d: "T", e: "T" }, shots: [shot(3, 10), shot(5, 30)], positions: holding(0, 8), ...m,
})], { player: "a" });

it("reads a reload from the clip count rising between two shots of a gun held throughout", () => {
  // fails if the clip convention (the count before the shot) or the share is wrong: the AK fires at 30,
  // 29 and 10 (9 left), then at 30 after a reload, throwing away 9 of 30. One reload in one round:
  // 30% wasted, 1 reload per round
  const f = oneRound({ players: { a: "CT", b: "T" }, shots: [shot(1, 30), shot(2, 29), shot(3, 10), shot(5, 30)], positions: holding(0, 8) });
  const s = rollup([f], { player: "a" });
  expect([s.m.reloads, s.m.ammoRounds]).toEqual([1, 1]);
  expect([METRIC.wastedMagazine.value(s), METRIC.reloadsPR.value(s)]).toEqual([30, 1]);
});

it("reads no reload across a gun a dying player dropped within reach, which could have been picked up", () => {
  // fails if picking up a second AK counts as a reload: d dies holding an AK 50 units from a between
  // a's two shots, so the 30 may be the other gun's clip. A death 2000 units away leaves the reload
  const death = (x: number) => ({ kills: [{ tick: t(4), killer: "b", victim: "d", at: { v_x: x, v_y: 0, v_active_weapon: "AK-47" } }] });
  const near = rise(death(50));
  expect([near.m.reloads, near.m.ammoRounds, METRIC.wastedMagazine.value(near)]).toEqual([0, 1, null]);
  expect(rise(death(2000)).m.reloads).toBe(1);
  // a best primary on the ground counts the same as the gun in hand
  expect(rise({ kills: [{ tick: t(4), killer: "b", victim: "d", at: { v_x: 50, v_y: 0, v_active_weapon: "Glock-18", v_best_primary: "AK-47" } }] }).m.reloads).toBe(0);
});

it("keeps the gun across a switch to another weapon and back", () => {
  // fails if a switch ends the run: the game drops only the gun in hand, so firing the deagle at 4 s,
  // or holding the knife then, leaves a with the same AK, and the rise to 30 is still the reload
  expect(rise({ shots: [shot(3, 10), shot(4, 7, "deagle"), shot(5, 30)] }).m.reloads).toBe(1);
  expect(rise({ positions: holding(0, 8).map((p) => (p.tick === t(4) ? { ...p, active_weapon: "Karambit" } : p)) }).m.reloads).toBe(1);
});

it("reads no reload across a gap in the samples or a purchase of the same gun", () => {
  // fails if a copy that may have reached the player is ignored: no sample from 3 to 4.5 s or from 4 to
  // 5 s (over the half second one missed sample allows, so the path near a dropped gun is unknown), or
  // a second AK bought at 4 s
  expect(rise({ positions: holding(0, 8).filter((p) => p.tick <= t(3) || p.tick >= t(4.5)) }).m.reloads).toBe(0);
  expect(rise({ positions: holding(0, 8).filter((p) => p.tick <= t(4) || p.tick >= t(5)) }).m.reloads).toBe(0);
  expect(rise({ purchases: [{ tick: t(4), steamid: "a", item: "AK-47", cost: 2700 }] }).m.reloads).toBe(0);
});

it("gives no value, and says so, without positions to show the gun in hand", () => {
  // fails if a round with clip counts but no samples reads as a round without reloads
  const s = rise({ positions: undefined });
  expect([s.m.ammoRounds ?? 0, METRIC.reloadsPR.value(s)]).toEqual([0, null]);
});

it("gives no value, and says so, when a shot has no clip count", () => {
  // fails if a plugin round (no clip counts) reads as a round without reloads
  const f = oneRound({ players: { a: "CT", b: "T" }, shots: [shot(1, 30), shot(2, null)], positions: holding(0, 8) });
  const s = rollup([f], { player: "a" });
  expect([s.m.ammoRounds ?? 0, METRIC.wastedMagazine.value(s)]).toEqual([0, null]);
});
