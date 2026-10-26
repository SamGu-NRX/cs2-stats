// The metrics-v2 contract: the ids the UI binds to, each defined in one plain sentence of 12 words or
// fewer (the long form is METRICS.md's).
import { expect, it } from "vitest";
import { METRIC, METRICS } from "./metrics";
import { emptySummary } from "./rollup";

const V2 = [
  "shotSpeed", "shotError", "stopBuffer", "movingSpray", "peekTravel", "duelExposure", "firedFirst", "engageDistance",
  "aggressionScore", "expectedDuel", "duelsOverExpected", "buyDeviation", "saveConversion",
];

it("defines every metrics-v2 metric in one sentence of 12 words or fewer", () => {
  // fails if an id the UI binds to disappears, or a definition grows past the spec's one short sentence
  for (const id of V2) {
    const def = METRIC[id]?.def;
    expect(def, id).toBeDefined();
    expect(def.split(/\s+/).length, `${id}: ${def}`).toBeLessThanOrEqual(12);
    expect(def, id).toMatch(/^[^.]+\.$/);
  }
});

it("counts multi-kill rounds by exact kills", () => {
  // fails if a k-kill share counts rounds with more than k kills: of 10 rounds, 4 had 2+ kills, 2 had
  // 3+, 1 had 4+ and none 5, so 2 rounds had exactly 2, 1 exactly 3 and 1 exactly 4
  const s = emptySummary();
  Object.assign(s.m, { rounds: 10, multiKillRounds: 4, k3Rounds: 2, k4Rounds: 1, k5Rounds: 0 });
  expect(["rounds2k", "rounds3k", "rounds4k", "rounds5k"].map((id) => METRIC[id].value(s))).toEqual([20, 10, 10, 0]);
});

it("gives every metric a tooltip of one sentence and 12 words or fewer", () => {
  // fails if a metric ships without a tooltip, or a tooltip grows past one short sentence
  for (const m of METRICS) {
    expect(m.tip, m.id).toMatch(/^[^.]+\.$/);
    expect(m.tip.split(/\s+/).length, `${m.id}: ${m.tip}`).toBeLessThanOrEqual(12);
  }
});
