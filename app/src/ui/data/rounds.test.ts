import { describe, expect, it } from "vitest";
import type { KillFact, MatchFacts } from "../../stats/facts";
import { clutchesOf, feedFor, roundCells } from "./rounds";

// One round, 2v2: players 0 and 1 are team 0 on T, players 2 and 3 are team 1 on CT.
// 2 kills 0 (opening), leaving player 1 alone against two; 1 kills 2 (now player 3 is alone too), then 1 kills 3.
const kill = (tick: number, killer: number, victim: number, credits: [number, number][], opening = false): KillFact => ({
  ri: 0, tick, t: tick / 64, killer, victim, assister: null, flashAssist: false,
  killerSide: killer < 2 ? "T" : "CT", victimSide: victim < 2 ? "T" : "CT", weapon: "ak47", victimWeapon: null,
  headshot: false, wallbang: false, smoke: false, noscope: false, killerBlind: false, killerInAir: false, kpos: null, vpos: null, enemy: true, opening,
  tradeKill: false, traded: false, ecoPoints: null, credits,
});
const facts = {
  players: [0, 1, 2, 3].map((pi) => ({ id: `p${pi}`, name: `p${pi}`, team: pi < 2 ? 0 : 1, bot: true })),
  rounds: [{ ri: 0, number: 1, winner: "T" }],
  pr: [0, 1, 2, 3].map((pi) => ({ ri: 0, pi, side: pi < 2 ? "T" : "CT", team: pi < 2 ? 0 : 1, m: { kills: pi === 1 ? 2 : pi === 2 ? 1 : 0, deaths: pi === 1 ? 0 : 1 } })),
  kills: [kill(640, 2, 0, [[2, 0.2], [0, -0.2]], true), kill(960, 1, 2, [[1, 0.25], [2, -0.25]]), kill(1280, 1, 3, [[1, 0.55], [3, -0.55]])],
} as unknown as MatchFacts;

describe("round views", () => {
  it("reads an enemy's kill as negative swing for the viewer's team", () => {
    const feed = feedFor(facts, 0, 0);
    expect(feed[0].swing).toBeCloseTo(-0.2);
    expect(feed[1].swing).toBeCloseTo(0.25);
  });
  it("marks both sides of the opening duel", () => {
    const cells = roundCells(facts);
    expect(cells[2][0]!.opening).toBe("k");
    expect(cells[0][0]!.opening).toBe("d");
    expect(cells[1][0]).toMatchObject({ kills: 2, died: false, swing: 0.8 });
  });
  it("finds each clutch once, from the moment a player is alone, with the kills that followed", () => {
    expect(clutchesOf(facts)).toEqual([
      { ri: 0, pi: 1, side: "T", against: 2, won: true, killsAfter: 2 },
      { ri: 0, pi: 3, side: "CT", against: 1, won: false, killsAfter: 0 },
    ]);
  });
});
