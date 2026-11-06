// Round winners rebuilt from the scores (results.ts), on synthetic two-player files: the human (pi 0)
// and one opponent (pi 1), whose score is [T, CT] at the start of each round.
import { describe, expect, it } from "vitest";
import { checkResultRules, howFromEvidence, roundResults } from "./results";
import type { MatchFile, Side } from "./schema";

/**
 * A file whose human plays `sides[i]` in round i and wins the rounds `humanWins` marks. Every
 * winSide is null, as in a file whose results the plugin could not read.
 */
function file(humanWins: boolean[], sides: Side[], o: { maxrounds?: number; status?: MatchFile["status"] } = {}): MatchFile {
  const n = humanWins.length;
  const score: MatchFile["rounds"]["score"] = [];
  let us = 0, them = 0;
  for (let ri = 0; ri < n; ri++) {
    score.push(sides[ri] === 2 ? [us, them] : [them, us]);
    if (humanWins[ri]) us++; else them++;
  }
  const col = <T,>(v: T) => humanWins.map(() => v);
  const none = { ri: [], tick: [] };
  return {
    v: 1, id: "r", map: "de_test", startUtc: "2026-10-25T00:00:00Z", endUtc: "2026-10-25T01:00:00Z", status: o.status ?? "complete",
    env: { plugin: "1.1.0", cssharp: null, game: null, tickrate: 64, maxrounds: o.maxrounds ?? 4, botDifficulty: null },
    firstFullRound: 0, weapons: ["ak47"], places: [], human: 0,
    players: { key: ["76561190000000001", "B:bot"], name: ["me", "bot"], isBot: [false, true], startSide: [sides[0], sides[0] === 2 ? 3 : 2] },
    rounds: {
      winSide: col(null), how: col(null), freezeTick: humanWins.map((_, i) => 1000 + i * 5000), durTicks: col(4000),
      bombSite: col(null), plantTick: col(null), planter: col(null), defuser: col(null), ctSetup: col(null), score,
      side: sides.map((s): Side[] => [s, s === 2 ? 3 : 2]), equip: col([4000, 4000]), money: col([800, 800]),
    },
    kills: { ...none, killer: [], victim: [], assister: [], flashAssister: [], weapon: [], flags: [], kpos: [], vpos: [], state: [], kBody: [], vBody: [] },
    damage: { ...none, attacker: [], victim: [], dmg: [], dmgArmor: [], weapon: [], hitgroup: [] },
    blinds: { ...none, attacker: [], victim: [], ms: [] },
    grenades: { ...none, thrower: [], type: [], pos: [] },
    pos: { ...none, pi: [], x: [], y: [], z: [], place: [], alive: [] },
    aim: {
      engagements: { ri: [], enemy: [], tVis: [], angVis: [], angVisYaw: [], angVisPitch: [], dist: [], tAimStart: [], tFirstShot: [], tFirstDmg: [], tEnd: [], outcome: [] },
      shots: { ri: [], tick: [], weapon: [], burst: [], idx: [], speed: [], maxSpeed: [], scoped: [], ducked: [], target: [], aimErr: [], impact: [], hit: [] },
    },
  };
}

const winners = (humanWins: boolean[], sides: Side[]) => humanWins.map((w, i): Side => (w ? sides[i] : sides[i] === 2 ? 3 : 2));

// MR4 regulation (2 + 2) and two overtimes of one round per half: the human is CT, then T after the
// half, then T and CT in the first overtime, CT and T in the second.
const SIDES: Side[] = [3, 3, 2, 2, 2, 3, 3, 2];
const WINS = [true, false, false, true, true, false, true, true];

