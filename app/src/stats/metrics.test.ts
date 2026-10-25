// The metrics-v2 contract: the ids the UI binds to, each defined in one plain sentence of 12 words or
// fewer (the long form is METRICS.md's).
import { expect, it } from "vitest";
import { METRIC } from "./metrics";

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
