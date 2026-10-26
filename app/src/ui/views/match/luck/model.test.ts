// The Luck tab's rules on hand-built rounds: the luck score in words, which inputs a source lacks, which
// kills a round's count names, and the order, tallies, round values and lobby ranking the tab draws.
import { describe, expect, it } from "vitest";
import { emptyMeasures, type KillFact, type Measures, type PlayerRound } from "../../../../stats/facts";
import { LUCK_METRICS } from "../../../../stats/luck";
import type { MatchModel, MRound } from "../../../data/match";
import {
  flagsOf, fmtLuck, inputOf, lobbyLuck, LUCK_GROUPS, LUCK_INPUTS, luckHeadline, luckMoments, luckSentence, missingInputs, missingLine,
  roundLuck, tally,
} from "./model";

const ME = 0, MATE = 1, FOE = 2, FOE2 = 3;

function kill(ri: number, killer: number | null, victim: number, over: Partial<KillFact> = {}): KillFact {
  return {
    ri, tick: 1000 + victim, t: 10, killer, victim, assister: null, flashAssist: false, killerSide: "T", victimSide: "CT", weapon: "ak47", victimWeapon: "m4a1",
    headshot: false, wallbang: false, smoke: false, noscope: false, killerBlind: false, killerInAir: false, kpos: null, vpos: null,
    enemy: true, opening: false, tradeKill: false, traded: false, ecoPoints: null, credits: [], ...over,
  };
}

/** The luck model reads a round row's measures only, so the rest of the row is left out. */
const row = (ri: number, pi: number, m: Partial<Measures>) => ({ ri, pi, m }) as Partial<PlayerRound> as PlayerRound;

interface R { kills?: KillFact[]; me?: Partial<Measures> | null; winner?: "us" | "them" | null; halfStart?: boolean }

/**
 * A match model holding what the luck model reads: players, rounds (number, winner, kills, rows) and
 * the per-player lines. Everything else a MatchModel carries is left out.
 */
function model(rounds: R[], lines: Record<number, Record<string, number | null>> = {}): MatchModel {
  const players = [ME, MATE, FOE, FOE2].map((pi) => ({ pi, key: `p${pi}`, name: `P${pi}`, bot: false, team: pi < 2 ? "us" : "them", isHuman: pi === ME }));
  const rs = rounds.map((r, ri) => ({
    ri, number: ri + 1, winner: r.winner === undefined ? "us" : r.winner, halfStart: r.halfStart ?? false, kills: r.kills ?? [],
    pr: players.map((p) => (p.pi === ME && r.me !== null ? row(ri, ME, r.me ?? {}) : null)),
  })) as Partial<MRound>[] as MRound[];
  const both = players.map((p) => ({ v: lines[p.pi] ?? {} }));
  return { human: ME, players, rounds: rs, b: { lines: { both } } } as unknown as MatchModel;
}

describe("the luck score in words", () => {
  it("reads even inside half a hit, firm from three, and the sign otherwise", () => {
    // fails if a band edge moves or flips: 0.5 and 3 belong to the stronger phrase
    expect([0, 0.49, -0.49, 0.5, 2.99, 3, -0.5, -3].map(luckHeadline)).toEqual([
      "The dice were even", "The dice were even", "The dice were even", "The dice were on your side", "The dice were on your side",
      "The dice were firmly on your side", "The dice were against you", "The dice were firmly against you",
    ]);
  });

  it("has no words without a score", () => {
    expect(luckHeadline(null)).toBeNull();
    expect(luckHeadline(Number.NaN)).toBeNull();
    expect(luckSentence(null)).toBeNull();
  });

  it("formats one decimal with a true minus, and no sign on a zero", () => {
    expect([1.44, -0.6, 0.04, -0.04, null].map(fmtLuck)).toEqual(["+1.4", "−0.6", "0.0", "0.0", "–"]);
    expect(luckSentence(1.44)).toBe("The dice were on your side: +1.4 hits per 24 rounds");
  });
});

