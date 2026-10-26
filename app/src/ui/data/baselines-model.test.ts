// The shipped pro baselines and the model gate. public/baselines.json ships with the app, so its
// swing-based quantiles must come from the public CS2RB model, never from the private HLTV
// win-probability pack. A user with the pack derives his own matches with it, and the comparison then
// refuses the model-dependent metrics with a reason (compare.ts notComparable) rather than ranking
// HLTV-derived swing against CS2RB-built quantiles.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { notComparable, type Baselines } from "../../stats/compare";
import { METRICS } from "../../stats/metrics";
import { CS2RB, modelFingerprint } from "../../stats/model-params";
import { emptySummary } from "../../stats/rollup";

const metricDef = (id: string) => METRICS.find((m) => m.id === id);
const shipped = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../public/baselines.json"), "utf8")) as Baselines & { source: string };

describe("the shipped pro baselines", () => {
  it("are built on the public CS2RB model and name no private source", () => {
    // fails if baselines built with the HLTV pack are committed again
    expect(shipped.model).toBe(modelFingerprint(CS2RB));
    expect(JSON.stringify(shipped)).not.toMatch(/hltv/i);
    expect(shipped.source).toMatch(/^\d+ maps from public pro match demos, /);
  });

  it("keep a match derived with the HLTV pack out of the model-dependent comparisons, and only those", () => {
    // fails if swing from one model is ranked against quantiles built with another, or if the gate
    // also blocks metrics that do not depend on the model
    const s = emptySummary();
    s.models = ["hltv-0123abcd-pb88f2902"];
    expect(notComparable(metricDef("swing")!, s, shipped)).toBe("Not compared: the pro pool was built with another rating or win-probability model");
    expect(notComparable(metricDef("kpr")!, s, shipped)).toBeNull();
    s.models = [modelFingerprint(CS2RB)];
    expect(notComparable(metricDef("swing")!, s, shipped)).toBeNull();
  });
});
