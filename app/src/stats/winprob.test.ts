// The round win-probability source: HLTV's lookup when its pack is installed, else CS2RB.
import { expect, it } from "vitest";
import { CS2RB, winProbSource } from "./model-params";
import { pTWins, type RoundState } from "./winprob";

const state: RoundState = {
  map: "de_ancient", aliveT: 4, aliveCT: 5, hpT: 400, hpCT: 500, equipT: 20000, equipCT: 22000, planted: false,
  secondsSincePlant: null, secondsSinceFreezeEnd: 20, buyT: "full", buyCT: "full", lastKillSide: "ct",
};

it("reads HLTV's lookup from the most specific table that holds the state, and refuses a malformed pack", () => {
  // fails if a broken pack silently falls back to CS2RB, or a general table answers before a specific one
  expect(winProbSource(null)).toBe(CS2RB);
  expect(() => winProbSource({ target: "x" })).toThrow(/winprob-hltv.json/);
  const pack = winProbSource({
    source_maps: 2,
    tables: [
      { columns: ["map", "alive_t", "alive_ct", "last_kill_side"], states: { "Ancient|4|5|ct": { p_t: 0.31, n: 9 } } },
      { columns: ["alive_t", "alive_ct"], states: { "4|5": { p_t: 0.35, n: 90 }, "3|5": { p_t: 0.2, n: 50 } } },
    ],
  });
  expect(pTWins(pack, state)).toBe(0.31);
  expect(pTWins(pack, { ...state, aliveT: 3, hpT: 300 })).toBe(0.2);
  expect(pTWins(pack, { ...state, aliveT: 2, hpT: 200 })).toBeNull();
});

it("values CS2RB states only with equipment and time, and answers decided rounds by the rules", () => {
  // fails if CS2RB guesses a round whose equipment is unknown, throws on a sixth player, or a round with
  // no CT alive is not a T win
  expect(pTWins(CS2RB, { ...state, equipT: null })).toBeNull();
  expect(pTWins(CS2RB, { ...state, secondsSinceFreezeEnd: null })).toBeNull();
  expect(pTWins(CS2RB, { ...state, aliveCT: 6, hpCT: 600 })).toBeNull();
  expect(pTWins(CS2RB, { ...state, aliveCT: 0, hpCT: 0 })).toBe(1);
  const p = pTWins(CS2RB, state)!;
  expect(p).toBeGreaterThan(0);
  expect(p).toBeLessThan(0.5);
});
