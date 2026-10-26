// rollup's round filter and presence folding.
import { expect, it } from "vitest";
import { rollup } from "./rollup";
import { roundPlaces } from "./positions";
import { FREEZE_END, oneRound, oneRoundTables } from "./testing/match";

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
  // presence is per side, so a round-level filter cannot honour it and leaves it out
  expect(rollup([f], { player: "a", rounds: [1] }).presence).toEqual({});
});

it("reads one round's places from the tables", () => {
  // fails if "where you spent the round" mixes in another round or a dead player's samples
  const t = oneRoundTables({
    players: { a: "CT", b: "T" },
    positions: [
      { tick: 1000, steamid: "a", x: 0, y: 0, place: "Mid" }, { tick: 1016, steamid: "a", x: 0, y: 0, place: "Mid", is_alive: false },
      { tick: 9000, round: 2, steamid: "a", x: 0, y: 0, place: "Long" }, { tick: 1000, steamid: "b", x: 0, y: 0, place: "Long" },
    ],
  });
  expect(roundPlaces(t, 1, "a")).toEqual({ Mid: 0.25 });
});

it("reads from and to as days in the user's time zone, and a date-only source as its date", () => {
  // fails if the bounds compare the UTC day: 00:06:42 UTC on 25 October is 19:06 on 24 October in
  // America/Chicago, so the match counts on the 24th there and on the 25th in UTC. A source with only
  // the date 2026-10-25 has no clock time to move, so it counts on the 25th in any zone
  const f = oneRound({ players: { a: "CT", c: "T" } });
  const at = (startedAt: string | null) => ({ ...f, match: { ...f.match, startedAt, date: "2026-10-25" } });
  const kept = (g: typeof f, day: string, timeZone: string) => rollup([g], { player: "a", from: day, to: day, timeZone }).m.rounds;
  const late = at("2026-10-25T00:06:42Z");
  expect([kept(late, "2026-10-24", "America/Chicago"), kept(late, "2026-10-25", "America/Chicago"), kept(late, "2026-10-25", "UTC")]).toEqual([1, 0, 1]);
  const dateOnly = at(null);
  expect([kept(dateOnly, "2026-10-25", "America/Chicago"), kept(dateOnly, "2026-10-24", "America/Chicago")]).toEqual([1, 0]);
});
