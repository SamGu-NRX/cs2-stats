// rollup's round filter and presence folding.
import { expect, it } from "vitest";
import { rollup } from "./rollup";
import { FREEZE_END, oneRound } from "./testing/match";

it("keeps only the rounds a round filter names, by round number", () => {
  // fails if the filter matches row indexes instead of round numbers (a match whose tables start at round 7)
  const kill = [{ tick: FREEZE_END + 100, killer: "a", victim: "b" }];
  const facts = [oneRound({ players: { a: "CT", b: "T" }, kills: kill }), oneRound({ round: 7, players: { a: "CT", b: "T" }, kills: kill })];
  expect(rollup(facts, { player: "a", rounds: [7] }).m.kills).toBe(1);
  expect(rollup(facts, { player: "a", rounds: [1] }).matches).toBe(1);
});

it("adds up seconds alive per place and grid cell, leaving out dead samples", () => {
  // fails if dead samples count, or presence lands on the wrong player
  const at = (tick: number, steamid: string, x: number, place: string, is_alive = true) => ({ tick, steamid, x, y: 0, place, is_alive });
  const f = oneRound({
    players: { a: "CT", b: "T" },
    positions: [at(1000, "a", 10, "BombsiteA"), at(1016, "a", 20, "BombsiteA"), at(1032, "a", 500, "Long"), at(1048, "a", 500, "Long", false), at(1000, "b", 10, "Mid")],
  });
  const p = rollup([f], { player: "a" }).presence.de_test;
  expect(p.places).toEqual({ BombsiteA: 0.5, Long: 0.25 });
  expect(Object.values(p.cells).sort()).toEqual([0.25, 0.5]);
});
