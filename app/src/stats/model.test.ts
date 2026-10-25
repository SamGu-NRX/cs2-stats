// The trained model (model/export/winprob.ts, bundled through the @model/winprob alias when it and
// its model.json exist) and how swing treats rounds the model cannot value.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { winProbabilityCT } from "@model/winprob";
import { buildCtx } from "./context";
import { countMatch } from "./counters";
import { deriveMatch } from "./derive";
import { computeTrades } from "./rules";
import { computeSwing } from "./swing";
import { MatchBuilder } from "./testing/build";
import { modelFromModule, type RoundState, type WinModel } from "./winprob";

const PARITY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../model/export/parity_rows.json");
const bundled = winProbabilityCT !== undefined && existsSync(PARITY);

describe.skipIf(!bundled)("trained model through the app's adapter", () => {
  test("every parity state gives the model's own value", () => {
    const { rows } = JSON.parse(readFileSync(PARITY, "utf8")) as { rows: { state: RoundState; map: string; expected: number }[] };
    const m = modelFromModule(winProbabilityCT);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(m.winProbability(r.state, r.map)).toBeCloseTo(r.expected, 9);
  });
});

/** A model that answers 0.5 minus 0.1 per missing CT, so swings are easy to predict. */
const fake: WinModel = { kind: "model", label: "test", winProbability: (s) => 0.5 - 0.1 * (5 - s.ctAlive) };

describe("swing with the trained model", () => {
  test("a round where any player's equipment is null has unknown swing, not a partial sum", () => {
    const b = new MatchBuilder(2).kill(0, 10, 5, 1, { state: [5, 5, 500, 500, 23500, 23500, 0, null] }).kill(1, 10, 5, 1, { state: [5, 5, 500, 500, 23500, 23500, 0, null] });
    b.round(1, 3, "elim", { equip: [4700, 4700, null, 4700, 4700, 4700, 4700, 4700, 4700, 4700] });
    const m = b.build();
    const ctx = buildCtx(m);
    const r = computeSwing(ctx, fake);
    expect([...r.unknownRounds]).toEqual([1]);
    expect(r.swings.map((s) => ctx.kills[s.k].ri)).toEqual([0]);
    const c = countMatch(ctx, computeTrades(ctx), r).counters[1];
    expect(c.swingRounds).toBe(1);
    expect(c.swing).toBeCloseTo(-0.1, 12);
    const v = deriveMatch(m, "t", fake);
    expect(v.rounds[1].swing).toBeNull();
    expect(v.rounds[0].swing![1]).toBeCloseTo(-0.1, 12);
  });
  test("a state the model rejects makes its round unknown", () => {
    const strict: WinModel = { ...fake, winProbability: (s) => (s.ctAlive < 5 ? null : 0.5) };
    const b = new MatchBuilder().kill(0, 10, 5, 1, { state: [5, 5, 500, 500, 23500, 23500, 0, null] });
    expect([...computeSwing(buildCtx(b.build()), strict).unknownRounds]).toEqual([0]);
  });
  test("seconds since plant come from rounds.plantTick", () => {
    const b = new MatchBuilder().kill(0, 50, 5, 1, { state: [5, 5, 500, 500, 23500, 23500, 1, 999] });
    b.m.rounds.plantTick[0] = b.t(0, 40);
    let seen: RoundState | null = null;
    computeSwing(buildCtx(b.build()), { ...fake, winProbability: (s) => { seen ??= s; return 0.5; } });
    expect(seen!).toMatchObject({ planted: 1, secondsSincePlant: 10, secondsSinceFreezeEnd: 50, ctEquip: 23500, tEquip: 23500 });
  });
});
