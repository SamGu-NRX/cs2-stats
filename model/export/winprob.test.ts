import { describe, expect, test } from "vitest";
import parity from "./parity_rows.json";
import { type RoundState, winProbabilityCT } from "./winprob";

interface ParityRow {
  state: RoundState;
  map: string;
  expected: number;
  case?: string;
}

const rows = parity.rows as ParityRow[];
const edges = parity.edgeCases as ParityRow[];

describe("TypeScript matches the Python reference evaluator", () => {
  test("parity file holds 50 sampled test states", () => {
    expect(rows).toHaveLength(50);
  });

  test.each(rows.map((r, i) => [i, r] as const))("sampled row %i within 1e-6", (_, r) => {
    expect(Math.abs(winProbabilityCT(r.state, r.map) - r.expected)).toBeLessThanOrEqual(1e-6);
  });

  test.each(edges.map((r) => [r.case, r] as const))("edge case: %s", (_, r) => {
    expect(Math.abs(winProbabilityCT(r.state, r.map) - r.expected)).toBeLessThanOrEqual(1e-6);
  });

  test("largest absolute difference", () => {
    const worst = Math.max(...[...rows, ...edges].map((r) => Math.abs(winProbabilityCT(r.state, r.map) - r.expected)));
    console.log(`max |TS - Python| over ${rows.length + edges.length} states: ${worst.toExponential(2)}`);
    expect(worst).toBeLessThanOrEqual(1e-6);
  });
});

describe("invalid input fails loudly", () => {
  const ok = rows[0].state;
  test.each([
    ["six CTs", { ...ok, ctAlive: 6 }, /ctAlive must be an integer 0-5/],
    ["HP above the living players", { ...ok, ctAlive: 1, ctHp: 150 }, /ctHp must be 0-100/],
    ["plant time while not planted", { ...ok, planted: 0, secondsSincePlant: 3 }, /secondsSincePlant must be null/],
    ["planted without plant time", { ...ok, planted: 1, secondsSincePlant: null }, /secondsSincePlant must be seconds/],
    ["negative clock", { ...ok, secondsSinceFreezeEnd: -1 }, /secondsSinceFreezeEnd/],
    ["NaN equipment", { ...ok, tEquip: Number.NaN }, /tEquip/],
  ] as const)("%s", (_, state, msg) => {
    expect(() => winProbabilityCT(state as RoundState, "de_dust2")).toThrow(msg);
  });
});
