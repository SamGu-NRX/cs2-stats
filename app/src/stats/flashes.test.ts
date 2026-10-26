// The flash tool's attribution (flashes.ts flashTool), on hand-built rounds: CT a and b against T c,
// d and e. a throws the flashes; b gets the kills.
import { describe, expect, it } from "vitest";
import { derive } from "./derive";
import { NO_GRENADE_EVENTS, flashTool } from "./flashes";
import { CS2RB } from "./model-params";
import { FREEZE_END, oneRoundTables, type OneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;
const players = { a: "CT", b: "CT", c: "T", d: "T", e: "T" } as const;
const tool = (m: Omit<OneRound, "players">, who = "a") => {
  const tables = oneRoundTables({ players, ...m });
  return flashTool(tables, derive(tables, CS2RB), who);
};
const pi = { a: 0, b: 1, c: 2, d: 3, e: 4 };
const det = (s: number, entity: number, by = "a", at: [number, number] | null = [100, 200]) => ({ tick: t(s), event: "flash_detonate", entity_id: entity, steamid: by, x: at?.[0] ?? null, y: at?.[1] ?? null });
const blind = (s: number, entity: number | null, victim: string, secs: number, more: Record<string, unknown> = {}) => ({ tick: t(s), attacker_steamid: "a", victim_steamid: victim, duration: secs, flash_entity_id: entity, ...more });

describe("flashTool", () => {
  it("places each flash and lists whom it blinded, enemies first and longest first, without the thrower", () => {
    // fails if the thrower's own blind is listed, a teammate sorts among the enemies, the 1.1 s cut is
    // not marked, or another player's detonation is taken for a's. c stood at (500, 600) when blinded
    const r = tool({
      grenade_events: [det(10, 7), det(20, 8, "b")],
      blinds: [blind(10, 7, "d", 0.8), blind(10, 7, "b", 1.5, { is_team_flash: true }), blind(10, 7, "c", 2.5), blind(10, 7, "a", 1, { is_self: true })],
      positions: [{ tick: t(10), steamid: "c", x: 500, y: 600 }],
    });
    expect(r.notes).toEqual([]);
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

  it("names what the file lacks: detonation points, and blinds with no detonation", () => {
    // fails if a flash without a position is dropped or placed, or an unlinked blind is attributed by guess
    const r = tool({
      grenade_events: [det(10, 7), det(30, 9, "a", null)],
      blinds: [blind(30, 9, "e", 2), blind(50, null, "e", 2), blind(60, 99, "c", 2)],
    });
    expect(r.flashes.map((f) => [f.at, f.blinded.length])).toEqual([[[100, 200], 0], [null, 1]]);
    expect(r.notes).toEqual([
      "1 of 2 flashes have no detonation point in this file, so they are not on the map.",
      "2 blinds name no detonation in this file, so they are left out.",
    ]);
  });

  it("says the file records no grenade events rather than reporting no flashes", () => {
    // fails if a file without any grenade or flash rows reads as a player who threw nothing
    expect(tool({})).toEqual({ flashes: [], notes: [NO_GRENADE_EVENTS] });
    expect(tool({ grenade_events: [det(20, 8, "b")] })).toEqual({ flashes: [], notes: [] });
  });

  it("refuses a player who is not in the match", () => {
    expect(() => tool({}, "zz")).toThrow(/not among the match's players/);
  });
});
