// Known-answer tests use fixed models so a corpus refit cannot change the expected contract.
import { expect, it } from "vitest";
import { FEATURES, overallRole, roleBlend, roleDecision, ROLE_SIGNALS, type RoleModel, type RoleName } from "./identity";
import { roleHigh, ROLE_THRESHOLDS, type RoleMetricId } from "./role-thresholds";
import { emptySummary } from "./rollup";

function summary(overrides: Record<string, number> = {}) {
  const s = emptySummary();
  Object.assign(s.m, {
    rounds: 100, loadoutRounds: 100, roundsWithAwp: 0, deaths: 30, kills: 40,
    deathTimeSum: 1500, openingKills: 10, openingDeaths: 10, tradeKills: 8, assists: 4,
    tradedDeaths: 8, spacingSamples: 100, adntRank: 50, adatRank: 50, nearestDistSum: 80000,
    smokes: 80, flashes: 80, hes: 20, molotovs: 20, ...overrides,
  });
  Object.assign(s.aggression, { contactRounds: 100, contactSecs: 4200, pushRounds: 100, pushSum: 50 });
  return s;
}
const fit = { n: 10, mean: [50, 20, 25, 20, 0.5, 0.5], sd: [10, 10, 10, 10, 0.2, 0.2] };
const MODEL: RoleModel = { source: "equal-class synthetic fixture", features: [...FEATURES], sides: { T: { n: 20, roles: { Entry: fit, Lurker: fit } }, CT: { n: 20, roles: { Anchor: fit, Rotator: fit } } } };
const distribution = (entries: Partial<Record<RoleName, number>>) => entries as Record<RoleName, number>;

