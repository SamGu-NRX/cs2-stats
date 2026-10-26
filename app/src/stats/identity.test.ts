// The role blend's AWP share, on hand-built summaries.
import { expect, it } from "vitest";
import { overallRole, roleBlend } from "./identity";
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

it("states the opening, death-time and trade evidence, and no teammate-distance line", () => {
  // fails if the evidence again cites the distance-to-teammates ranks, which the UI owner asked to drop:
  // 4 opening duels in 10 rounds is 40%, 300 s over 6 deaths is 50 s, 2 of 6 deaths and 2 of 7 kills traded
  expect(roleBlend(tRounds(5, 5), "T").evidence).toEqual([
    "Carried an AWP in 100% of the 5 T rounds with a recorded loadout (of 10).",
    "In the opening duel in 40% of rounds.",
    "Died 50 s into the round on average.",
    "33% of deaths were traded; 29% of kills were trades.",
  ]);
});

it("gives no AWP share when no round has a recorded loadout", () => {
  // fails if a plugin file's rounds (no loadouts) read as never carrying an AWP
  const r = roleBlend(tRounds(0, 0), "T");
  expect([r.awp, "AWPer" in r.blend!]).toEqual([null, false]);
  expect(Object.values(r.blend!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  expect(r.evidence[0]).toBe("No freeze-end loadout recorded in T rounds, so the AWP share is unknown.");
});

it("weights each side's blend by its rounds for the overall role", () => {
  // fails if the sides are averaged equally or a side without a blend takes weight: 30 T rounds all
  // Entry and 10 CT rounds all Anchor give Entry 0.75 and Anchor 0.25; a CT side with no blend leaves Entry 1
  const t = { side: "T" as const, blend: { Entry: 1 }, evidence: [], rounds: 30, awp: null, loadoutRounds: 0 };
  const ct = { side: "CT" as const, blend: { Anchor: 1 }, evidence: [], rounds: 10, awp: null, loadoutRounds: 0 };
  expect(overallRole(t, ct)).toEqual({ blend: { Entry: 0.75, Anchor: 0.25 }, rounds: { T: 30, CT: 10 } });
  expect(overallRole(t, { ...ct, blend: null }).blend).toEqual({ Entry: 1 });
  expect(overallRole({ ...t, blend: null }, { ...ct, blend: null }).blend).toBeNull();
});
