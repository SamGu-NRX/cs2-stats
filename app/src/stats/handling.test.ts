// Reloads and wasted magazine (handling.ts) from the clip count each shot carries.
import { expect, it } from "vitest";
import { METRIC } from "./metrics";
import { rollup } from "./rollup";
import { FREEZE_END, oneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;
const shot = (s: number, ammo: number | null, weapon = "ak47") => ({ tick: t(s), steamid: "a", weapon, ammo_clip: ammo });

it("reads a reload from the clip count rising between two shots of one gun", () => {
  // fails if the clip convention (the count before the shot) or the share is wrong: the AK fires at 30,
  // 29 and 10 (9 left), then at 30 after a reload, throwing away 9 of 30; the deagle's 7 after a switch
  // is a new gun, not a reload. One reload in one round: 30% wasted, 1 reload per round
  const f = oneRound({ players: { a: "CT", b: "T" }, shots: [shot(1, 30), shot(2, 29), shot(3, 10), shot(4, 7, "deagle"), shot(5, 30)] });
  const s = rollup([f], { player: "a" });
  expect([s.m.reloads, s.m.ammoRounds]).toEqual([1, 1]);
  expect([METRIC.wastedMagazine.value(s), METRIC.reloadsPR.value(s)]).toEqual([30, 1]);
});

it("gives no value, and says so, when a shot has no clip count", () => {
  // fails if a plugin round (no clip counts) reads as a round without reloads
  const f = oneRound({ players: { a: "CT", b: "T" }, shots: [shot(1, 30), shot(2, null)] });
  const s = rollup([f], { player: "a" });
  expect([s.m.ammoRounds ?? 0, METRIC.wastedMagazine.value(s)]).toEqual([0, null]);
});
