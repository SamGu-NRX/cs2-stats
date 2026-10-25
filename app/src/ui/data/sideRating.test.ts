// Fails if T and CT stop partitioning the engine's own Rating 3.0 inputs, which is what made the
// profile show both sides above the overall rating.
import { describe, expect, it } from "vitest";
import { deriveMatch } from "../../stats/derive";
import { rating3 } from "../../stats/rating3";
import { loadPluginMatch, PLUGIN_MATCHES } from "../../stats/testing/load";
import { addR3, sideInputs } from "./sideRating";
import { winProbabilityCT } from "@model/winprob";
import { modelFromModule, stubModel } from "../../stats/winprob";

// the model sideInputs uses: the bundled one when present
const model = winProbabilityCT !== undefined ? modelFromModule(winProbabilityCT) : stubModel;

describe("sideInputs", () => {
  it("splits every player's Rating 3.0 inputs into T and CT exactly", async () => {
    const m = await loadPluginMatch(PLUGIN_MATCHES[1]);
    const v = deriveMatch(m, PLUGIN_MATCHES[1], model);
    const sides = sideInputs(await loadPluginMatch(PLUGIN_MATCHES[1]));
    v.players.forEach((p, pi) => {
      const sum = addR3(sides[pi].t, sides[pi].ct);
      expect(sum.rounds).toBe(p.c.r3.rounds);
      expect(sum.kills).toBe(p.c.r3.kills);
      expect(sum.deaths).toBe(p.c.r3.deaths);
      expect(sum.ecoKills).toBeCloseTo(p.c.r3.ecoKills, 9);
      expect(sum.swing).toBeCloseTo(p.c.r3.swing, 9);
      const [t, ct, all] = [rating3(sides[pi].t).value, rating3(sides[pi].ct).value, rating3(sum).value];
      if (t !== null && ct !== null && all !== null) {
        expect(all).toBeGreaterThanOrEqual(Math.min(t, ct) - 1e-9);
        expect(all).toBeLessThanOrEqual(Math.max(t, ct) + 1e-9);
      }
    });
  });
});
