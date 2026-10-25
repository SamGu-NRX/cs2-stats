import { expect, it } from "vitest";
import { percentileOf } from "./compare";
import { mostSimilar, similarity, STYLE, type PackPlayer } from "./identity";

// Quantiles at 0, 5, ..., 100 percent. Values 0..200 in steps of 10: each step is 5 percentile points.
const linear = Array.from({ length: 21 }, (_, i) => i * 10);

it("reads percentiles between, below, above and across a flat run of quantiles", () => {
  expect(percentileOf(linear, 37)).toBeCloseTo(18.5); // 37 is 70% of the way from 30 (15%) to 40 (20%)
  expect(percentileOf(linear, -5)).toBe(0);
  expect(percentileOf(linear, 500)).toBe(100);
  // quantiles 20%..40% all equal 3: a value of 3 sits in the middle of that run
  const flat = [0, 1, 2, 2.5, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  expect(percentileOf(flat, 3)).toBe(30);
});

it("scores similarity by profile shape over both sides, not by level", () => {
  // fails if a profile at a different level but the same shape stops being a 100% match (the
  // populations differ, design/identity.md), or if "plays like" reads only one side
  expect(similarity({ entrying: 60, trading: 40 }, { entrying: 90, trading: 10, opening: 5 }, ["entrying", "trading", "opening"])).toBeCloseTo(100);
  expect(similarity({ entrying: 60, trading: 40 }, { entrying: 30, trading: 70 }, ["entrying", "trading"])).toBeCloseTo(-100);
  expect(similarity({ entrying: null }, { entrying: 40 }, ["entrying"])).toBeNull();
  const style = (hi: "entrying" | "sniping") => Object.fromEntries(STYLE.map((k) => [k, k === hi ? 90 : 40]));
  const mine = { T: style("entrying"), CT: style("sniping") };
  const pack: PackPlayer[] = [
    { name: "same on T only", sides: { T: { style: style("entrying") }, CT: { style: style("entrying") } } },
    { name: "same on both", sides: { T: { style: style("entrying") }, CT: { style: style("sniping") } } },
  ];
  expect(mostSimilar(mine, pack, "style").map((x) => x.name)).toEqual(["same on both", "same on T only"]);
});
