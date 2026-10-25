// Spawn names for the role-by-spawn view (views.ts spawnRows), on a hand-built round. CT spawns at
// (100, 100) and (-100, -100), keyed to 16 units as (96, 96) and (-96, -96); both T players spawn at
// (1000, 0). CT faces +x, so +y is CT's left.
import { expect, it } from "vitest";
import { oneRound } from "../stats/testing/match";
import { addSpawns, emptySpawns, spawnRows } from "./views";

it("names each spawn by its place and its position in the side's spawn area", () => {
  // fails if the facing, left and right, or the 64-unit cut changes, or the place name is lost
  const at = (steamid: string, x: number, y: number, place: string) => ({ steamid, tick: 0, x, y, place });
  const f = oneRound({
    players: { c1: "CT", c2: "CT", t1: "T", t2: "T" },
    positions: [at("c1", 100, 100, "CTSpawn"), at("c2", -100, -100, "CTSpawn"), at("t1", 1000, 0, "TSpawn"), at("t2", 1000, 0, "TSpawn")],
  });
  const acc = emptySpawns();
  addSpawns(acc, f, new Set(["c1", "c2", "t1"]));
  const rows = spawnRows(acc);
  expect(rows.CT.map((r) => [r.spawn, r.place, r.position, r.map, r.rounds])).toEqual([
    ["96,96", "CTSpawn", "front left", "de_test", 1],
    ["-96,-96", "CTSpawn", "back right", "de_test", 1],
  ]);
  expect(rows.T.map((r) => [r.spawn, r.position])).toEqual([["1008,0", "centre"]]);
});
