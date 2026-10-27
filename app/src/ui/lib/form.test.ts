import { describe, expect, it } from "vitest";
import { firstOfDay, formWindow, insideFences } from "./form";

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

describe("formWindow", () => {
  // newest first: m12 (Oct 26) .. m1; two matches a day, the odd one the day's first
  const list = Array.from({ length: 12 }, (_, i) => {
    const n = 12 - i;
    return { file: `m${n}`, date: `2026-10-${String(10 + Math.ceil(n / 2)).padStart(2, "0")}`, r: n === 6 ? 3.2 : n === 4 ? null : 1 + n / 100 };
  });
  const run = (noOutliers: boolean, noFirst: boolean) => {
    const w = formWindow(list, (x) => x.r, (x) => x, { noOutliers, noFirst });
    return { shown: w.shown.map((x) => x.file), hidden: w.hidden };
  };

  it("shows the last ten, oldest first, with nothing hidden when both filters are off", () => {
    expect(run(false, false)).toEqual({ shown: ["m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12"], hidden: 0 });
  });

  it("leaves out each day's first match, the day read over the whole list", () => {
    // fails if the first of a day is judged inside the window only: m3 is the first of its day (m3, m4)
    expect(run(false, true)).toEqual({ shown: ["m4", "m6", "m8", "m10", "m12"], hidden: 5 });
  });

  it("leaves out a rating outside the fences, never a match without a rating", () => {
    // fails if the 3.20 stays or the unrated m4 counts as an outlier
    expect(run(true, false)).toEqual({ shown: ["m3", "m4", "m5", "m7", "m8", "m9", "m10", "m11", "m12"], hidden: 1 });
  });

  it("applies the fences to the matches the first-of-day filter left", () => {
    // fails if the fences run before the day filter: left are m4 (unrated), m6 (3.20), m8, m10, m12;
    // four ratings 3.20, 1.08, 1.10, 1.12 put 3.20 outside the fences
    expect(run(true, true)).toEqual({ shown: ["m4", "m8", "m10", "m12"], hidden: 6 });
  });
});
