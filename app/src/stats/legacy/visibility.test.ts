import { describe, expect, test } from "vitest";
import { aimAggregate, aimVisibility, emptyAim, mergeAim } from "./aim";
import { loadPluginMatch, PLUGIN_MATCHES } from "./testing/load";
import { MatchBuilder } from "./testing/build";
import { candidateSees, emptyEvidence, maskHasBit, mergeEvidence, visibilityEvidence, visibilityVerdict, VISIBILITY_MIN_COVERAGE } from "./visibility";

describe("maskHasBit", () => {
  test("bits 0..31 read word 0 and 32..63 read word 1", () => {
    expect(maskHasBit(0b1, 0, 0)).toBe(true);
    expect(maskHasBit(0b10, 0, 0)).toBe(false);
    expect(maskHasBit(0x8000_0000, 0, 31)).toBe(true);
    expect(maskHasBit(0, 0b10, 33)).toBe(true);
    expect(maskHasBit(0xffff_ffff, 0, 33)).toBe(false);
    expect(maskHasBit(0, 0x8000_0000, 63)).toBe(true);
  });
  test("out-of-range and unknown bits are false", () => {
    expect(maskHasBit(0xffff_ffff, 0xffff_ffff, 64)).toBe(false);
    expect(maskHasBit(0xffff_ffff, 0xffff_ffff, -1)).toBe(false);
    expect(maskHasBit(0xffff_ffff, 0xffff_ffff, null)).toBe(false);
    expect(maskHasBit(0xffff_ffff, 0xffff_ffff, 303)).toBe(false);
  });
});

describe("candidate mappings", () => {
  const env = { plugin: "1.0.0", cssharp: null, game: null, tickrate: 64, maxrounds: 24, botDifficulty: 5, humanSlot: 3, humanController: 4, humanPawn: 250 };
  test("each candidate reads its own bit", () => {
    expect(candidateSees("slot", env, 1 << 3, 0)).toBe(true);
    expect(candidateSees("controller", env, 1 << 4, 0)).toBe(true);
    expect(candidateSees("slotMinus1", env, 1 << 2, 0)).toBe(true);
    expect(candidateSees("slotInWord1", env, 0, 1 << 3)).toBe(true);
    expect(candidateSees("pawn", env, 0xffff_ffff, 0xffff_ffff)).toBe(false);
    expect(candidateSees("anyBit", env, 0, 1)).toBe(true);
    expect(candidateSees("slot", env, 1 << 4, 0)).toBe(false);
  });
});

describe("verdict", () => {
  const ev = (slot: number, inEng: number) => ({ ...emptyEvidence(), bulletHits: 100, seen: { ...emptyEvidence().seen, slot }, hitsInEngagement: inEng });
  test(`validated only when both coverages reach ${VISIBILITY_MIN_COVERAGE * 100}%`, () => {
    expect(visibilityVerdict(ev(90, 90)).validated).toBe(true);
    expect(visibilityVerdict(ev(89, 95)).validated).toBe(false);
    expect(visibilityVerdict(ev(95, 89)).validated).toBe(false);
  });
  test("without hit masks the plugin flag decides", () => {
    expect(visibilityVerdict(null, true).validated).toBe(true);
    expect(visibilityVerdict(null, false).validated).toBe(false);
  });
  test("a builder match without hit masks keeps the plugin flag", () => {
    const b = new MatchBuilder();
    b.shot(0, b.t(0, 5));
    expect(aimAggregate(b.build())!.visibility).toBeNull();
  });
});

describe("evidence from the three plugin 1.0.0 recordings", () => {
  test("hit counts per candidate mapping", async () => {
    const all = emptyEvidence();
    for (const f of PLUGIN_MATCHES) mergeEvidence(all, visibilityEvidence(await loadPluginMatch(f))!);
    expect(all).toEqual({
      hitRows: 104, bulletHits: 93,
      // slot = the plugin's current bit; controller is also slot + 1; pawn index 303 is outside the 64-bit mask
      seen: { slot: 53, controller: 0, slotMinus1: 0, pawn: 0, slotInWord1: 0, anyBit: 57 },
      foreignBits: 0, hitsInEngagement: 53, hitShots: 83, hitShotsVisible: 50,
      engagements: 61, shotBeforeVisible: 24, damagedBeforeVisible: 10,
    });
    const v = visibilityVerdict(all);
    expect(v.validated).toBe(false);
    expect(v.hitCoverage).toBeCloseTo(53 / 93, 12);
  });

  test("the merged aim stays gated and carries the evidence", async () => {
    let agg = emptyAim();
    for (const f of PLUGIN_MATCHES) agg = mergeAim(agg, aimAggregate(await loadPluginMatch(f))!);
    expect(agg.validated).toBe(false);
    expect(agg.visibility!.bulletHits).toBe(93);
    expect(aimVisibility(agg).reason).toMatch(/57% of your 93 hits/);
  });
});
