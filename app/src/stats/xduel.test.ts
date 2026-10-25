// The expected-duel model's fit and its AUC, on data whose answers are known in closed form.
import { describe, expect, it } from "vitest";
import { emptyAim, foldAim, type SightFact } from "./aim";
import { METRIC } from "./metrics";
import type { Summary } from "./rollup";
import { auc, fitXDuel, XDUEL, xduelP, type XDuelParams } from "./xduel";

it("fits the logistic model to its closed-form answer", () => {
  // fails if scaling, the Newton step or the intercept goes wrong. x = +1 wins 3 of 4, x = -1 wins
  // 1 of 4: x already has mean 0 and sd 1, and without a penalty the fit is intercept 0, slope logit(3/4) = ln 3
  const xs = [1, 1, 1, 1, -1, -1, -1, -1].map((x) => [x]);
  const ys: (0 | 1)[] = [1, 1, 1, 0, 1, 0, 0, 0];
  const fit = fitXDuel(xs, ys, 0);
  expect(fit.mean).toEqual([0]);
  expect(fit.sd).toEqual([1]);
  expect(fit.w[0]).toBeCloseTo(0, 9);
  expect(fit.w[1]).toBeCloseTo(Math.log(3), 9);
  expect(xduelP([1], { ...fit, features: ["x"] } as XDuelParams)).toBeCloseTo(0.75, 9);
  // the ridge shrinks the slope toward 0
  expect(fitXDuel(xs, ys, 0.1).w[1]).toBeLessThan(Math.log(3));
});

it("computes the AUC with ties counting half", () => {
  // fails if a tie or the rank sum is mishandled: of the four positive-negative pairs, three rank right
  expect(auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])).toBe(0.75);
  expect(auc([0.5, 0.5], [0, 1])).toBe(0.5);
});

describe("duel difficulty", () => {
  /** n settled duels whose context is the fit's mean, `wins` of them won: each expected win is 1 / (1 + e^-intercept). */
  const duels = (n: number, wins: number) => {
    const a = emptyAim();
    for (let i = 0; i < n; i++) {
      const f: SightFact = {
        k: "sight", ri: 0, pi: 0, weapon: null, place: 0, ttd: null, ttk: null, moved: null, react: null, shot: null, over: null, micro: null, trackN: 0, trackSum: 0,
        dist: 0, travel: null, shotSpeed: null, shotErr: null, stopBuf: null, first: null, duelS: 1, duelWon: i < wins, xf: [...XDUEL.mean],
      };
      foldAim(a, f);
    }
    return { aim: a } as Summary;
  };
  const p0 = 1 / (1 + Math.exp(-XDUEL.w[0]));

  it("gives the expected chance from 80 settled duels, and the margin over it from 442", () => {
    // fails if the fold skips the model, the scale is not percent, or a gate moves
    expect(METRIC.expectedDuel.value(duels(80, 60))).toBeCloseTo(100 * p0, 9);
    expect(METRIC.expectedDuel.value(duels(79, 60))).toBeNull();
    expect(METRIC.duelsOverExpected.value(duels(441, 300))).toBeNull();
    expect(METRIC.duelsOverExpected.value(duels(442, 300))).toBeCloseTo(100 * (300 / 442 - p0), 9);
  });

  it("says why there is no value under the gate", () => {
    // fails if a thin sample shows a duel-difficulty value without its reason
    expect(METRIC.duelsOverExpected.why!(duels(100, 50))).toBe("100 of the 442 settled duels it needs");
  });
});
