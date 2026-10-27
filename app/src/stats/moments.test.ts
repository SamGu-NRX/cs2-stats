// Moment scoring (moments.ts) on hand-built rounds: CT a and b against T c, d and e, round 5, every
// player with 4000 of equipment so the round is valued, unless a test says otherwise.
import { describe, expect, it } from "vitest";
import type { SightFact } from "./aim";
import { bestMomentFirst, momentReason, POINTS, POST_ROLL_S, PRE_ROLL_S, scoreMoments, type Moment } from "./moments";
import { FREEZE_END, oneRound, ROUND_END, type OneRound } from "./testing/match";

const RATE = 64;
const t = (s: number) => FREEZE_END + s * RATE;
const equip = { equip_value_game: 4000 };
const five: OneRound["players"] = { a: "CT", b: "CT", c: "T", d: "T", e: "T" };
const round = (m: Partial<OneRound>) => oneRound({ round: 5, players: five, player_rounds: Object.fromEntries(Object.keys(m.players ?? five).map((id) => [id, equip])), ...m });

describe("scoreMoments", () => {
  it("clips a 3K from five seconds before the first kill to three after the last, at the kills' place", () => {
    // fails if the pre-roll or post-roll moves, the 3K is missed, the place is not the most common one, or the opening kill is lost
    const f = round({
      kills: [
        { tick: t(10), killer: "a", victim: "c", at: { a_place: "BombsiteB" } },
        { tick: t(12), killer: "a", victim: "d", at: { a_place: "Middle" } },
        { tick: t(20), killer: "a", victim: "e", at: { a_place: "BombsiteB" } },
      ],
    });
    const [m, ...more] = scoreMoments(f, { player: "a" });
    expect(more).toEqual([]);
    expect([m.round, m.side, m.player, m.kinds, m.place]).toEqual([5, "CT", "a", ["3k", "swing", "opening"], "BombsiteB"]);
    expect([m.startTick, m.endTick]).toEqual([t(10) - PRE_ROLL_S * RATE, t(20) + POST_ROLL_S * RATE]);
    // the three kills took CT from the start's win probability to a won round; no damage rows, so a gets all of each kill
    const path = f.rounds[0].winProb!;
    expect(m.swing).toBeCloseTo(path[0].pT - path[3].pT, 12);
    expect(m.reason).toBe(`3K on B Site, opening kill, +${Math.round(m.swing! * 100)}% round impact`);
    expect(m.score).toBeCloseTo(POINTS.k3 + POINTS.opening + POINTS.swingPerUnit * m.swing!, 2);
  });

  it("clips a won clutch from its start to the round's end", () => {
    // fails if the clutch window starts at b's first kill instead of a's death, stops before the round
    // ends or runs past it into the next round, or the clutch is not a kind. c kills a at 1 s: b is
    // alone against c, d and e and kills all three.
    const f = round({
      kills: [
        { tick: t(1), killer: "c", victim: "a" },
        { tick: t(30), killer: "b", victim: "c" },
        { tick: t(32), killer: "b", victim: "d" },
        { tick: t(40), killer: "b", victim: "e" },
      ],
    });
    const [m] = scoreMoments(f, { player: "b" });
    expect([m.kinds, m.clutch]).toEqual([["3k", "clutch", "swing"], { opponents: 3 }]);
    expect([m.startTick, m.endTick]).toEqual([FREEZE_END, ROUND_END]);
    expect(m.reason.startsWith("3K, 1v3 clutch, +")).toBe(true);
  });

  it("keeps the post-roll inside the round, and a kill after the round's end in the clip", () => {
    // fails if the clip runs past the round's end into the next round, or cuts off a kill made in the
    // round-end delay. a kills c one second before the round ends; in the second round a's third kill
    // of a 3K comes 2 s after it.
    const near = round({ kills: [{ tick: ROUND_END - RATE, killer: "a", victim: "c" }] });
    expect(scoreMoments(near, { player: "a" }).map((m) => m.endTick)).toEqual([ROUND_END]);
    const after = round({ kills: [{ tick: t(10), killer: "a", victim: "c" }, { tick: t(20), killer: "a", victim: "d" }, { tick: ROUND_END + 2 * RATE, killer: "a", victim: "e" }] });
    expect(scoreMoments(after, { player: "a" }).map((m) => [m.kinds[0], m.endTick])).toEqual([["3k", ROUND_END + 2 * RATE]]);
  });

  it("starts no clip before freeze end", () => {
    // fails if the pre-roll reaches into the buy period: the kill is 2 s after freeze end
    const f = round({ kills: [{ tick: t(2), killer: "a", victim: "c" }] });
    expect(scoreMoments(f, { player: "a" }).map((m) => [m.startTick, m.endTick])).toEqual([[FREEZE_END, t(2) + POST_ROLL_S * RATE]]);
  });

  it("leaves out a kill that is none of the kinds, and a lost clutch", () => {
    // fails if any kill is a moment: b's kill on e is not the opening, and it moved CT's win probability by
    // less than HIGH_SWING (the round was already won). In the second round b loses his 1v1.
    const f = round({ kills: [{ tick: t(5), killer: "a", victim: "c" }, { tick: t(6), killer: "a", victim: "d" }, { tick: t(9), killer: "b", victim: "e" }] });
    expect(scoreMoments(f, { player: "b" })).toEqual([]);
    const lost = oneRound({ players: { a: "CT", b: "CT", c: "T" }, roundRow: { winner_side: "T" }, kills: [{ tick: t(1), killer: "c", victim: "a" }, { tick: t(2), killer: "c", victim: "b" }] });
    expect(scoreMoments(lost, { player: "b" })).toEqual([]);
  });

  it("keeps the swing kind and value out of a round with no win probability", () => {
    // fails if an unvalued round claims a swing: without equipment the lookup has no state, so only the opening kill counts
    const f = oneRound({ round: 5, players: five, kills: [{ tick: t(5), killer: "a", victim: "c" }] });
    expect(scoreMoments(f, { player: "a" }).map((m) => [m.kinds, m.swing, m.reason, m.score])).toEqual([[["opening"], null, "Opening kill", POINTS.opening]]);
  });

  it("marks a kill a flick when its sighting turned far and fast enough", () => {
    // fails if the flick rule ignores the turn, the time to kill, or which kill the sighting ended in.
    // No equipment, so no swing: a's kill on d (b made the opening kill) is a moment only as a flick.
    const f = oneRound({ round: 5, players: five, kills: [{ tick: t(5), killer: "b", victim: "c" }, { tick: t(8), killer: "a", victim: "d" }] });
    const sight = (moved: number, ttk: number, killTick: number | null): SightFact => ({
      k: "sight", ri: 0, pi: f.players.findIndex((p) => p.id === "a"), weapon: "ak47", place: 40, ttd: ttk, ttk, killTick, moved, react: 0.1, shot: 0.2,
      over: null, micro: null, trackN: 0, trackSum: 0, dist: 500, travel: null, shotSpeed: null, shotErr: null, stopBuf: null, first: null, duelS: null, duelWon: null, xf: null,
    });
    const kinds = (s: SightFact) => scoreMoments({ ...f, aim: [s] }, { player: "a" }).map((m) => [m.kinds, m.flicks]);
    expect(kinds(sight(45, 0.3, t(8)))).toEqual([[["flick"], 1]]);
    expect(kinds(sight(10, 0.3, t(8)))).toEqual([]);
    expect(kinds(sight(45, 2, t(8)))).toEqual([]);
    expect(kinds(sight(45, 0.3, t(9)))).toEqual([]);
  });

  it("keeps only the rounds the filter keeps", () => {
    // fails if the side filter is ignored: a's 3K is on CT
    const f = round({ kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "d" }, { tick: t(3), killer: "a", victim: "e" }] });
    expect(scoreMoments(f, { player: "a", sides: ["T"] })).toEqual([]);
    expect(scoreMoments(f, { player: "a", sides: ["CT"] })).toHaveLength(1);
  });

  it("refuses a match without a tick rate", () => {
    const f = round({ kills: [] });
    expect(() => scoreMoments({ ...f, match: { ...f.match, tickRate: 0 } }, { player: "a" })).toThrow(/no tick rate/);
  });
});

