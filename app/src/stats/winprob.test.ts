import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { roundStateBefore } from "./swing";
import { MatchBuilder } from "./testing/build";
import { modelFromModule, rating3WinProbabilityCT, stubModel, type Rating3RoundState, type RoundState } from "./winprob";

const state = (ct: number, t: number): RoundState => ({ ctAlive: ct, tAlive: t, ctHp: 100 * ct, tHp: 100 * t, ctEquip: 20000, tEquip: 20000, planted: 0, secondsSincePlant: null, secondsSinceFreezeEnd: 30 });

describe("model adapter (model/export/winprob.ts → winProbabilityCT(state, map))", () => {
  test("accepts a function that answers with a probability", () => {
    const m = modelFromModule((s: RoundState) => (s.ctAlive >= s.tAlive ? 0.6 : 0.4));
    expect(m.kind).toBe("model");
    expect(m.winProbability(state(5, 4), "de_dust2")).toBe(0.6);
  });
  test("rejects a missing export or a non-probability answer, naming the reason", () => {
    expect(() => modelFromModule(undefined)).toThrow(/does not export a function named winProbabilityCT/);
    expect(() => modelFromModule(() => 1.5)).toThrow(/expected a probability between 0 and 1/);
    expect(() => modelFromModule(() => "0.5")).toThrow(/expected a probability/);
  });
  test("a state the model rejects has no answer (its round's swing becomes unknown)", () => {
    const m = modelFromModule((s: RoundState) => { if (s.ctAlive === 0) throw new RangeError("ctAlive"); return 0.5; });
    expect(m.winProbability(state(0, 3), "de_dust2")).toBeNull();
  });
  test("the placeholder is labelled as such", () => {
    expect(stubModel.kind).toBe("stub");
    expect(stubModel.label).toMatch(/Placeholder/);
  });
});

describe("HLTV Rating 3.02 probability", () => {
  test("the same 3v3 state differs by the side of the most recent kill", () => {
    // HLTV 240256 round 15 and 240272 round 8, full buys on Ancient.
    // Fails if history is omitted from the key or T probability is returned as CT.
    const base: Rating3RoundState = { ctAlive: 3, tAlive: 3, planted: 0,
      ctBuy: "FULL", tBuy: "FULL", lastKillSide: "t" };
    expect(rating3WinProbabilityCT(base, "de_ancient")).toBeCloseTo(0.533670526272, 10);
    expect(rating3WinProbabilityCT({ ...base, lastKillSide: "ct" }, "Ancient")).toBeCloseTo(0.453953953954, 10);
  });

  test("eliminating the last T does not settle a planted round", () => {
    // HLTV 242126 round 12: 0 T vs 3 CT, before the defuse.
    // Fails if the pre-plant elimination rule overrides bomb state.
    const planted: Rating3RoundState = { ctAlive: 3, tAlive: 0, planted: 1,
      ctBuy: "FULL", tBuy: "FULL", lastKillSide: "ct" };
    expect(rating3WinProbabilityCT(planted, "de_ancient")).toBeCloseTo(0.995036194415719, 12);
    expect(rating3WinProbabilityCT({ ...planted, terminalWinner: "ct" }, "de_ancient")).toBe(1);
  });
});

describe("round state for the model", () => {
  test("whole-team freeze-end equipment, seconds since freeze end and since plant", () => {
    const b = new MatchBuilder();
    const ctx = buildCtx(b.build());
    const s = roundStateBefore(ctx, 0, b.t(0, 50), [4, 5, 380, 500, 18800, 23500, 1, 640]);
    expect(s).toEqual({ ctAlive: 4, tAlive: 5, ctHp: 380, tHp: 500, ctEquip: 5 * 4700, tEquip: 5 * 4700, planted: 1, secondsSincePlant: 10, secondsSinceFreezeEnd: 50 });
  });
  test("unknown equipment means no state for the model", () => {
    const b = new MatchBuilder().round(0, 3, "elim", { equip: [null, ...new Array(9).fill(4700)] });
    expect(roundStateBefore(buildCtx(b.build()), 0, b.t(0, 5), [5, 5, 500, 500, null, null, 0, null])).toBeNull();
  });
});
