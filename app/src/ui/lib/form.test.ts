import { describe, expect, it } from "vitest";
import { firstOfDay, insideFences } from "./form";

describe("insideFences", () => {
  it("drops a value far outside the interquartile range", () => {
    const keep = insideFences([1.0, 1.1, 0.9, 1.05, 0.0, 1.2]);
    expect(keep.has(4)).toBe(false);
    expect(keep.size).toBe(5);
  });
  it("keeps everything with fewer than four values", () => {
    expect(insideFences([0, 5, 10]).size).toBe(3);
  });
});

describe("firstOfDay", () => {
  it("keeps the earliest match of each local day, in any input order", () => {
    // noon local time avoids a date boundary in any time zone the test machine runs in
    const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
    const out = firstOfDay([
      { file: "b", startUtc: at(24, 14) },
      { file: "a", startUtc: at(24, 12) },
      { file: "c", startUtc: at(25, 12) },
    ]);
    expect([...out].sort()).toEqual(["a", "c"]);
  });
});
