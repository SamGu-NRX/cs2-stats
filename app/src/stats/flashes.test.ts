// The flash tool's attribution (flashes.ts flashTool), on hand-built rounds: CT a and b against T c,
// d and e. a throws the flashes; b gets the kills.
import { describe, expect, it } from "vitest";
import { derive } from "./derive";
import { NO_GRENADE_EVENTS, flashTool } from "./flashes";
import { CS2RB } from "./model-params";
import { headToHead } from "./matchviews";
import { rollup } from "./rollup";
import { FREEZE_END, oneRoundTables, type OneRound } from "./testing/match";
import { rosterTables } from "./roster";

const t = (s: number) => FREEZE_END + 64 * s;
const players = { a: "CT", b: "CT", c: "T", d: "T", e: "T" } as const;
const tool = (m: Omit<OneRound, "players">, who = "a") => {
  const tables = oneRoundTables({ players, ...m });
  return flashTool(rosterTables(tables), derive(tables, CS2RB), who);
};
const pi = { a: 0, b: 1, c: 2, d: 3, e: 4 };
const det = (s: number, entity: number, by = "a", at: [number, number] | null = [100, 200]) => ({ tick: t(s), event: "flash_detonate", entity_id: entity, steamid: by, x: at?.[0] ?? null, y: at?.[1] ?? null });
const blind = (s: number, entity: number | null, victim: string, secs: number, more: Record<string, unknown> = {}) => ({ tick: t(s), attacker_steamid: "a", victim_steamid: victim, duration: secs, flash_entity_id: entity, ...more });

