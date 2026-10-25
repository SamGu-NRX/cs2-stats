import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { roundStateBefore } from "./swing";
import { MatchBuilder } from "./testing/build";
import { modelFromModule, stubModel, type RoundState } from "./winprob";

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
  test("a state the model rejects gets the placeholder's answer", () => {
    const m = modelFromModule((s: RoundState) => { if (s.ctAlive === 0) throw new RangeError("ctAlive"); return 0.5; });
    expect(m.winProbability(state(0, 3), "de_dust2")).toBe(0);
  });
  test("the placeholder is labelled as such", () => {
    expect(stubModel.kind).toBe("stub");
    expect(stubModel.label).toMatch(/Placeholder/);
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