describe("momentReason", () => {
  const base: Pick<Moment, "kinds" | "clutch" | "place" | "swing" | "flicks"> = { kinds: [], clutch: null, place: null, swing: null, flicks: 0 };
  it("leads with the multi-kill, then the clutch, then the kind, and says where and how much", () => {
    // fails if a headline, a callout name, the order of the parts or the swing's rounding changes
    expect(momentReason({ ...base, kinds: ["3k", "swing"], place: "BombsiteB", swing: 0.384 })).toBe("3K on B Site, +38% round impact");
    expect(momentReason({ ...base, kinds: ["ace", "clutch", "flick"], clutch: { opponents: 4 }, place: "Middle", swing: 0.9, flicks: 2 })).toBe("Ace on Mid, 1v4 clutch, 2 flicks, +90% round impact");
    expect(momentReason({ ...base, kinds: ["clutch"], clutch: { opponents: 2 }, swing: 0.51 })).toBe("1v2 clutch, +51% round impact");
    expect(momentReason({ ...base, kinds: ["flick", "opening"], place: "Catwalk", flicks: 1 })).toBe("Flick kill on Catwalk, opening kill");
    expect(momentReason({ ...base, kinds: ["swing"], swing: 0.2 })).toBe("High-swing kill, +20% round impact");
    expect(momentReason({ ...base, kinds: ["opening"], swing: -0.04 })).toBe("Opening kill, −4% round impact");
  });
});

it("orders moments by score, then swing, then the earlier round", () => {
  // fails if the order ignores the score, puts the smaller swing first on a tie, or reverses rounds
  const m = (score: number, swing: number | null, round: number) => ({ score, swing, round });
  const sorted = [m(3, 0.1, 9), m(5, null, 4), m(3, 0.3, 2), m(3, 0.1, 1)].sort(bestMomentFirst);
  expect(sorted.map((x) => `${x.score}/${x.swing}/${x.round}`)).toEqual(["5/null/4", "3/0.3/2", "3/0.1/1", "3/0.1/9"]);
});
