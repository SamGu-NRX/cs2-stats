// The rebuilt recon tally and round coverage that pnpm takeover-check compares the adapter against.
import { describe, expect, it } from "vitest";
import type { MatchFile } from "../src/stats/plugin/schema";
import { coverage, tallies } from "./recon-tally";

/**
 * Round 0 with the human (pi 0) and bots mate (1) and other (2) on CT, bots t1 (3) and t2 (4) on T.
 * t1 kills the human at 1150; driving the mate, the human hits t1 at 1290 and kills him at 1300; other
 * kills t2 at 1400 with the human named as assister.
 */
function file(plugin: string): MatchFile {
  const none = { ri: [], tick: [] };
  return {
    v: 1, id: "t", map: "de_test", startUtc: "2026-10-25T00:00:00Z", endUtc: "2026-10-25T00:30:00Z", status: "complete",
    env: { plugin, cssharp: null, game: null, tickrate: 64, maxrounds: 24, botDifficulty: null },
    firstFullRound: 0, weapons: ["ak47"], places: [], human: 0,
    players: { key: ["76561190000000001", "B:mate", "B:other", "B:t1", "B:t2"], name: ["me", "mate", "other", "t1", "t2"], isBot: [false, true, true, true, true], startSide: [3, 3, 3, 2, 2] },
    rounds: {
      winSide: [3], how: ["elim"], freezeTick: [1000], durTicks: [4000], bombSite: [null], plantTick: [null], planter: [null], defuser: [null],
      ctSetup: [null], score: [[0, 0]], side: [[3, 3, 3, 2, 2]], equip: [[4000, 4000, 4000, 4000, 4000]], money: [[800, 800, 800, 800, 800]],
      alive0: [[1, 1, 1, 1, 1]],
    },
    kills: {
      ri: [0, 0, 0], tick: [1150, 1300, 1400], killer: [3, 0, 2], victim: [0, 3, 4], assister: [null, null, 0], flashAssister: [null, null, null], weapon: [0, 0, 0],
      flags: [0, 0, 0], kpos: [null, null, null], vpos: [null, null, null], state: [null, null, null], kBody: [null, 1, null], vBody: [null, null, null],
    },
    damage: { ri: [0], tick: [1290], attacker: [0], victim: [3], dmg: [100], dmgArmor: [0], weapon: [0], hitgroup: [null] },
    blinds: { ...none, attacker: [], victim: [], ms: [] },
    grenades: { ...none, thrower: [], type: [], pos: [] },
    pos: { ...none, pi: [], x: [], y: [], z: [], place: [], alive: [] },
    aim: {
      engagements: { ri: [], enemy: [], tVis: [], angVis: [], angVisYaw: [], angVisPitch: [], dist: [], tAimStart: [], tFirstShot: [], tFirstDmg: [], tEnd: [], outcome: [] },
      shots: { ri: [], tick: [], weapon: [], burst: [], idx: [], speed: [], maxSpeed: [], scoped: [], ducked: [], target: [], aimErr: [], impact: [], hit: [] },
    },
  };
}

describe("the rebuilt recon tally", () => {
  it("credits the controller before plugin 1.3.0 and the body from it, except assists, which stay with the controller", () => {
    // fails if an older file's tally moves the kill or damage to the body, or a 1.3.0 file's does not,
    // or either moves the assist named on the kill off the controller that the event names
    const row = (plugin: string) => [0, 1].map((pi) => {
      const x = tallies(file(plugin))(0, pi);
      return [x.k, x.a, x.dmg];
    });
    expect(row("1.1.0")).toEqual([[1, 1, 100], [0, 0, 0]]);
    expect(row("1.3.0")).toEqual([[0, 1, 0], [1, 0, 100]]);
  });
});

describe("recon round coverage", () => {
  it("reads checkedPlayers and expectedPlayers, and the early checked and missing fields", () => {
    // fails if a fully read round in an early file is skipped as partly read, or a partly read one counts as full
    expect(coverage({ ri: [0], checkedPlayers: [9], expectedPlayers: [10] }, 0)).toEqual({ checked: 9, expected: 10 });
    expect(coverage({ ri: [0], checked: [10], missing: [0] }, 0)).toEqual({ checked: 10, expected: 10 });
    expect(coverage({ ri: [0], checked: [10] }, 0)).toEqual({ checked: 10, expected: 10 });
    expect(coverage({ ri: [0], checked: [9], missing: [[4]] }, 0)).toEqual({ checked: 9, expected: 10 });
    expect(coverage({ ri: [0], checked: [true], missing: [[]] }, 0)).toEqual({ checked: 1, expected: 1 });
    expect(coverage({ ri: [0], checked: [true], missing: [2] }, 0)).toEqual({ checked: 0, expected: 0 });
    expect(coverage({ ri: [0], checked: [false] }, 0)).toEqual({ checked: 0, expected: 0 });
  });
});
