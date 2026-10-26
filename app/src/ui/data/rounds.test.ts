import { describe, expect, it } from "vitest";
import type { KillFact, MatchFacts } from "../../stats/facts";
import { pooledRates } from "./engine";
import { clutchesOf, decidingRounds, feedFor, roundCells } from "./rounds";

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
  it("reads a world death's swing for both teams, from the victim's loss", () => {
    // player 0 falls to the world: no killer, no enemy credited; the opponents still gain what 0's team lost
    const world = { ...facts, kills: [{ ...kill(640, 2, 0, [[0, -0.1]]), killer: null, killerSide: null, enemy: false }] } as unknown as MatchFacts;
    expect(feedFor(world, 0, 2)[0].swing).toBeCloseTo(0.1);
    expect(feedFor(world, 0, 0)[0].swing).toBeCloseTo(-0.1);
  });
  it("finds a clutch that starts the round, before any kill", () => {
    // team 0 starts with player 1 alone (player 0 disconnected before freeze end, so no player-round row)
    const alone = { ...facts, pr: (facts.pr as { pi: number }[]).filter((r) => r.pi !== 0), kills: [kill(960, 1, 2, [[1, 0.25], [2, -0.25]])] } as unknown as MatchFacts;
    expect(clutchesOf(alone)[0]).toMatchObject({ pi: 1, side: "T", against: 2, killsAfter: 1 });
  });
});

describe("match overview helpers", () => {
  it("ranks deciding rounds on the chosen side only", () => {
    const rounds = [{ usSide: "T" as const, sw: 0.4 }, { usSide: "CT" as const, sw: -0.3 }, { usSide: "CT" as const, sw: 0.1 }];
    expect(decidingRounds(rounds, (r) => r.sw, "ct", 5).map((x) => x.sw)).toEqual([-0.3, 0.1]);
    expect(decidingRounds(rounds, (r) => r.sw, "both", 1).map((x) => x.sw)).toEqual([0.4]);
  });
  it("pools a team's rates from summed measures, not the mean of player rates", () => {
    const r = pooledRates([{ rounds: 10, dmg: 1000, kast: 8, kills: 10, hsKills: 5, swing: 0.2, swingRounds: 10 }, { rounds: 2, dmg: 0, kast: 0, kills: 0, hsKills: 0, swing: 0, swingRounds: 2 }] as never);
    expect(r.adr).toBeCloseTo(1000 / 12);
    expect(r.kast).toBeCloseTo((100 * 8) / 12);
    expect(r.hs).toBeCloseTo(50);
    expect(r.swing).toBeCloseTo(0.2 / 12);
  });
});
