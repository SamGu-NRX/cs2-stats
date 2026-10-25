// The role blend's AWP share, on hand-built summaries.
import { expect, it } from "vitest";
import { roleBlend } from "./identity";
import { emptySummary } from "./rollup";

/** Ten T rounds with the positional inputs set, `loadout` of them with a recorded loadout and `awp` with an AWP. */
function tRounds(loadout: number, awp: number) {
  const s = emptySummary();
  Object.assign(s.m, {
    rounds: 10, loadoutRounds: loadout, roundsWithAwp: awp, deaths: 6, kills: 7, deathTimeSum: 300, openingKills: 2, openingDeaths: 2,
    tradedDeaths: 2, tradeKills: 2, spacingSamples: 100, adntRank: 50, adatRank: 50,
  });
  return s;
}

it("takes the AWP share over the rounds with a recorded loadout and says how many those are", () => {
  // fails if rounds without a loadout count as rounds without an AWP: 5 of 5 recorded rounds with an
  // AWP is an AWPer share of 1, not 5 of 10
  const r = roleBlend(tRounds(5, 5), "T");
  expect([r.awp, r.loadoutRounds, r.blend!.AWPer]).toEqual([1, 5, 1]);
  expect(r.evidence[0]).toBe("Carried an AWP in 100% of the 5 T rounds with a recorded loadout (of 10).");
});

it("gives no AWP share when no round has a recorded loadout", () => {
  // fails if a plugin file's rounds (no loadouts) read as never carrying an AWP
  const r = roleBlend(tRounds(0, 0), "T");
  expect([r.awp, "AWPer" in r.blend!]).toEqual([null, false]);
  expect(Object.values(r.blend!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  expect(r.evidence[0]).toBe("No freeze-end loadout recorded in T rounds, so the AWP share is unknown.");
});
