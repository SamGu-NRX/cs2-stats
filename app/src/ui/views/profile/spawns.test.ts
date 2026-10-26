import { describe, expect, it } from "vitest";
import type { RoleBlend } from "../../../stats/identity";
import { groupSpawns, SPAWN_MIN_ROUNDS, SPAWN_TOP } from "./spawns";

let n = 0;
/** One engine spawn row: a fresh spawn id each time, as the engine lists each spawn point once. */
function row(side: "T" | "CT", position: string | null, place: string | null, rounds: number, blend: Record<string, number> | null) {
  const decision = { side, primary: null, probability: null, top2: null, reason: null, distribution: blend, blend, calibrationStatus: {}, metrics: [], evidence: [], rounds, awp: null, loadoutRounds: 0, tips: {} as RoleBlend["tips"] };
  return { spawn: `s${++n}`, map: "de_dust2", side, place, position, rounds, blend: decision };
}

describe("groupSpawns", () => {
  it("merges rows with the same side, place and position and sums their rounds", () => {
    const g = groupSpawns([row("T", "front right", "TSpawn", 3, { Entry: 1 }), row("T", "front right", "TSpawn", 4, { Entry: 1 }), row("T", "back left", "TSpawn", 3, { Entry: 1 })]);
    expect(g.shown.map((x) => [x.label, x.rounds])).toEqual([["front right, TSpawn", 7], ["back left, TSpawn", 3]]);
  });

  it("keeps the same place and position apart on the two sides", () => {
    const g = groupSpawns([row("T", "left", "Mid", 4, { Entry: 1 }), row("CT", "left", "Mid", 4, { Anchor: 1 })]);
    expect(g.shown.map((x) => [x.side, x.role])).toEqual([["T", "Entry"], ["CT", "Anchor"]]);
  });

  it("weights each row's blend by its rounds", () => {
    // 6 rounds all Entry and 2 rounds all Lurker: Entry is 6 of 8
    const g = groupSpawns([row("T", "right", "TSpawn", 6, { Entry: 1 }), row("T", "right", "TSpawn", 2, { Lurker: 1 })]);
    expect(g.shown[0].role).toBe("Entry");
    expect(g.shown[0].fit).toBeCloseTo(0.75, 10);
  });

  it("weights blends, not winners: two small rows can outvote a larger split row", () => {
    // 5 rounds at Entry 0.6 / Lurker 0.4, then 2 + 2 rounds all Lurker: Lurker is (2 + 2 + 2) of 9
    const g = groupSpawns([row("T", "a", "B", 5, { Entry: 0.6, Lurker: 0.4 }), row("T", "a", "B", 2, { Lurker: 1 }), row("T", "a", "B", 2, { Lurker: 1 })]);
    expect(g.shown[0].role).toBe("Lurker");
    expect(g.shown[0].fit).toBeCloseTo(6 / 9, 10);
  });

  it("counts a row without a blend in the rounds but not in the role", () => {
    const g = groupSpawns([row("CT", "back", "CTSpawn", 3, { Rotator: 1 }), row("CT", "back", "CTSpawn", 5, null)]);
    expect(g.shown[0]).toMatchObject({ rounds: 8, role: "Rotator", fit: 1 });
  });

  it("gives a group with no blend at all no role", () => {
    const g = groupSpawns([row("T", "centre", "TSpawn", 4, null)]);
    expect(g.shown[0]).toMatchObject({ rounds: 4, role: null, fit: null });
  });

  it("labels a spawn without position or place by its id and does not merge it with others", () => {
    const a = row("T", null, null, 4, { Entry: 1 });
    const b = row("T", null, null, 4, { Entry: 1 });
    expect(groupSpawns([a, b]).shown.map((x) => x.label)).toEqual([a.spawn, b.spawn].sort());
  });

  it(`shows the top ${SPAWN_TOP} groups by rounds and puts the rest, and every group under ${SPAWN_MIN_ROUNDS} rounds, in "more"`, () => {
    const rows = [
      ...[10, 9, 8, 7, 6, 5, 4].map((r, i) => row("T", `p${i}`, "TSpawn", r, { Entry: 1 })),
      row("CT", "q", "CTSpawn", 2, { Anchor: 1 }),
      row("CT", "r", "CTSpawn", 1, { Anchor: 1 }),
    ];
    const g = groupSpawns(rows);
    expect(g.shown.map((x) => x.rounds)).toEqual([10, 9, 8, 7, 6, 5]);
    expect(g.more).toEqual({ groups: 3, rounds: 4 + 2 + 1 });
  });

  it(`leaves a group under ${SPAWN_MIN_ROUNDS} rounds out even when fewer than ${SPAWN_TOP} groups remain`, () => {
    const g = groupSpawns([row("T", "a", "TSpawn", 3, { Entry: 1 }), row("T", "b", "TSpawn", 2, { Entry: 1 })]);
    expect(g.shown.map((x) => x.label)).toEqual(["a, TSpawn"]);
    expect(g.more).toEqual({ groups: 1, rounds: 2 });
  });

  it("orders equal rounds T before CT, then by label", () => {
    const g = groupSpawns([row("CT", "a", "S", 4, null), row("T", "b", "S", 4, null), row("T", "a", "S", 4, null)]);
    expect(g.shown.map((x) => `${x.side} ${x.label}`)).toEqual(["T a, S", "T b, S", "CT a, S"]);
  });

  it("returns nothing for no rows", () => {
    expect(groupSpawns([])).toEqual({ shown: [], more: { groups: 0, rounds: 0 } });
  });
});