describe("flashTool", () => {
  it("places each flash and lists whom it blinded, enemies first and longest first, without the thrower", () => {
    // fails if the thrower's own blind is listed, a teammate sorts among the enemies, the 1.1 s cut is
    // not marked, another player's detonation is taken for a's, or the two blinded players without a
    // position sample go unreported. c stood at (500, 600) when blinded
    const r = tool({
      grenade_events: [det(10, 7), det(20, 8, "b")],
      blinds: [blind(10, 7, "d", 0.8), blind(10, 7, "b", 1.5, { is_team_flash: true }), blind(10, 7, "c", 2.5), blind(10, 7, "a", 1, { is_self: true })],
      positions: [{ tick: t(10), steamid: "c", x: 500, y: 600 }],
    });
    expect(r.notes).toEqual(["2 of the 3 players these flashes blinded have no position sample near the blind, so no line can be drawn to them."]);
    expect(r.flashes.map((f) => [f.round, f.side, f.t, f.at])).toEqual([[1, "CT", 10, [100, 200]]]);
    expect(r.flashes[0].blinded).toEqual([
      { pi: pi.c, secs: 2.5, team: false, flashed: true, at: [500, 600] },
      { pi: pi.d, secs: 0.8, team: false, flashed: false, at: null },
      { pi: pi.b, secs: 1.5, team: true, flashed: true, at: null },
    ]);
  });

  it("credits a flash assist and a kill while blind, and not a kill after the blind ran out", () => {
    // fails if the kill on d (blinded 0.8 s, under the cut) is credited as while blind, the flash
    // assist on it is missed, the kill on c 1 s into a 2.5 s blind is missed, or e's death 10 s after
    // its 3 s blind is credited
    const r = tool({
      grenade_events: [det(10, 7), det(30, 9)],
      blinds: [blind(10, 7, "c", 2.5), blind(10, 7, "d", 0.8), blind(30, 9, "e", 3)],
      kills: [
        { tick: t(10) + 32, killer: "b", victim: "d", assister: "a", at: { assistedflash: true } },
        { tick: t(11), killer: "b", victim: "c", at: { weapon: "m4a1", headshot: true } },
        { tick: t(40), killer: "b", victim: "e" },
      ],
    });
    expect(r.flashes[0].kills).toEqual([
      { victim: pi.d, killer: pi.b, t: 10.5, weapon: "ak47", headshot: false, assist: true, whileBlind: false },
      { victim: pi.c, killer: pi.b, t: 11, weapon: "m4a1", headshot: true, assist: false, whileBlind: true },
    ]);
    expect(r.flashes[1].kills).toEqual([]);
  });

  it("gives a flash assist to the thrower's latest flash that blinded the victim", () => {
    // fails if the assist goes to the earlier flash, or to both. Flash 5 blinds c from 5 s to 8 s and
    // flash 6 from 8 s to 11 s; c dies at 9 s: an assist and a kill while blind for flash 6 only
    const r = tool({
      grenade_events: [det(5, 5), det(8, 6)],
      blinds: [blind(5, 5, "c", 3), blind(8, 6, "c", 3)],
      kills: [{ tick: t(9), killer: "b", victim: "c", assister: "a", at: { assistedflash: true } }],
    });
    expect(r.flashes.map((f) => f.kills.map((k) => [k.assist, k.whileBlind]))).toEqual([[], [[true, true]]]);
  });

  it("names what the file lacks: detonation points, blinded players' positions, and blinds with no detonation", () => {
    // fails if a flash without a position is dropped or placed, an unlinked blind is attributed by guess,
    // or the blinded player of the flash without a point goes uncounted because that flash is off the map
    const r = tool({
      grenade_events: [det(10, 7), det(30, 9, "a", null)],
      blinds: [blind(30, 9, "e", 2), blind(50, null, "e", 2), blind(60, 99, "c", 2)],
    });
    expect(r.flashes.map((f) => [f.at, f.blinded.length])).toEqual([[[100, 200], 0], [null, 1]]);
    expect(r.notes).toEqual([
      "1 of 2 flashes have no detonation point in this file, so they are not on the map.",
      "1 of the 1 players these flashes blinded have no position sample near the blind, so no line can be drawn to them.",
      "2 blinds name no detonation in this file, so they are left out.",
    ]);
  });

  it("says the file records no grenade events rather than reporting no flashes", () => {
    // fails if a file without any grenade or flash rows reads as a player who threw nothing
    expect(tool({})).toEqual({ flashes: [], thrown: null, notes: [NO_GRENADE_EVENTS] });
    // another player's detonation and no throw log: the file cannot say whether a threw one
    expect(tool({ grenade_events: [det(20, 8, "b")] })).toEqual({ flashes: [], thrown: null, notes: ["None of your flashbangs has a recorded detonation in this file, and it logs no throws."] });
    // an empty throw table logs nothing: the local Valve imports write one although their players threw
    // flashbangs, so it cannot say a threw none
    expect(tool({ grenade_throws: [], grenade_events: [det(20, 8, "b")] }).thrown).toBeNull();
  });

  it("says how many logged flashbang throws have no detonation, apart from a player who threw none", () => {
    // fails if throws without detonations read as "threw no flashbangs", or other players' throws and
    // other grenades count toward a's. a threw three flashbangs and one smoke; one flash detonated
    const throw_ = (s: number, by: string, weapon = "flashbang") => ({ tick: t(s), steamid: by, weapon });
    const none = tool({ grenade_throws: [throw_(3, "a"), throw_(4, "a"), throw_(5, "b")] });
    expect(none).toEqual({ flashes: [], thrown: 2, notes: ["2 of the 2 flashbangs you threw have no detonation in this file, so they are not listed."] });
    const some = tool({ grenade_throws: [throw_(3, "a"), throw_(4, "a"), throw_(6, "a"), throw_(7, "a", "smokegrenade")], grenade_events: [det(10, 7)] });
    expect([some.flashes.length, some.thrown, some.notes]).toEqual([1, 3, ["2 of the 3 flashbangs you threw have no detonation in this file, so they are not listed."]]);
    const zero = tool({ grenade_throws: [throw_(5, "b")] });
    expect(zero).toEqual({ flashes: [], thrown: 0, notes: [] });
  });

  it("keeps another thrower's blind off a flash whose entity id it reuses, and keeps a blind with no attacker", () => {
    // fails if b's flash, which reuses entity 7 after a's, attaches b's blind on d to a's flash, or a
    // blind with no recorded attacker is dropped. a's flash 7 detonates at 5 s; b's at 20 s
    const r = tool({
      grenade_events: [det(5, 7), det(20, 7, "b")],
      blinds: [blind(5, 7, "c", 2), blind(5, 7, "e", 1.5, { attacker_steamid: null }), blind(20, 7, "d", 3, { attacker_steamid: "b" })],
    });
    expect(r.flashes.map((f) => f.blinded.map((b) => [b.pi, b.secs]))).toEqual([[[pi.c, 2], [pi.e, 1.5]]]);
    expect(r.notes.filter((n) => /name no detonation|names no detonation/.test(n))).toEqual([]);
  });

  it("gives a blind with no attacker to the latest detonation of its entity by anyone", () => {
    // fails if a blind with no recorded attacker is matched against a's detonations only: a detonates
    // entity 7 at tick 10, b reuses it at tick 11, and the blind at tick 12 is b's flash's, not a's
    const tick = (n: number) => ({ ...det(0, 7), tick: n });
    const r = tool({
      grenade_events: [tick(10), { ...tick(11), steamid: "b" }],
      blinds: [{ ...blind(0, 7, "c", 2, { attacker_steamid: null }), tick: 12 }],
    });
    expect(r.flashes.map((f) => f.blinded.length)).toEqual([0]);
    // the same blind with a's flash the latest is a's
    const mine = tool({ grenade_events: [{ ...tick(10), steamid: "b" }, tick(11)], blinds: [{ ...blind(0, 7, "c", 2, { attacker_steamid: null }), tick: 12 }] });
    expect(mine.flashes.map((f) => f.blinded.map((b) => b.pi))).toEqual([[pi.c]]);
  });

  it("pairs throws with detonations by entity id, counts a repeated detonation row once, and falls back to tick order", () => {
    // fails if throws and detonations are matched by count: one throw of entity 7, its row and its
    // detonation each recorded twice, is one flash and no missing detonation; a second throw of entity 8 with no entity-8
    // detonation is missing even though another detonation (entity 9, whose throw is not logged) exists.
    // Throws without an entity id pair with the first unpaired detonation of the round after them
    const throw_ = (s: number, entity: number | null) => ({ tick: t(s), steamid: "a", weapon: "flashbang", entity_id: entity });
    const r = tool({ grenade_throws: [throw_(3, 7), throw_(3, 7), throw_(4, 8)], grenade_events: [det(5, 7), det(5, 7), det(9, 9)] });
    expect([r.flashes.length, r.thrown, r.notes]).toEqual([2, 2, ["1 of the 2 flashbangs you threw has no detonation in this file, so it is not listed."]]);
    const noIds = tool({ grenade_throws: [throw_(3, null), throw_(4, null), throw_(30, null)], grenade_events: [det(5, 7), det(6, 8)] });
    expect([noIds.flashes.length, noIds.thrown, noIds.notes]).toEqual([2, 3, ["1 of the 3 flashbangs you threw has no detonation in this file, so it is not listed."]]);
  });

  it("joins a player's repeated blinds under one flash into one window", () => {
    // fails if a repeated row lists the player twice, or keeps one row's start and so loses a kill in the
    // other: c is blinded from 10 s for 1 s and from 11 s for 2 s, one window from 10 s to 13 s, and the
    // assisted kill at 10.5 s lies inside it
    const r = tool({
      grenade_events: [det(10, 7)],
      blinds: [blind(10, 7, "c", 1), blind(11, 7, "c", 2)],
      kills: [{ tick: t(10.5), killer: "b", victim: "c", assister: "a", at: { assistedflash: true } }],
    });
    expect(r.flashes[0].blinded.map((b) => [b.pi, b.secs, b.flashed])).toEqual([[pi.c, 3, true]]);
    expect(r.flashes[0].kills.map((k) => [k.victim, k.assist, k.whileBlind])).toEqual([[pi.c, true, true]]);
  });

  it("counts the same blinds as the utility measures and head to head, with repeated and overlapping rows", () => {
    // fails if one layer counts raw rows and another joined windows. c's blind is recorded twice
    // (identical rows), d's in two overlapping parts (10 s for 1 s, 10.5 s for 2 s: one 2.5 s window),
    // and b, a teammate, twice. b kills c at 11 s and d at 12 s, both inside their windows
    const tables = oneRoundTables({
      players,
      grenade_events: [det(10, 7)],
      blinds: [blind(10, 7, "c", 2), blind(10, 7, "c", 2), blind(10, 7, "d", 1), blind(10.5, 7, "d", 2), blind(10, 7, "b", 1.5, { is_team_flash: true }), blind(10, 7, "b", 1.5, { is_team_flash: true })],
      kills: [{ tick: t(11), killer: "b", victim: "c" }, { tick: t(12), killer: "b", victim: "d" }],
    });
    const f = derive(tables, CS2RB);
    const m = rollup([f], { player: "a" }).m;
    const flash = flashTool(rosterTables(tables), f, "a").flashes[0];
    const enemies = flash.blinded.filter((b) => !b.team && b.flashed);
    const mates = flash.blinded.filter((b) => b.team && b.flashed);
    expect([enemies.length, enemies.reduce((s, b) => s + b.secs, 0), mates.length, flash.kills.filter((k) => k.whileBlind).length]).toEqual([2, 4.5, 1, 2]);
    expect([m.enemiesFlashed, m.enemyBlindSecs, m.teamFlashed, m.flashKills]).toEqual([2, 4.5, 1, 2]);
    const pair = (x: string, y: string) => headToHead(rosterTables(tables), f).find((h) => [h.a, h.b].sort().join() === [x, y].sort().join());
    const ac = pair("a", "c")!;
    expect((ac.a === "a" ? ac.flashes[0] : ac.flashes[1]).count).toBe(1);
  });

  it("keeps two flashbangs that reuse an entity id apart in every layer", () => {
    // fails if blinds are merged by entity id rather than by detonation: a throws two flashbangs, both
    // entity 7, detonating at 10 s and 11 s, and each blinds c for 2 s. That is two blinds and 4 s in
    // the flash tool, the utility measures and head to head alike, not one 3 s window
    const tables = oneRoundTables({ players, grenade_events: [det(10, 7), det(11, 7)], blinds: [blind(10, 7, "c", 2), blind(11, 7, "c", 2)] });
    const f = derive(tables, CS2RB);
    const m = rollup([f], { player: "a" }).m;
    const tool = flashTool(rosterTables(tables), f, "a");
    expect(tool.flashes.map((x) => x.blinded.map((b) => [b.pi, b.secs]))).toEqual([[[pi.c, 2]], [[pi.c, 2]]]);
    expect([m.enemiesFlashed, m.enemyBlindSecs]).toEqual([2, 4]);
    const ac = headToHead(rosterTables(tables), f).find((h) => [h.a, h.b].sort().join() === "a,c")!;
    expect(ac.a === "a" ? ac.flashes[0] : ac.flashes[1]).toEqual({ count: 2, secs: 4 });
  });

  it("joins only exact duplicate blind rows when no detonation links them", () => {
    // fails if blind rows with no detonation to link to are merged because they overlap: a's blinds on
    // c at 10 s and 10.5 s may be two flashbangs, while a row repeated exactly is one blind
    const tables = oneRoundTables({ players, blinds: [blind(10, 7, "c", 2), blind(10.5, 7, "c", 2), blind(20, 8, "d", 2), blind(20, 8, "d", 2)] });
    const m = rollup([derive(tables, CS2RB)], { player: "a" }).m;
    expect([m.enemiesFlashed, m.enemyBlindSecs]).toEqual([3, 6]);
  });

  it("notes a blind with neither an attacker nor a matching detonation instead of dropping it silently", () => {
    // fails if a blind that may be a's but names no attacker and no known detonation disappears unnoted
    const r = tool({ grenade_events: [det(10, 7)], blinds: [blind(20, 99, "c", 2, { attacker_steamid: null }), blind(21, null, "d", 2, { attacker_steamid: null })] });
    expect(r.notes).toEqual(["2 blinds have neither a recorded attacker nor a matching detonation in this file, so they are left out."]);
  });

  it("refuses a player who is not in the match", () => {
    expect(() => tool({}, "zz")).toThrow(/not among the match's players/);
  });
});
