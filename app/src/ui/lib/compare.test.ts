import { describe, expect, it } from "vitest";
import { correlation, rankSimilar, similarityPct } from "./similarity";
import { BENCH, benchAround, meterGeometry, verdictOf } from "./verdict";

describe("verdictOf", () => {
  it("judges higher-is-better metrics", () => {
    expect(verdictOf(1.2, BENCH.rating)).toBe("good");
    expect(verdictOf(1.1, BENCH.rating)).toBe("good");
    expect(verdictOf(1.0, BENCH.rating)).toBe("avg");
    expect(verdictOf(0.95, BENCH.rating)).toBe("avg");
    expect(verdictOf(0.94, BENCH.rating)).toBe("poor");
  });
  it("judges lower-is-better metrics", () => {
    expect(verdictOf(0.55, BENCH.dpr)).toBe("good");
    expect(verdictOf(0.7, BENCH.dpr)).toBe("avg");
    expect(verdictOf(0.8, BENCH.dpr)).toBe("poor");
    expect(verdictOf(240, BENCH.reaction)).toBe("good");
  });
  it("returns n/a without a value", () => {
    expect(verdictOf(null, BENCH.kpr)).toBe("na");
    expect(verdictOf(Number.POSITIVE_INFINITY, BENCH.kpr)).toBe("na");
  });
});

describe("benchAround", () => {
  it("puts ±7 % around a measured average", () => {
    const b = benchAround(BENCH.adr, 80);
    expect(b.ref).toBe(80);
    expect(b.good).toBeCloseTo(85.6);
    expect(b.poor).toBeCloseTo(74.4);
    expect(verdictOf(86, b)).toBe("good");
    expect(verdictOf(80, b)).toBe("avg");
  });
  it("flips for lower-is-better", () => {
    const b = benchAround(BENCH.dpr, 0.7);
    expect(b.good).toBeLessThan(0.7);
    expect(b.poor).toBeGreaterThan(0.7);
  });
  it("keeps a minimum band around zero", () => {
    const b = benchAround(BENCH.swing, 0);
    expect(b.good).toBeGreaterThan(0);
    expect(b.poor).toBeLessThan(0);
  });
});

describe("meterGeometry", () => {
  it("places the value, reference and zones on 0..1", () => {
    const g = meterGeometry(1.05, BENCH.rating);
    expect(g.value).toBeCloseTo(0.5);
    expect(g.ref).toBeCloseTo(0.4545, 3);
    expect(g.low).toBeCloseTo(0.409, 3);
    expect(g.high).toBeCloseTo(0.5454, 3);
    expect(g.goodOnRight).toBe(true);
  });
  it("clamps and handles lower-is-better", () => {
    expect(meterGeometry(9, BENCH.rating).value).toBe(1);
    const g = meterGeometry(0.5, BENCH.dpr);
    expect(g.goodOnRight).toBe(false);
    expect(g.low).toBeLessThan(g.high);
    expect(meterGeometry(null, BENCH.dpr).value).toBeNull();
  });
});

describe("similarity", () => {
  it("is 1 for the same shape at a different level", () => {
    expect(correlation([10, 20, 30, 40], [60, 70, 80, 90])).toBeCloseTo(1);
    expect(similarityPct(1)).toBe(100);
  });
  it("is −1 for the opposite shape", () => {
    expect(correlation([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(similarityPct(-1)).toBe(0);
  });
  it("skips null scores and needs three pairs", () => {
    expect(correlation([1, null, 3, 5], [2, 9, 4, 6])).toBeCloseTo(1);
    expect(correlation([1, 2], [1, 2])).toBeNull();
    expect(correlation([5, 5, 5], [1, 2, 3])).toBeNull();
  });
  it("ranks best first and drops unrankable items", () => {
    const you = [90, 40, 30, 50, 60, 10, 20];
    const pros = [
      { n: "flat", s: [50, 50, 50, 50, 50, 50, 50] },
      { n: "same", s: [95, 45, 35, 55, 65, 15, 25] },
      { n: "opposite", s: [10, 60, 70, 50, 40, 90, 80] },
    ];
    const ranked = rankSimilar(you, pros, (p) => p.s);
    expect(ranked.map((r) => r.item.n)).toEqual(["same", "opposite"]);
    expect(ranked[0].pct).toBe(100);
  });
});

