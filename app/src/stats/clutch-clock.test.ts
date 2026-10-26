// A clutch's save, start and time left (closing.ts), on hand-built rounds: CT a and b against T c
// and d unless a test says otherwise. Round 1 freezes until FREEZE_END and ends at ROUND_END (110 s
// later) at 64 ticks a second.
import { describe, expect, it } from "vitest";
import { FREEZE_END, ROUND_END, oneRound, type OneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;
const CT2_T2 = { a: "CT", b: "CT", c: "T", d: "T" } as const;
const clutches = (m: OneRound) => oneRound(m).clutches.map(({ pi, opponents, won, saved, kills, t: start, afterPlant, left }) => ({ pi, opponents, won, saved, kills, start, afterPlant, left: left === null ? null : Math.round(left * 1000) / 1000 }));
// left is rounded to the millisecond: 1.92 minutes is not exact in binary

describe("clutch saves", () => {
  it("marks a lost clutch the player survived as saved, and the won one as not", () => {
    // fails if a save is read as any lost clutch, or a won clutch counts as a save. c kills a: b is in a
    // 1v2 and kills c, which leaves d alone in a 1v1. T wins on time with b and d alive
    const rows = clutches({
      players: CT2_T2, roundRow: { winner_side: "T" },
      kills: [{ tick: t(10), killer: "c", victim: "a" }, { tick: t(20), killer: "b", victim: "c" }],
    });
    expect(rows.map((r) => [r.pi, r.opponents, r.won, r.saved, r.kills])).toEqual([[1, 2, false, true, 1], [3, 1, true, false, 0]]);
  });

  it("does not mark a clutch lost by dying as saved, but does when the death came after the round ended", () => {
    // fails if the save ignores the death, or counts a post-round death as dying in the round (closing.ts saves rule)
    const round = (deathTick: number) => clutches({
      players: CT2_T2, roundRow: { winner_side: "T" },
      kills: [{ tick: t(10), killer: "c", victim: "a" }, { tick: deathTick, killer: "d", victim: "b" }],
    })[0];
    expect([round(t(30)).saved, round(ROUND_END + 64).saved]).toEqual([false, true]);
  });
});

describe("clutch time left", () => {
  it("reads the round timer from the match's convars, from the death that left the player alone", () => {
    // fails if the start is not the death's time, or the timer ignores mp_roundtime_defuse (1.92 minutes = 115.2 s)
    const rows = clutches({
      players: CT2_T2, roundRow: { winner_side: "T" }, convars: { mp_roundtime_defuse: "1.92", mp_roundtime: "1.5" },
      kills: [{ tick: t(10), killer: "c", victim: "a" }, { tick: t(20), killer: "b", victim: "c" }],
    });
    expect(rows.map((r) => [r.start, r.afterPlant, r.left])).toEqual([[10, false, 105.2], [20, false, 95.2]]);
  });

  it("takes the round timer from a round of the match that ran out of time when no convar records it", () => {
    // fails if the timer is guessed with no convar, or not read from the timed-out round (FREEZE_END to ROUND_END, 110 s)
    const m = (reason: string | null) => clutches({ players: CT2_T2, roundRow: { winner_side: "T", reason }, kills: [{ tick: t(10), killer: "c", victim: "a" }] })[0].left;
    expect([m("time_ran_out"), m("ct_killed"), m(null)]).toEqual([100, null, null]);
  });

  it("reads the bomb timer after a plant, from the match's own explosion", () => {
    // fails if a post-plant clutch reads the round timer, or the bomb timer is a default rather than the
    // plant-to-explosion time (41 s here): the clutch begins 5 s after the plant, so 36 s are left
    const plant = t(30);
    const rows = clutches({
      players: CT2_T2, convars: { mp_roundtime_defuse: "1.92" },
      roundRow: { winner_side: "T", reason: "bomb_exploded", plant_tick: plant, explode_tick: plant + 64 * 41 },
      kills: [{ tick: plant + 64 * 5, killer: "c", victim: "a" }],
    });
    expect(rows.map((r) => [r.start, r.afterPlant, r.left])).toEqual([[35, true, 36]]);
  });

  it("has no bomb time left after a plant when no bomb in the match exploded", () => {
    // fails if the bomb timer falls back to a game default
    const plant = t(30);
    const rows = clutches({
      players: CT2_T2, convars: { mp_roundtime_defuse: "1.92" }, roundRow: { winner_side: "CT", reason: "bomb_defused", plant_tick: plant },
      kills: [{ tick: plant + 64 * 5, killer: "c", victim: "a" }],
    });
    expect(rows.map((r) => [r.afterPlant, r.left])).toEqual([[true, null]]);
  });

  it("starts a clutch at freeze end for a side that starts the round with one player", () => {
    // fails if a clutch from the round start gets no start time, or is timed from its first kill. After
    // a kills c, d is alone too: a 1v1 from 1 s, with 89 s left
    const rows = clutches({
      players: { a: "CT", c: "T", d: "T" }, convars: { mp_roundtime: "1.5" },
      kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "d" }],
    });
    expect(rows.map((r) => [r.opponents, r.won, r.start, r.left])).toEqual([[2, true, 0, 90], [1, false, 1, 89]]);
  });
});
