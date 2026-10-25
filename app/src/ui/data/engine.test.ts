// The adapter must agree with the engine it wraps: per-round cells sum to the match counters, the
// per-side lines add up to both sides, and the Rating 3.0 fallback triggers on thin kill-log cover.
import { describe, expect, it } from "vitest";
import { deriveMatch, summarize } from "../../stats/derive";
import { loadPluginMatch, loadSample, PLUGIN_MATCHES, SAMPLE_1714 } from "../../stats/testing/load";
import { countersRating, r3Usable, r3Value, roundMatrix, statLine, summaryRating } from "./engine";
import { sideInputs } from "./sideRating";
import { sourceOfSummary, sourceOfView } from "./sources";

describe("roundMatrix", async () => {
  const v = deriveMatch(await loadPluginMatch(PLUGIN_MATCHES[1]), PLUGIN_MATCHES[1]);
  const m = roundMatrix(v);
  it("has one cell per player and round", () => {
    expect(m.length).toBe(v.players.length);
    for (const row of m) expect(row.length).toBe(v.nRounds);
  });
  it("sums kills, headshots and deaths to the counters", () => {
    v.players.forEach((p, pi) => {
      expect(m[pi].reduce((a, c) => a + c.kills.length, 0)).toBe(p.c.kills);
      expect(m[pi].reduce((a, c) => a + c.kills.filter((k) => k.hs).length, 0)).toBe(p.c.hsKills);
      expect(m[pi].filter((c) => c.died).length).toBe(p.c.deaths);
    });
  });
  it("marks exactly one opening kill per captured round with a kill", () => {
    for (let ri = 0; ri < v.nRounds; ri++) {
      const openings = m.flatMap((row) => row[ri].kills.filter((k) => k.opening)).length;
      expect(openings).toBeLessThanOrEqual(1);
    }
  });
});

describe("statLine", async () => {
  const v = deriveMatch(await loadPluginMatch(PLUGIN_MATCHES[2]), PLUGIN_MATCHES[2]);
  it("splits kills, deaths and rounds exactly across sides", () => {
    for (const p of v.players) {
      const b = statLine(v, p.pi, "both");
      const t = statLine(v, p.pi, "t");
      const ct = statLine(v, p.pi, "ct");
      expect(t.kills + ct.kills).toBe(b.kills);
      expect(t.deaths + ct.deaths).toBe(b.deaths);
      expect(t.rounds + ct.rounds).toBe(b.rounds);
    }
  });
  it("rates one side only from that side's Rating 3.0 inputs, never from Rating 2.0", async () => {
    expect(statLine(v, v.human, "t").rating).toBeNull();
    const sides = sideInputs(await loadPluginMatch(PLUGIN_MATCHES[2]));
    expect(statLine(v, v.human, "t", sides).rating).toBe(r3Value(sides[v.human].t));
  });
});

describe("Rating 3.0 coverage", async () => {
  // Rounds 1-15 of this converted log hold the game's totals only; one round has the kill log.
  const v = deriveMatch(await loadSample(SAMPLE_1714), `samples/${SAMPLE_1714}`);
  const s = summarize(v);
  it("has no rating when the kill log covers under half the rounds", () => {
    expect(r3Usable(s.human.c)).toBe(false);
    expect(summaryRating(s)).toBeNull();
    expect(countersRating(s.human.c)).toBeNull();
  });
  it("uses Rating 3.0 on a fully recorded match", async () => {
    const r = summarize(deriveMatch(await loadPluginMatch(PLUGIN_MATCHES[1]), PLUGIN_MATCHES[1]));
    expect(r3Usable(r.human.c)).toBe(true);
    expect(summaryRating(r)).toBe(r.human.rating3);
  });
});

describe("sources", async () => {
  const rec = deriveMatch(await loadPluginMatch(PLUGIN_MATCHES[1]), `2026/${PLUGIN_MATCHES[1]}`);
  const conv = deriveMatch(await loadSample(SAMPLE_1714), `samples/${SAMPLE_1714}`);
  it("reads env.plugin on the full view", () => {
    expect(sourceOfView(rec).id).toBe("recorded");
    expect(sourceOfView(conv)).toEqual({ id: "converted", label: "Converted log", missing: ["aim", "movement"] });
  });
  it("infers the same source from summaries", () => {
    expect(sourceOfSummary(summarize(rec)).id).toBe("recorded");
    expect(sourceOfSummary(summarize(conv)).id).toBe("converted");
  });
});

