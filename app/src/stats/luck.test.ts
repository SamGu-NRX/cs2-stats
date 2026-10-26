// Luck (luck.ts) on known answers: the hit-chance model's closed forms, and hand-built rounds at 64
// ticks per second for every count. a is CT, b and c are T unless a test says otherwise.
import { describe, expect, it } from "vitest";
import { compare, type Baselines, buildPools } from "./compare";
import { calibrated, hitChance } from "./luck";
import { METRIC, METRICS } from "./metrics";
import { rollup } from "./rollup";
import { FREEZE_END, oneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;

describe("the hit-chance model", () => {
  it("is certain without a cone, inside or outside the target", () => {
    // fails if a zero cone does not land exactly on the aim point
    expect(hitChance(0, 0, 0.01, 0, 0.02, 0.02)).toBe(1);
    expect(hitChance(0, 0, 0.03, 0, 0.02, 0.02)).toBe(0);
  });

  it("matches the closed form for a centred strip half the cone's width", () => {
    // fails if the radius is drawn by area rather than uniformly, or the grid is too coarse: with
    // r = I u, the chance |r cos(theta)| <= I / 2 is (2 / pi) (ln(2 + sqrt 3) / 2 + pi / 6), about 0.7525
    const exact = (2 / Math.PI) * (Math.log(2 + Math.sqrt(3)) / 2 + Math.PI / 6);
    expect(Math.abs(hitChance(0.04, 0, 0, 0, 0.02, 10) - exact)).toBeLessThan(0.01);
  });

  it("calibrates a chance through the logistic map, clamping certainties first", () => {
    // fails if the map's sign, slope or clamp changes: logit(0.5) = 0, so a = 1, b = 2 gives 1 / (1 + e^-1);
    // a certain miss is clamped to 0.001 before the identity map
    expect(calibrated(0.5, { a: 1, b: 2 })).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    expect(calibrated(0, { a: 0, b: 1 })).toBeCloseTo(0.001, 12);
  });

  it("is certain when the whole cone fits inside the target", () => {
    // fails if the spread term pushes a bullet out of a target wider than inaccuracy plus spread
    expect(hitChance(0.01, 0.002, 0, 0, 0.013, 0.013)).toBe(1);
  });
});

describe("kills and deaths", () => {
  const shot = (tick: number, extra: Record<string, unknown>) => ({ tick, steamid: "a", weapon: "ak47", ...extra });

  it("counts run-and-gun kills by the killing shot's speed, and skips kills without that shot", () => {
    // fails if the AK's limit (34% of 215 = 73.1 u/s) moves, or a kill with no shot on its tick counts
    const f = oneRound({
      players: { a: "CT", b: "T", c: "T", d: "T" },
      kills: [{ tick: t(1), killer: "a", victim: "b" }, { tick: t(2), killer: "a", victim: "c" }, { tick: t(3), killer: "a", victim: "d" }],
      shots: [shot(t(1), { speed_2d: 200, scoped: false }), shot(t(2), { speed_2d: 50, scoped: false })],
    });
    expect(METRIC.runAndGunKills.value(rollup([f], { player: "a" }))).toBe(50);
    expect(rollup([f], { player: "a" }).m).toMatchObject({ gunKills: 3, rgKnown: 2, rgKills: 1 });
    expect([METRIC.runAndGunDeaths.value(rollup([f], { player: "b" })), METRIC.runAndGunDeaths.value(rollup([f], { player: "d" }))]).toEqual([100, null]);
  });

  it("calls a headshot lucky from the killing shot's inaccuracy, and skips one with none recorded", () => {
    // fails if the 0.05 cone moves, a body shot counts, or an unknown cone counts as not lucky
    const hs = { headshot: true };
    const f = oneRound({
      players: { a: "CT", b: "T", c: "T", d: "T" },
      kills: [{ tick: t(1), killer: "a", victim: "b", at: hs }, { tick: t(2), killer: "a", victim: "c", at: hs }, { tick: t(3), killer: "a", victim: "d", at: hs }],
      shots: [shot(t(1), { inaccuracy: 0.06 }), shot(t(2), { inaccuracy: 0.01 }), shot(t(3), { inaccuracy: null })],
    });
    expect(rollup([f], { player: "a" }).m).toMatchObject({ hsGunKills: 3, lhKnown: 2, lhKills: 1 });
    expect(METRIC.luckyHeadshots.value(rollup([f], { player: "a" }))).toBe(50);
    expect(METRIC.luckyHeadshotDeaths.value(rollup([f], { player: "b" }))).toBe(100);
  });

  it("counts flag kills only where all four flags are recorded", () => {
    // fails if a kill with a null flag counts, or a flag lands on the wrong count
    const flags = (blind: boolean | null, air: boolean, noscope: boolean, smoke: boolean) => ({ attackerblind: blind, attackerinair: air, noscope, thrusmoke: smoke });
    const f = oneRound({
      players: { a: "CT", b: "T", c: "T", d: "T" },
      kills: [
        { tick: t(1), killer: "a", victim: "b", at: flags(true, false, false, false) },
        { tick: t(2), killer: "a", victim: "c", at: flags(false, false, false, true) },
        { tick: t(3), killer: "a", victim: "d", at: flags(null, true, false, false) },
      ],
    });
    const s = rollup([f], { player: "a" });
    expect([s.m.flagsKnown, METRIC.blindKills.value(s), METRIC.smokeKills.value(s), METRIC.airKills.value(s)]).toEqual([2, 50, 50, 0]);
    expect([METRIC.flagDeaths.value(rollup([f], { player: "b" })), METRIC.flagDeaths.value(rollup([f], { player: "d" }))]).toEqual([100, null]);
  });

  it("counts close calls on 5 health or less, and duels won or lost on 20 or less, per 24 rounds", () => {
    // fails if the cuts move or health is read from the wrong player: a ends the round on 4 health
    // (survived: a close call, 24 per 24 rounds); d, on 15 after c's 85 damage, kills c and b (48)
    const hit = (tick: number, attacker: string, victim: string, dmg: number) => ({ tick, attacker_steamid: attacker, victim_steamid: victim, weapon: "ak47", dmg_health: dmg, dmg_health_capped: dmg, health_before: null, health_after: null });
    const f = oneRound({
      players: { a: "CT", d: "CT", b: "T", c: "T" },
      damages: [hit(t(1), "b", "a", 96), hit(t(2), "c", "d", 85)],
      kills: [{ tick: t(3), killer: "d", victim: "c" }, { tick: t(4), killer: "d", victim: "b" }],
    });
    expect([METRIC.closeCalls.value(rollup([f], { player: "a" })), METRIC.closeCalls.value(rollup([f], { player: "d" }))]).toEqual([24, 0]);
    expect(METRIC.lowHpKills.value(rollup([f], { player: "d" }))).toBe(48);
    expect([METRIC.lowHpDeaths.value(rollup([f], { player: "b" })), METRIC.lowHpDeaths.value(rollup([f], { player: "c" }))]).toEqual([24, 24]);
  });
});

describe("spread luck", () => {
  // a's eye at (0, 0, 64) looks along +x at b, standing at x = 1,000 with his eye at 64: b's box runs
  // from the feet to 70, so its centre is 35 up and 29 below a's eye
  const pitch = (Math.atan(29 / 1000) * 180) / Math.PI;
  const round = oneRound({
    players: { a: "CT", b: "T" },
    engagements: [{ engagement_id: 0, attacker_steamid: "a", victim_steamid: "b", start_tick: t(1), end_tick: t(3), first_visible_tick: t(1) }],
    engagement_ticks: [t(1), t(2), t(3)].flatMap((tick) => [{
      engagement_id: 0, tick, a_x: 0, a_y: 0, a_z: 0, a_eye_z: 64, a_pitch: 0, a_yaw: 0, v_x: 1000, v_y: 0, v_z: 0, v_eye_z: 64, mesh_visible: true, smoke_blocked: false,
    }]),
    shots: [t(1), t(2)].map((tick, j) => ({
      tick, steamid: "a", weapon: "ak47", inaccuracy: 0, spread: 0, eye_x: 0, eye_y: 0, eye_z: 64, bullet_pitch: pitch, bullet_yaw: j === 0 ? 0 : 5,
    })),
    // both shots hit: the first on the box's centre with no cone (a sure hit), the second 5 degrees wide
    damages: [t(1), t(2)].map((tick) => ({ tick, attacker_steamid: "a", victim_steamid: "b", weapon: "ak47", dmg_health: 20, dmg_health_capped: 20, health_after: null })),
  });

  it("scores each shot's hit against its chance, for the shooter and against the target", () => {
    // fails if the chance, the target or the sign convention is wrong: a's first shot is a geometric
    // certainty (no cone, on the box's centre) and the second a certain miss (5 degrees wide); both hit,
    // so a's luck is 2 minus their calibrated chances, over one round, and b has the same against him
    const a = rollup([round], { player: "a" }), b = rollup([round], { player: "b" });
    const expected = calibrated(1) + calibrated(0);
    expect(a.m).toMatchObject({ luckShots: 2, luckHits: 2 });
    expect(a.m.luckExp).toBeCloseTo(expected, 12);
    expect(METRIC.luckHits.value(a)).toBeCloseTo(24 * (2 - expected), 9);
    expect(METRIC.luckScore.value(a)).toBeCloseTo(24 * (2 - expected), 9);
    expect(METRIC.luckAgainst.value(b)).toBeCloseTo(24 * (2 - expected), 9);
    expect(METRIC.luckScore.value(b)).toBeCloseTo(-24 * (2 - expected), 9);
  });

  it("gives no value without the cone or line of sight, and never a pro percentile", () => {
    // fails if a plugin match (no engagements, no cone) gets a luck value, or luck is ranked against pros
    const plugin = oneRound({ players: { a: "CT", b: "T" }, shots: [{ tick: t(1), steamid: "a", weapon: "ak47" }] });
    const pools = { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(0)])) } };
    const pros: Baselines = { version: 1, built: "x", source: "t", model: plugin.match.model, n: {}, pools: { ...pools, rifler: pools.all } };
    expect(compare(rollup([plugin], { player: "a" }), pros).luckScore).toMatchObject({ value: null, pct: null, reason: "Not compared: shot spread and line of sight known for 0 of 1 rounds" });
    expect(compare(rollup([round], { player: "a" }), pros).luckScore).toMatchObject({ pct: null, reason: "Not compared: for fun, with no pro percentile" });
    const units = Array.from({ length: 8 }, () => ({ pools: ["all"], side: "both" as const, s: rollup([round], { player: "a" }) }));
    expect(buildPools(units).pools.all.both!.luckScore).toBeNull();
  });
});
