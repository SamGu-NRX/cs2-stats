import { describe, expect, it } from "vitest";
import { halfOf, killSlots, roundColumns, startsHalf } from "./layout";

describe("halves", () => {
  it("splits regulation at maxrounds / 2", () => {
    expect(halfOf(0, 24)).toBe(0);
    expect(halfOf(11, 24)).toBe(0);
    expect(halfOf(12, 24)).toBe(1);
    expect(halfOf(23, 24)).toBe(1);
  });
  it("uses three-round overtime halves", () => {
    expect(halfOf(24, 24)).toBe(2);
    expect(halfOf(26, 24)).toBe(2);
    expect(halfOf(27, 24)).toBe(3);
    expect(halfOf(30, 24)).toBe(4);
  });
  it("handles short matches", () => {
    expect(halfOf(7, 16)).toBe(0);
    expect(halfOf(8, 16)).toBe(1);
  });
  it("marks the first round of each half", () => {
    const starts = Array.from({ length: 30 }, (_, ri) => ri).filter((ri) => startsHalf(ri, 24));
    expect(starts).toEqual([12, 24, 27]);
  });
});

describe("roundColumns", () => {
  it("places columns with a gap at halftime", () => {
    const { cols, width } = roundColumns(14, 24, 30, 2, 10);
    expect(cols[0].x).toBe(0);
    expect(cols[1].x).toBe(32);
    expect(cols[11].x).toBe(11 * 32);
    expect(cols[12].gapBefore).toBe(true);
    expect(cols[12].x).toBe(12 * 32 + 10);
    expect(cols[13].x).toBe(13 * 32 + 10);
    expect(width).toBe(13 * 32 + 10 + 30);
  });
  it("is empty without rounds", () => {
    expect(roundColumns(0, 24, 30, 2, 10)).toEqual({ cols: [], width: 0 });
  });
});

describe("killSlots", () => {
  it("returns every kill when they fit", () => {
    expect(killSlots([1, 2, 3], 3, 2)).toEqual({ items: [1, 2, 3], overflow: 0 });
    expect(killSlots([1, 2, 3, 4, 5, 6], 3, 2)).toEqual({ items: [1, 2, 3, 4, 5, 6], overflow: 0 });
  });
  it("folds the overflow into the last slot", () => {
    expect(killSlots([1, 2, 3, 4, 5], 2, 2)).toEqual({ items: [1, 2, 3], overflow: 2 });
  });
});

