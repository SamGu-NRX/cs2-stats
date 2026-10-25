import { describe, expect, test } from "vitest";
import { engFor } from "./aim";
import { deriveMatch, summarize, type MatchSummary } from "./derive";
import { buildProfile } from "./profile";
import { validateMatch } from "./schema";
import { syntheticMatch } from "./testing/synthetic";

describe("full-data match (synthetic)", () => {
  test("validates, derives every view, and keeps the score consistent", () => {
    const m = validateMatch(JSON.parse(JSON.stringify(syntheticMatch(3))), "synthetic");
    const v = deriveMatch(m, "synthetic");
    expect(v.score.us + v.score.them).toBe(24);
    expect(v.aim).not.toBeNull();
    expect(engFor(v.aim!, "all").n).toBe(72);
    expect(v.hasPos).toBe(true);
    expect(Object.keys(v.pos.places).length).toBeGreaterThan(3);
    const h = v.players[0];
    expect(h.c.rounds).toBe(24);
    expect(h.swingPerRound).not.toBeNull();
    // swing credits balance: what one side gains the other loses, per kill
    for (const r of v.rounds) for (const k of r.kills) {
      if (!k.credits.length) continue;
      expect(k.credits.reduce((a, [, c]) => a + c, 0)).toBeCloseTo(0, 9);
    }
  });
});

describe("performance", () => {
  test("profile over 1,000 matches stays fast", () => {
    const base = summarize(deriveMatch(syntheticMatch(5), "s"));
    const { pos: _pos, ...light } = base;
    void _pos;
    const many: Omit<MatchSummary, "pos">[] = Array.from({ length: 1000 }, (_, i) => ({
      ...structuredClone(light),
      file: `m${i}`,
      startUtc: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
      bots: light.bots.map((b) => ({ ...b, key: `${b.key}${i % 40}` })),
    }));
    const t0 = performance.now();
    const p = buildProfile(many);
    const ms = performance.now() - t0;
    expect(p!.matches).toBe(1000);
    expect(p!.attributes.provisional).toBe(false); // 360 bot careers with 150+ rounds
    // Budget for one profile build in the worker; the UI stays responsive regardless.
    expect(ms).toBeLessThan(500);
    console.log(`profile over 1,000 matches: ${ms.toFixed(0)} ms`);
  });
  test("deriving one full 24-round match", () => {
    const m = syntheticMatch(9);
    const t0 = performance.now();
    deriveMatch(m, "s");
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(200);
    console.log(`derive one full match: ${ms.toFixed(1)} ms`);
  });
});
