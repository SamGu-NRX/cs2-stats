// The spray pattern builder on hand-built shots with known answers.
import { expect, it } from "vitest";
import { addShots, emptySamples, patternOf, quantile, residualOf, type PatternShot } from "./recoil-build";

const W = new Set(["ak47"]);
/** One player's AK spray from a reset: bullet j's view and its kick (bullet minus view). */
function spray(id: string, t0: number, view: [number, number][], kick: [number, number][], steady = true): PatternShot[] {
  return view.map(([p, y], j) => ({
    steamid: id, tick: t0 + 7 * j, weapon: "ak47", recoilIndex: j, pitch: p, yaw: y,
    bulletPitch: p + kick[j][0], bulletYaw: y + kick[j][1], scoped: false, steady,
  }));
}
const KICK: [number, number][] = [[0, 0], [-0.2, -0.1], [-1.3, 0], [-2.9, -0.15]];

it("takes the kick as bullet minus view at each whole recoil index, and the ideal pull as its mirror", () => {
  // fails if the kick is read as the view's movement, signed the wrong way, or not made relative to bullet 1
  const acc = emptySamples();
  // the pro pulls exactly against the kick, so his view moves by -kick and every bullet lands on bullet 1's point
  addShots(acc, spray("a", 100, KICK.map(([p, y]) => [10 - p, 50 - y]), KICK), W, 3);
  // a second spray with the same kick and a view that does not move
  addShots(acc, spray("b", 100, KICK.map(() => [5, 170]), KICK), W, 3);
  const pat = patternOf(acc, "ak47", 2, 2);
  expect(pat.kick).toEqual(KICK);
  expect(pat.ideal).toEqual([[0, 0], [0.2, 0.1], [1.3, 0], [2.9, 0.15]]);
  expect(pat.n).toEqual([2, 2, 2, 2]);
  // medians of the two views: (+0.2 and 0) / 2 and so on
  expect(pat.pro.map((r) => [r[0], r[1]])).toEqual([[0, 0], [0.1, 0.05], [0.65, 0], [1.45, 0.075]]);
  expect(residualOf(pat)).toEqual([[0, 0], [-0.1, -0.05], [-0.65, 0], [-1.45, -0.075]]);
});

it("leaves out partly recovered indices, scoped kicks, moving shots from the view path, and broken runs", () => {
  // fails if a fractional recoil index counts as a bullet, a scoped shot's kick or a moving shot enters, or a
  // run that skips an index or restarts keeps adding bullets
  const acc = emptySamples();
  const s = spray("a", 0, KICK.map(() => [0, 0]), KICK);
  s[2] = { ...s[2], recoilIndex: 2.3 };
  addShots(acc, s, W, 2);
  // a scoped shot adds no kick sample
  addShots(acc, [{ ...s[0], steamid: "c", scoped: true, steady: false }], W, 2);
  addShots(acc, spray("b", 0, KICK.map(() => [0, 0]), KICK, false), W, 2);
  expect(acc.kick.ak47.map((b) => b?.p.length ?? 0)).toEqual([2, 2, 1, 2]);
  // a's run stops at the fractional index (bullets 1-2); b is not steady, so no run at all
  expect(acc.view.ak47.map((b) => b?.p.length ?? 0)).toEqual([1, 1]);
  expect(acc.sprays.ak47).toBe(1);
  // the pattern stops at the first bullet short of samples
  expect(patternOf(acc, "ak47", 2, 1).kick.length).toBe(2);
});

it("interpolates quantiles between order statistics", () => {
  expect([quantile([1, 2, 3, 4], 0.5), quantile([1, 2, 3, 4], 0.25), quantile([5], 0.75)]).toEqual([2.5, 1.75, 5]);
});
