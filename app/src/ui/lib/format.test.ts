import { describe, expect, it } from "vitest";
import { fmtAdr, fmtClock, fmtDec, fmtDiff, fmtMoney, fmtMoneyShort, fmtPct, fmtRating, fmtRatio, fmtSwing, signed } from "./format";

describe("HLTV number formats", () => {
  it("formats rating with two decimals", () => {
    expect(fmtRating(1.4567)).toBe("1.46");
    expect(fmtRating(0.9)).toBe("0.90");
    expect(fmtRating(null)).toBe("–");
    expect(fmtRating(Number.NaN)).toBe("–");
  });
  it("formats swing from a fraction, signed, two decimals", () => {
    expect(fmtSwing(0.0503)).toBe("+5.03%");
    expect(fmtSwing(-0.0127)).toBe("−1.27%");
    expect(fmtSwing(0)).toBe("0.00%");
    expect(fmtSwing(-0.00001)).toBe("0.00%");
    expect(fmtSwing(undefined)).toBe("–");
  });
  it("formats KAST and ADR", () => {
    expect(fmtPct(71)).toBe("71.0%");
    expect(fmtAdr(86.24)).toBe("86.2");
    expect(fmtRatio(1, 3)).toBe("33.3%");
    expect(fmtRatio(1, 0)).toBe("–");
  });
  it("formats signed differences and decimals", () => {
    expect(fmtDiff(5)).toBe("+5");
    expect(fmtDiff(-3)).toBe("−3");
    expect(fmtDiff(0)).toBe("0");
    expect(fmtDec(0.8444)).toBe("0.84");
    expect(signed(-0.004, 2)).toBe("0.00");
  });
  it("formats money", () => {
    expect(fmtMoney(4750)).toBe("$4,750");
    expect(fmtMoneyShort(4750)).toBe("$4.8k");
    expect(fmtMoneyShort(800)).toBe("$800");
    expect(fmtMoney(null)).toBe("–");
  });
  it("formats the round clock", () => {
    expect(fmtClock(67)).toBe("1:07");
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(-2)).toBe("0:00");
    expect(fmtClock(null)).toBe("–");
  });
});

