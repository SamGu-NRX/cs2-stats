// Strict role answers for synthetic summaries. These tests pin the public API and the no-Mixed taxonomy.
import { expect, it } from "vitest";
import { overallRole, roleBlend } from "./identity";
import { emptySummary } from "./rollup";

function summary(overrides: Record<string, number> = {}) {
  const s = emptySummary();
  Object.assign(s.m, {
    rounds: 100,
    loadoutRounds: 100,
    roundsWithAwp: 0,
    deaths: 30,
    kills: 40,
    deathTimeSum: 1500,
    openingKills: 10,
    openingDeaths: 10,
    tradeKills: 8,
    assists: 4,
    tradedDeaths: 8,
    spacingSamples: 100,
    adntRank: 50,
    adatRank: 50,
    nearestDistSum: 80000,
    smokes: 80,
    flashes: 80,
    hes: 20,
    molotovs: 20,
    ...overrides,
  });
  s.aggression.contactRounds = 100;
  s.aggression.contactSecs = 4200;
  s.aggression.pushRounds = 100;
  s.aggression.pushSum = 50;
  return s;
}

it("returns a real T role with probability, distribution, evidence rows, and tips", () => {
  const r = roleBlend(summary({ openingKills: 30, openingDeaths: 5 }), "T");
  expect(r.primary).toBe("Entry");
  expect(r.probability).toBeGreaterThan(0.45);
  expect(r.distribution).toBeTruthy();
  expect(Object.keys(r.distribution!)).not.toContain("Mixed");
  expect(Object.keys(r.distribution!)).not.toContain("Half-lurker");
  expect(r.metrics.map((m) => m.id)).toEqual([
    "openingAttempts", "tradeKills", "tradeAssistShare", "utilityPR", "teamDistance",
    "firstContactTime", "pushDepth", "sitePresence", "areaChanges", "awpShare",
  ]);
  expect(r.tips.Entry.split(/\s+/).length).toBeLessThanOrEqual(12);
});

it("returns a single CT role when one role clears confidence", () => {
  const r = roleBlend(summary(), "CT");
  expect(r.primary).toBe("Rotator");
  expect(r.probability).toBeGreaterThan(0.45);
  expect(r.primary).not.toContain("Mixed");
});

it("keeps AWPer evidence separate from unknown loadouts", () => {
  const known = roleBlend(summary({ roundsWithAwp: 80 }), "T");
  expect(known.awp).toBe(0.8);
  expect(known.distribution?.AWPer).toBeGreaterThan(0);

  const unknown = summary({ loadoutRounds: 0, roundsWithAwp: 0 });
  const r = roleBlend(unknown, "T");
  expect(r.awp).toBeNull();
  expect(r.evidence[0]).toContain("unknown");
});

it("weights overall roles by side rounds and exposes its primary", () => {
  const t = roleBlend(summary({ rounds: 30, openingKills: 25, openingDeaths: 0 }), "T");
  const ct = roleBlend(summary({ rounds: 10, openingKills: 0, openingDeaths: 2 }), "CT");
  const all = overallRole(t, ct);
  expect(all.primary).toBeTruthy();
  expect(all.distribution).toBeTruthy();
  expect(all.rounds).toEqual({ T: 30, CT: 10 });
});