describe("round winners from the scores", () => {
  it("rebuilds every winner across the half-time swap and each overtime swap", () => {
    // fails if the score is read as [CT, T], or the score after a swap is compared without mapping
    // both rounds to the human's team (every swap round would then look like a two-point jump)
    const r = roundResults(file(WINS, SIDES));
    expect(r.winSide).toEqual(winners(WINS, SIDES));
    expect(r.recovered).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("rebuilds an unknown result in the middle of a match and keeps the known ones", () => {
    // fails if only overtime rounds are rebuilt, or a round the file holds is overwritten
    const m = file(WINS.slice(0, 4), SIDES.slice(0, 4));
    m.rounds.winSide = [3, null, 3, 2];
    m.rounds.how = ["elim", null, "elim", "elim"];
    const r = roundResults(m);
    expect([r.winSide, r.how[0], r.recovered]).toEqual([[3, 2, 3, 2], "elim", [1]]);
  });

  it("leaves a round null when the score does not move by exactly one", () => {
    // fails if a jump of two (a missing round in between) or no change is read as a win
    const m = file([true, true, true], [3, 3, 3]);
    m.rounds.score[1] = [0, 0];
    expect(roundResults(m).winSide.slice(0, 2)).toEqual([null, null]);
  });
});

describe("the final round of a finished match", () => {
  const last = (humanWins: boolean[], sides: Side[], o?: Parameters<typeof file>[2]) => roundResults(file(humanWins, sides, o)).winSide.at(-1);

  it("goes to the side that led before it once overtime has been played", () => {
    // fails if the rule is skipped for overtime, where a one-round lead is the usual final state:
    // 4-3 to the human before round 8 of an MR4 match
    expect(last(WINS, SIDES)).toBe(2);
    // the opponent leading 4-3 instead
    const lost = WINS.map((w, i) => (i >= 6 ? !w : w));
    expect(last(lost, SIDES)).toBe(3);
  });

  it("goes to the leader in regulation when the trailing side's win could not level the score", () => {
    // fails if a regulation lead of two is left unknown: 2-0 to the human before round 3 of MR6
    expect(last([true, true, true], [3, 3, 3], { maxrounds: 6 })).toBe(3);
  });

  it("stays null when the score was level, which only a draw or the round itself decides", () => {
    // fails if a level score picks a winner: 2-2 before the last round of MR5
    expect(last([true, false, true, false, true], [3, 3, 2, 2, 2], { maxrounds: 5 })).toBeNull();
  });

  it("stays null in regulation when the trailing side was one behind, since its win would end the match as a draw", () => {
    // fails if the leader is chosen at 2-1 before the last round of MR4, where a 2-2 draw also ends it
    expect(last([true, true, false, false], [3, 3, 2, 2], { maxrounds: 4 })).toBeNull();
  });

  it("stays null when the match did not finish", () => {
    // fails if an abandoned file's last round, which ended for no score reason, gets a winner
    expect(last(WINS, SIDES, { status: "abandoned" })).toBeNull();
  });
});

describe("how a rebuilt round ended", () => {
  it("counts a bot a human drove as dead when its body died, for an elimination", () => {
    // fails if deaths are read from kills.victim (the controller) rather than the body: the opponent
    // kills the human, then the bot whose body the human took over, inside the round
    const m = file([false], [3], { maxrounds: 4 });
    m.players = { key: ["76561190000000001", "B:mate", "B:enemy"], name: ["me", "mate", "enemy"], isBot: [false, true, true], startSide: [3, 3, 2] };
    m.rounds.side = [[3, 3, 2]];
    m.rounds.equip = [[4000, 4000, 4000]];
    m.rounds.money = [[800, 800, 800]];
    m.rounds.score = [[0, 0]];
    m.status = "abandoned";
    m.rounds.winSide = [2];
    m.kills = {
      ri: [0, 0], tick: [2000, 3000], killer: [2, 2], victim: [0, 0], assister: [null, null], flashAssister: [null, null], weapon: [0, 0],
      flags: [0, 0], kpos: [null, null], vpos: [null, null], state: [null, null], kBody: [null, null], vBody: [null, 1],
    };
    const check = checkResultRules({ ...m, rounds: { ...m.rounds, how: ["elim"] } });
    expect([check.howKnown, check.howAgree]).toEqual([1, 1]);
  });

  it("reads a T win with the last CT dying after the end tick as the bomb, once a position row shows that CT alive at the end", () => {
    // fails if a death from the bomb's blast, one tick after the round's end, counts as elimination, or
    // if the bomb is read without a sign that the CT was still standing
    const m = file([false], [3], { maxrounds: 4, status: "abandoned" });
    m.rounds.winSide = [2];
    m.rounds.plantTick = [2000];
    m.kills = kills([[5001, 0]]);
    const how = (x: MatchFile) => howFromEvidence(x, 0, 2);
    expect(how(m)).toBeNull();
    m.pos = alivePos([[0, 4950]]);
    expect(how(m)).toBe("bomb");
  });
});

/** Kills rows [tick, victim, flags] by no one, in round 0 (flags 128: during freeze time). */
function kills(rows: [tick: number, victim: number, flags?: number][]): MatchFile["kills"] {
  const z = <T,>(v: T) => rows.map(() => v);
  return {
    ri: z(0), tick: rows.map((r) => r[0]), killer: z(null), victim: rows.map((r) => r[1]), assister: z(null), flashAssister: z(null), weapon: z(0),
    flags: rows.map((r) => r[2] ?? 0), kpos: z(null), vpos: z(null), state: z(null), kBody: z(null), vBody: z(null),
  };
}

/** Position rows [pi, tick] of living players in round 0. */
function alivePos(rows: [number, number][]): MatchFile["pos"] {
  const z = <T,>(v: T) => rows.map(() => v);
  return { ri: z(0), tick: rows.map((r) => r[1]), pi: rows.map((r) => r[0]), x: z(0), y: z(0), z: z(0), place: z(null), alive: z(true) };
}

/** One CT win (round 0, ticks 1000 to 5000, no plant): the human and a mate are CT, two bots are T. */
function ctWin(): MatchFile {
  const m = file([true], [3], { maxrounds: 4, status: "abandoned" });
  m.players = { key: ["76561190000000001", "B:mate", "B:t1", "B:t2"], name: ["me", "mate", "t1", "t2"], isBot: [false, true, true, true], startSide: [3, 3, 2, 2] };
  m.rounds.side = [[3, 3, 2, 2]];
  m.rounds.equip = [[4000, 4000, 4000, 4000]];
  m.rounds.money = [[800, 800, 800, 800]];
  m.rounds.winSide = [3];
  return m;
}

describe("how a rebuilt round ended, when the file may lack a death", () => {
  const how = (m: MatchFile) => howFromEvidence(m, 0, 3);

  it("counts a T who disconnected as removed, so the last T's death is an elimination", () => {
    // fails if a disconnect leaves that T counted as standing, which reads the round as time
    const m = ctWin();
    m.leaves = { ri: [0], tick: [2000], pi: [2], alive: [1] };
    m.kills = kills([[3000, 3]]);
    m.pos = alivePos([[2, 1900]]);
    expect(how(m)).toBe("elim");
  });

  it("reads time only when a T is seen alive in the last second, and stays null when none is", () => {
    // fails if a T whose death is missing from the file is taken for a survivor, which reads time
    const m = ctWin();
    m.kills = kills([[3000, 3]]);
    expect(how(m)).toBeNull();
    m.pos = alivePos([[2, 3900]]);
    expect(how(m)).toBeNull();
    m.pos = alivePos([[2, 4936]]);
    expect(how(m)).toBe("time");
  });

  it("stays null when the plugin dropped kill or disconnect rows", () => {
    // fails if a match that lost kill rows to a full buffer still reads time or elimination from the rest
    const m = ctWin();
    m.kills = kills([[3000, 3]]);
    m.pos = alivePos([[2, 4990]]);
    expect(how({ ...m, recon: { dropped: { kills: 1 } } })).toBeNull();
    expect(how({ ...m, recon: { dropped: { leaves: 1 } } })).toBeNull();
    expect(how({ ...m, recon: { dropped: { pos: 1 } } })).toBe("time");
  });

  it("does not count a freeze-time death of a T who was alive at freeze end", () => {
    // fails if a T killed in freeze time and respawned for the live round counts as eliminated
    const m = ctWin();
    m.rounds.alive0 = [[1, 1, 1, 1]];
    m.kills = kills([[900, 2, 128], [3000, 3]]);
    m.pos = alivePos([[2, 4990]]);
    expect(how(m)).toBe("time");
  });
});

describe("a score with a missing part", () => {
  it("rebuilds no winner from it, mid-match or in the final round", () => {
    // fails if a null part is read as 0: [null, 5] then [1, 5] would give T the round, and [null, 5]
    // before the final round of an overtime match would give it to CT as the leader. The next round,
    // [1, 5] to [2, 5], is whole and still goes to T.
    const mid = file([true, true, true], [2, 2, 2], { maxrounds: 4 });
    mid.rounds.score = [[null, 5], [1, 5], [2, 5]];
    expect(roundResults(mid).winSide.slice(0, 2)).toEqual([null, 2]);
    const last = file(WINS, SIDES);
    last.rounds.score[7] = [null, 5];
    expect(roundResults(last).winSide[7]).toBeNull();
    last.rounds.score[7] = null;
    expect(roundResults(last).winSide.slice(6)).toEqual([null, null]);
  });
});
