// Correlation with winning on known answers: each match's values, Pearson r, the band chance
// correlations fall in, and the won and lost means the view sets beside r.
import { describe, expect, it } from "vitest";
import { noiseBand, winLossMeans } from "./correlation";
import { FREEZE_END, oneRound } from "./testing/match";
import { matchValues, pearson, trend, winCorrelationOf } from "./trends";

describe("winCorrelationOf", () => {
  it("is the point-biserial r of the values with won = 1, lost = 0", () => {
    // fails if r is computed on another coding or ties enter: values 1, 2, 3, 4 with lost, lost, won,
    // won and one tie. Pearson of (1,2,3,4) with (0,0,1,1) is 0.894427 (4 / sqrt(5 * 4))
    const r = winCorrelationOf([{ value: 1, won: false }, { value: 2, won: false }, { value: 3, won: true }, { value: 4, won: true }, { value: 9, won: null }]);
    expect([r.n, r.reason]).toEqual([4, null]);
    expect(r.r).toBeCloseTo(4 / Math.sqrt(20), 9);
  });

  it("gives no r, and says why, when winning or the stat never changes", () => {
    // fails if ten wins in a row or a constant stat read as r = 0: either makes r 0 / 0
    const wins = Array.from({ length: 10 }, (_, i) => ({ value: i, won: true }));
    expect(winCorrelationOf(wins)).toEqual({ r: null, n: 10, reason: "allWon" });
    expect(winCorrelationOf(wins.map((p) => ({ ...p, won: false })))).toEqual({ r: null, n: 10, reason: "allLost" });
    expect(winCorrelationOf(wins.map((p, i) => ({ value: 1.2, won: i % 2 === 0 })))).toEqual({ r: null, n: 10, reason: "flat" });
  });
});

describe("pearson", () => {
  it("is undefined (null), not 0, when either side has no spread", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
  });
});

describe("noiseBand", () => {
  it("is tanh(1.96 / sqrt(n - 3)), the 5% two-sided chance |r|", () => {
    // fails if the band is off the Fisher-z value: n = 10 gives tanh(0.740800) = 0.629626; n = 28
    // gives tanh(0.391993) = 0.373077, close to the exact t-test value 0.3739
    expect(noiseBand(10)).toBeCloseTo(0.629626, 5);
    expect(noiseBand(28)).toBeCloseTo(0.373077, 5);
    expect(noiseBand(3)).toBeNull();
  });
});

describe("winLossMeans", () => {
  it("averages each match's value over the won and the lost matches", () => {
    // fails if ties or missing values enter a group: won 3 and 5, lost 1, a tie and a null left out
    expect(winLossMeans([{ value: 3, won: true }, { value: 5, won: true }, { value: 1, won: false }, { value: 7, won: null }, { value: null, won: false }])).toEqual({ won: 4, lost: 1 });
    expect(winLossMeans([{ value: 3, won: true }])).toEqual({ won: 3, lost: null });
  });
});

describe("trend", () => {
  it("is the least-squares slope per match over the matches with a value", () => {
    // fails if a gap shifts the x of later matches: values 1, -, 3, 5 at x 0, 2, 3 give slope 1.285714 (9/7)
    const r = trend([1, null, 3, 5].map((value, i) => ({ match: String(i), date: null, value, won: null })));
    expect(r!.slope).toBeCloseTo(9 / 7, 9);
    expect(r!.n).toBe(3);
  });

  it("has a slope of 0 and no r for a stat that never changes", () => {
    expect(trend([2, 2, 2, 2].map((value, i) => ({ match: String(i), date: null, value, won: null })))).toEqual({ slope: 0, r: null, n: 4 });
  });
});

describe("matchValues", () => {
  it("is the match's value of each metric under the filter, and null when the filter keeps none of its rounds", () => {
    // fails if a match the filter empties reads as a value, or a metric reads another player: a (CT)
    // kills b once in the one round, so a's KPR is 1 and DPR 0; on T a has no round
    const f = oneRound({ players: { a: "CT", b: "T" }, kills: [{ tick: FREEZE_END + 320, killer: "a", victim: "b" }] });
    expect(matchValues(f, { player: "a" }, ["kpr", "dpr"])).toEqual({ kpr: 1, dpr: 0 });
    expect(matchValues(f, { player: "a", sides: ["T"] }, ["kpr"])).toBeNull();
    expect(() => matchValues(f, { player: "a" }, ["nope"])).toThrow(/unknown metric "nope"/);
  });
});
