import { describe, expect, it } from "vitest";
import { scoreText, scoreTint, toScore } from "./scale";

describe("toScore", () => {
  it("maps around the neutral point and caps at ±1", () => {
    expect(toScore(1.0, 1.0, 0.35)).toBe(0);
    expect(toScore(1.35, 1.0, 0.35)).toBeCloseTo(1);
    expect(toScore(3, 1.0, 0.35)).toBe(1);
    expect(toScore(-3, 1.0, 0.35)).toBe(-1);
  });
  it("flips lower-is-better metrics", () => {
    expect(toScore(200, 300, 100, true)).toBe(1);
    expect(toScore(400, 300, 100, true)).toBe(-1);
  });
  it("is neutral for bad input", () => {
    expect(toScore(Number.NaN, 0, 1)).toBe(0);
    expect(toScore(1, 0, 0)).toBe(0);
  });
});

describe("scoreText", () => {
  it("stays neutral inside the dead zone", () => {
    expect(scoreText(0.05)).toBe(scoreText(0));
    expect(scoreText(-0.08)).toBe(scoreText(0));
    expect(scoreText(0.2)).not.toBe(scoreText(0));
  });
  it("moves monotonically toward the end colour", () => {
    const r = (t: number) => Number(scoreText(t).match(/rgb\((\d+)/)![1]);
    expect(r(0.3)).toBeGreaterThan(r(0.6));
    expect(r(0.6)).toBeGreaterThan(r(1));
  });
});

describe("scoreTint", () => {
  it("is transparent at zero and caps beyond ±1", () => {
    expect(scoreTint(0)).toBe("transparent");
    expect(scoreTint(5)).toBe(scoreTint(1));
    expect(scoreTint(-5)).toBe(scoreTint(-1));
  });
});