describe("what the source recorded", () => {
  const m = (over: Partial<Measures>): Measures => ({ ...emptyMeasures(), ...over });

  it("names an input missing only when events exist and none has it", () => {
    // fails if a partly recorded input (2 of 5) or one with no events (no gun deaths) counts as missing
    expect(missingInputs(m({ rounds: 20, spreadRounds: 0, gunKills: 5, rgKnown: 2, gunDeaths: 3, rgDeathsKnown: 0, kills: 5, flagsKnown: 5 }))).toEqual(["spread", "deathShot"]);
    expect(missingInputs(m({ rounds: 20, spreadRounds: 20 }))).toEqual([]);
  });

  it("says why in one line, with the engine's words for the input", () => {
    expect(missingLine("killShot")).toBe("Run-and-gun kills: needs the killing shot's speed, which this file does not record.");
    expect(missingLine("spread")).toBe("Luck score: needs shot spread and line of sight, which this file does not record.");
  });

  it("lists every luck metric once, each under the input it needs", () => {
    // fails if the engine adds a luck metric the tab does not show, or one shows twice
    const ids = LUCK_GROUPS.flatMap((g) => g.rows.map((r) => r.id));
    expect([...ids].sort()).toEqual(LUCK_METRICS.map((x) => x.id).sort());
    for (const g of LUCK_GROUPS) for (const r of g.rows) {
      const need = inputOf(r.id);
      expect(need === null ? [] : [need], r.id).toEqual(g.inputs.filter((i) => LUCK_INPUTS.find((x) => x.input === i)!.metrics.includes(r.id)));
    }
  });

  it("gives each row the sample its metric divides", () => {
    const x = m({ rgKills: 2, rgKnown: 11, rounds: 24, closeCalls: 0, lowHpKills: 1, lowHpDeaths: 2, spreadRounds: 1, luckShots: 62 });
    const sample = (id: string) => LUCK_GROUPS.flatMap((g) => g.rows).find((r) => r.id === id)!;
    expect(["runAndGunKills", "closeCalls", "lowHpKills", "lowHpDeaths", "luckScore", "luckHits"].map((id) => sample(id).sample(x)))
      .toEqual(["2 of 11", "0 of 24 rounds", "1 kill", "2 deaths", "1 round", "62 shots"]);
    expect(sample("runAndGunKills").n!(x)).toBe(11);
  });
});

