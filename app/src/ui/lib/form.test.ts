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
  it("keeps the oldest match of each day from a newest-first list", () => {
    const out = firstOfDay([
      { file: "c", date: "2026-10-25" },
      { file: "b", date: "2026-10-24" },
      { file: "a", date: "2026-10-24" },
      { file: "x", date: null },
    ]);
    expect([...out].sort()).toEqual(["a", "c"]);
  });
});
