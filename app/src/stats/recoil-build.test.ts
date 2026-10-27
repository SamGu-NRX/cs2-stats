// The spray pattern builder on hand-built shots with known answers.
import { expect, it } from "vitest";
import { addShots, emptySamples, MIN_KICK_SAMPLES, patternOf, quantile, residualOf, type PatternShot } from "./recoil-build";
import { RECOIL } from "./recoil";

const W = new Set(["ak47"]);
/** One player's AK spray from a reset: bullet j's view and its kick (bullet minus view). */
function spray(id: string, t0: number, view: [number, number][], kick: [number, number][], steady = true): PatternShot[] {
  return view.map(([p, y], j) => ({
    steamid: id, tick: t0 + 7 * j, weapon: "ak47", recoilIndex: j, pitch: p, yaw: y,
    bulletPitch: p + kick[j][0], bulletYaw: y + kick[j][1], scoped: false, silenced: null, steady,
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

it("builds the M4A1-S pattern from silenced shots only, and a scoped gun's from shots known to be unscoped", () => {
  // fails if an unsilenced or unrecorded-silencer M4A1-S shot, or an AUG shot with no scope state,
  // enters the kick; a gun without a scope needs no scope state
  const acc = emptySamples();
  const one = (weapon: string, scoped: boolean | null, silenced: boolean | null, id: string): PatternShot =>
    ({ steamid: id, tick: 0, weapon, recoilIndex: 1, pitch: 0, yaw: 0, bulletPitch: -1, bulletYaw: 0, scoped, silenced, steady: false });
  addShots(acc, [one("m4a1_silencer", false, true, "a"), one("m4a1_silencer", false, false, "b"), one("m4a1_silencer", false, null, "c"),
    one("aug", false, null, "d"), one("aug", null, null, "e"), one("aug", true, null, "f"), one("ak47", null, null, "g")], new Set(["m4a1_silencer", "aug", "ak47"]), 3);
  expect([acc.kick.m4a1_silencer[1].p.length, acc.kick.aug[1].p.length, acc.kick.ak47[1].p.length]).toEqual([1, 1, 1]);
});

it("unwraps yaw across 180 degrees in the kick and the view path", () => {
  // fails if a bullet at yaw -179.9 with the view at 179.9 reads as a 359.8 degree kick, or the view
  // path jumps by 360 when the view crosses 180
  const acc = emptySamples();
  const yaws = [179.8, 179.9, -179.9];
  const shots: PatternShot[] = yaws.map((y, j) => ({
    steamid: "a", tick: 7 * j, weapon: "ak47", recoilIndex: j, pitch: 0, yaw: y, bulletPitch: 0,
    bulletYaw: [179.8, -179.9, -179.6][j], scoped: false, silenced: null, steady: true,
  }));
  addShots(acc, shots, W, 3);
  const pat = patternOf(acc, "ak47", 1, 1);
  expect(pat.kick.map(([, y]) => y)).toEqual([0, 0.2, 0.3]);
  expect(pat.pro.map((r) => r[1])).toEqual([0, 0.1, 0.3]);
});

it("publishes only contiguous target-gun prefixes with enough kick samples", () => {
  const expectedLengths: Record<string, number> = {
    aug: 7, sg556: 0, mp5sd: 7, ump45: 6, p90: 0, bizon: 0, m249: 0, negev: 0, cz75a: 7,
  };
  for (const [weapon, length] of Object.entries(expectedLengths)) {
    const pattern = RECOIL[weapon];
    expect(pattern.kick.length, weapon).toBe(length);
    expect(pattern.ideal.length, weapon).toBe(length);
    expect(pattern.n.length, weapon).toBe(length);
    expect(pattern.n.every((samples) => samples >= MIN_KICK_SAMPLES), weapon).toBe(true);
    if (length) expect(pattern.kick[0], weapon).toEqual([0, 0]);
    if (length < pattern.mag) {
      expect(pattern.n[length] ?? MIN_KICK_SAMPLES - 1, weapon).toBeLessThan(MIN_KICK_SAMPLES);
    }
  }
});

it("keeps the rising pitch of the short rifle and SMG curves monotone", () => {
  for (const weapon of ["aug", "mp5sd", "ump45"]) {
    const pitch = RECOIL[weapon].kick.map(([p]) => Math.abs(p));
    expect(pitch.every((value, i) => i === 0 || value >= pitch[i - 1]), weapon).toBe(true);
  }
});