it("returns the complete side taxonomy and shared evidence contract", () => {
  for (const side of ["T", "CT"] as const) {
    const r = roleBlend(summary(), side, MODEL);
    expect(Object.keys(r.distribution!).sort()).toEqual((side === "T" ? ["Entry", "Trader", "Support", "Lurker", "AWPer"] : ["Anchor", "Rotator", "Aggressor", "Support", "AWPer"]).sort());
    expect(r.blend).toBe(r.distribution);
    expect(r.metrics.map((m) => m.id)).toEqual(["openingAttempts", "tradeKills", "tradeAssistShare", "utilityPR", "teamDistance", "firstContactTime", "pushDepth", "sitePresence", "areaChanges", "awpShare"]);
    for (const metric of r.metrics) {
      const source = ROLE_THRESHOLDS[metric.id as RoleMetricId];
      expect(metric.proRange).toEqual(source.proRange);
      expect(metric.threshold).toBe(source.threshold);
      expect(metric.unit).toBe(source.unit);
    }
    for (const tip of Object.values(r.tips)) expect(tip.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(Object.values(r.distribution!).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  }
});

it("enforces the 30-round, 0.60 probability and 0.15 margin decision gates", () => {
  const p = distribution({ Entry: 0.6, Lurker: 0.4 });
  expect(roleDecision(p, 30)).toEqual({ primary: "Entry", probability: 0.6, top2: null, reason: null });
  expect(roleDecision(p, 29)).toMatchObject({ primary: null, probability: null, top2: null, reason: expect.stringContaining("30") });
  expect(roleDecision(distribution({ Entry: 0.599, Lurker: 0.401 }), 100)).toMatchObject({ primary: null, probability: null, top2: ["Entry", "Lurker"] });
  expect(roleDecision(distribution({ Entry: 0.5, Lurker: 0.5 }), 100)).toMatchObject({ primary: null, top2: ["Entry", "Lurker"] });
  // For normalized distributions 0.60 already implies a >=0.20 margin. Pin the explicit
  // margin guard as well so a future probability-gate change cannot silently remove it.
  expect(roleDecision(distribution({ Entry: 0.61, Lurker: 0.5 }), 100).primary).toBeNull();
  const small = roleBlend(summary({ rounds: 29 }), "T", MODEL);
  expect(small.primary).toBeNull();
  expect(small.top2).toBeNull();
  expect(small.reason).toContain("30");
  expect(roleBlend(emptySummary(), "T", MODEL).reason).toContain("30");
});

it("fixes the AWP component at its measured share on both sides, even after calibration", () => {
  const model: RoleModel = { ...MODEL, calibration: {
    T: { Entry: [{ x: 0, y: 0.2 }, { x: 1, y: 0.9 }], AWPer: [{ x: 0, y: 0 }] },
    CT: { Anchor: [{ x: 0, y: 0.2 }, { x: 1, y: 0.9 }], AWPer: [{ x: 0, y: 0 }] },
  } };
  for (const side of ["T", "CT"] as const) for (const awp of [0, 0.2, 0.5, 0.8, 1]) {
    const r = roleBlend(summary({ roundsWithAwp: awp * 50, loadoutRounds: 50 }), side, model);
    expect(r.awp).toBe(awp);
    expect(r.distribution!.AWPer).toBe(awp);
    expect(Object.entries(r.distribution!).filter(([role]) => role !== "AWPer").reduce((sum, [, value]) => sum + value, 0)).toBeCloseTo(1 - awp);
    if (awp >= 0.8) expect(r.primary).toBe("AWPer");
  }
  const unknown = roleBlend(summary({ loadoutRounds: 0 }), "T", model);
  expect(unknown.awp).toBeNull();
  expect(unknown.evidence[0]).toContain("unknown");
});

it("applies calibration in the same path as the softmax rules", () => {
  const s = summary({ roundsWithAwp: 20 });
  const constant = [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }];
  const model: RoleModel = { ...MODEL, calibration: { T: { Entry: constant, Trader: constant, Support: constant, Lurker: constant }, CT: {} } };
  const r = roleBlend(s, "T", model);
  expect(r.distribution).toEqual({ Entry: 0.2, Trader: 0.2, Support: 0.2, Lurker: 0.2, AWPer: 0.2 });
  expect(r.primary).toBeNull();
  expect(r.top2).toEqual(["Entry", "Trader"]);
  expect(roleBlend(s, "T", MODEL).distribution).not.toEqual(r.distribution);
});

it("uses each displayed tick as its classification midpoint and records the 3D range", () => {
  for (const id of Object.keys(ROLE_THRESHOLDS) as RoleMetricId[]) {
    const spec = ROLE_THRESHOLDS[id];
    if (spec.threshold === null) continue;
    expect(spec.thresholdSource).toBe("hand-chosen");
    expect(roleHigh(id, spec.threshold)).toBe(0.5);
    expect(roleHigh(id, spec.threshold + 1)).toBeGreaterThan(0.5);
    expect(roleHigh(id, null)).toBe(0.5);
  }
  expect(ROLE_THRESHOLDS.teamDistance.proRange![1]).toBeCloseTo(881.2666073212856);
  expect(ROLE_THRESHOLDS.teamDistance.threshold).toBe(1100);
  for (const signal of ROLE_SIGNALS) expect(signal.threshold).toBe(ROLE_THRESHOLDS[signal.metric as RoleMetricId].threshold);
});

it("sums shared overall role names using side-round weights", () => {
  const t = roleBlend(summary({ rounds: 90, roundsWithAwp: 80 }), "T", MODEL);
  const ct = roleBlend(summary({ rounds: 30, roundsWithAwp: 40 }), "CT", MODEL);
  const all = overallRole(t, ct);
  expect(all.rounds).toEqual({ T: 90, CT: 30 });
  expect(all.distribution!.AWPer).toBeCloseTo(0.7);
  expect(all.primary).toBe("AWPer");
  expect(all.probability).toBeCloseTo(0.7);
  expect(all.top2).toBeNull();
  expect(all.distribution!.Support).toBeCloseTo(t.distribution!.Support * 0.75 + ct.distribution!.Support * 0.25);
});
