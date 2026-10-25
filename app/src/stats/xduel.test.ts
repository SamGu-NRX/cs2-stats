// The expected-duel model's fit and its AUC, on data whose answers are known in closed form.
import { expect, it } from "vitest";
import { auc, fitXDuel, xduelP, type XDuelParams } from "./xduel";

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