describe("lucky moments", () => {
  it("gives each flag kill its own row with its set flags; an unrecorded flag is not set", () => {
    // fails if killerBlind null reads as set, a kill without flags gets a row, or flags come out of order
    const ks = [
      kill(0, ME, FOE, { noscope: true, smoke: true, killerInAir: true }),
      kill(0, ME, FOE2, { killerBlind: null, killerInAir: null }),
    ];
    const ms = luckMoments(model([{ kills: ks, me: {} }]));
    expect(ms.map((x) => [x.kind, x.flags, x.kills.map((k) => k.victim)])).toEqual([["flag", ["noscope", "smoke", "inair"], [FOE]]]);
    expect(flagsOf({ noscope: false, smoke: false, killerBlind: true, killerInAir: null })).toEqual(["blind"]);
  });

  it("names run-and-gun kills only when the count covers every gun kill of the round", () => {
    // fails if a knife kill counts as a gun kill, or one of two gun kills is guessed
    const ks = [kill(0, ME, FOE), kill(0, ME, FOE2, { weapon: "knife" })];
    const named = luckMoments(model([{ kills: ks, me: { rgKills: 1 } }]));
    expect(named.map((x) => [x.kind, x.count, x.kills.map((k) => k.victim)])).toEqual([["runGun", 1, [FOE]]]);
    const two = [kill(0, ME, FOE), kill(0, ME, FOE2)];
    const unnamed = luckMoments(model([{ kills: two, me: { rgKills: 1 } }]));
    expect(unnamed.map((x) => [x.kind, x.count, x.kills.length])).toEqual([["runGun", 1, 0]]);
  });

  it("names lucky headshots among the gun headshots, and low-health kills among all enemy kills", () => {
    const ks = [kill(0, ME, FOE, { headshot: true }), kill(0, ME, FOE2), kill(0, ME, MATE, { enemy: false })];
    const ms = luckMoments(model([{ kills: ks, me: { lhKills: 1, lowHpKills: 2 } }]));
    expect(ms.map((x) => [x.kind, x.kills.map((k) => k.victim)])).toEqual([["luckyHs", [FOE]], ["lowHp", [FOE, FOE2]]]);
  });

  it("names your killer for the enemies' luck on you, but never a teammate who killed you", () => {
    const enemy = luckMoments(model([{ kills: [kill(0, FOE, ME, { smoke: true })], me: { rgDeaths: 1, lowHpDeaths: 1 } }]));
    expect(enemy.map((x) => [x.kind, x.against, x.kills.map((k) => k.killer)])).toEqual([["flag", true, [FOE]], ["runGun", true, [FOE]], ["lowHp", true, [FOE]]]);
    const team = luckMoments(model([{ kills: [kill(0, MATE, ME, { smoke: true, enemy: false })], me: {} }]));
    expect(team).toEqual([]);
  });

  it("counts a close call with no kill, and nothing for a round you have no row in", () => {
    const ms = luckMoments(model([{ me: { closeCalls: 1 } }, { me: null, kills: [] }]));
    expect(ms.map((x) => [x.round, x.kind, x.count, x.kills.length])).toEqual([[1, "closeCall", 1, 0]]);
  });

  it("orders by round, yours before the enemies', then flag, running, headshot, low health, close call", () => {
    const r1: R = { kills: [kill(0, ME, FOE, { smoke: true }), kill(0, FOE2, ME, { noscope: true })], me: { closeCalls: 0, lowHpKills: 1, rgKills: 1, rgDeaths: 1 } };
    const r2: R = { me: { closeCalls: 1 }, winner: null };
    const ms = luckMoments(model([r1, r2, { me: {} }]));
    expect(ms.map((x) => `${x.round}:${x.against ? "them" : "you"}:${x.kind}`)).toEqual([
      "1:you:flag", "1:you:runGun", "1:you:lowHp", "1:them:flag", "1:them:runGun", "2:you:closeCall",
    ]);
    expect(ms.map((x) => x.won)).toEqual([true, true, true, true, true, null]);
  });

  it("tallies events, not rows", () => {
    const ms = luckMoments(model([{ kills: [kill(0, ME, FOE), kill(0, ME, FOE2)], me: { rgKills: 2, closeCalls: 1 } }]));
    expect(tally(ms)).toEqual({ flag: 0, runGun: 2, luckyHs: 0, lowHp: 0, closeCall: 1 });
  });
});

describe("round by round and the lobby", () => {
  it("gives each round your lucky hits less the enemies' on you, null where spread was not measured", () => {
    // fails if a measure left out of the row (0) poisons the sum, or an unmeasured round reads as 0
    const v = model([
      { me: { spreadRounds: 1, luckHits: 3, luckExp: 1.5, luckAgHits: 1, luckAgExp: 0.25 }, halfStart: false },
      { me: { spreadRounds: 1, luckExp: 0.5 }, winner: "them", halfStart: true },
      { me: { luckHits: 2 } },
      { me: null },
    ]);
    expect(roundLuck(v).map((r) => [r.round, r.value, r.won, r.halfStart])).toEqual([[1, 0.75, true, false], [2, -0.5, false, true], [3, null, true, false], [4, null, true, false]]);
  });

  it("ranks every scored player luckiest first, ties in player order", () => {
    const v = model([], { [ME]: { luckScore: 1 }, [MATE]: { luckScore: null }, [FOE]: { luckScore: 2.5 }, [FOE2]: { luckScore: 1 } });
    expect(lobbyLuck(v).map((r) => [r.pi, r.score, r.you, r.team])).toEqual([[FOE, 2.5, false, "them"], [ME, 1, true, "us"], [FOE2, 1, false, "them"]]);
  });
});
