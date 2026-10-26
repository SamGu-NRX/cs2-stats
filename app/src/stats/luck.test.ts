// Luck (luck.ts) on known answers: the hit-chance model's closed forms, and hand-built rounds at 64
// ticks per second for every count. a is CT, b and c are T unless a test says otherwise.
import { describe, expect, it } from "vitest";
import { compare, type Baselines, buildPools } from "./compare";
import { aimBasis, calibrated, hitChance, projectBox, type ShotGeom } from "./luck";
import { accurateSpeed } from "./speed";
import { METRIC, METRICS } from "./metrics";
import { rollup } from "./rollup";
import { FREEZE_END, oneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;

/** An axis-aligned box on the aim plane, as projectBox gives one: centre (x, y), half-sizes (w, h). */
const rect = (x: number, y: number, w: number, h: number): [number, number][] => [[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]];

describe("the hit-chance model", () => {
  it("is certain without a cone, inside or outside the target", () => {
    // fails if a zero cone does not land exactly on the aim point
    expect(hitChance(0, 0, rect(0.01, 0, 0.02, 0.02))).toBe(1);
    expect(hitChance(0, 0, rect(0.03, 0, 0.02, 0.02))).toBe(0);
  });

  it("matches the closed form for a centred strip half the cone's width", () => {
    // fails if the radius is drawn by area rather than uniformly, or the grid is too coarse: with
    // r = I u, the chance |r cos(theta)| <= I / 2 is (2 / pi) (ln(2 + sqrt 3) / 2 + pi / 6), about 0.7525
    const exact = (2 / Math.PI) * (Math.log(2 + Math.sqrt(3)) / 2 + Math.PI / 6);
    expect(Math.abs(hitChance(0.04, 0, rect(0, 0, 0.02, 10)) - exact)).toBeLessThan(0.01);
  });

  it("calibrates a chance through the logistic map, clamping certainties first", () => {
    // fails if the map's sign, slope or clamp changes: logit(0.5) = 0, so a = 1, b = 2 gives 1 / (1 + e^-1);
    // a certain miss is clamped to 0.001 before the identity map
    expect(calibrated(0.5, { a: 1, b: 2 })).toBeCloseTo(1 / (1 + Math.exp(-1)), 12);
    expect(calibrated(0, { a: 0, b: 1 })).toBeCloseTo(0.001, 12);
  });

  it("is certain when the whole cone fits inside the target", () => {
    // fails if the spread term pushes a bullet out of a target wider than inaccuracy plus spread
    expect(hitChance(0.01, 0.002, rect(0, 0, 0.013, 0.013))).toBe(1);
  });
});

describe("the projection onto the aim plane", () => {
  const geom = (pitch: number, yaw: number, c: [number, number, number], halfH: number): ShotGeom => {
    const flat = Math.hypot(c[0], c[1]);
    return { ...aimBasis(pitch, yaw), c, w: [-c[1] / flat, c[0] / flat, 0], halfH };
  };

  it("divides the box by its depth along the aim, in the cone's own units", () => {
    // fails if the box is sized by straight-line distance or offsets are angles: a box 1,000 ahead and
    // 29 below the eye, 13 to each side and 35 up and down, spans x +-0.013 and y -0.064 to 0.006
    const box = projectBox(geom(0, 0, [1000, 0, -29], 35), 1)!;
    expect(box.map(([x, y]) => [+x.toFixed(12), +y.toFixed(12)])).toEqual([[0.013, -0.064], [-0.013, -0.064], [-0.013, 0.006], [0.013, 0.006]]);
  });

  it("puts a target 20 degrees off the aim at tan 20 degrees, not 20 degrees in radians", () => {
    // fails if an angular offset (0.349) stands in for the tangent-plane one (0.364) the cone is measured in
    const c: [number, number, number] = [1000 * Math.cos(20 * (Math.PI / 180)), 1000 * Math.sin(20 * (Math.PI / 180)), 0];
    for (const [x, y] of projectBox(geom(0, 0, c, 35), 1e-9)!) {
      expect(x).toBeCloseTo(-Math.tan(20 * (Math.PI / 180)), 9);
      expect(y).toBeCloseTo(0, 9);
    }
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

  it("leaves the run-and-gun state unknown for a scoped gun whose scope state is not recorded", () => {
    // fails if an AWP shot with no scope flag is judged against the unscoped limit: 34% of the AK's 215 is
    // 73.1 whatever the flag says, the AWP's limit needs it
    expect(accurateSpeed("ak47", null)).toBeCloseTo(0.34 * 215, 9);
    expect(accurateSpeed("awp", null)).toBeNull();
    const f = oneRound({
      players: { a: "CT", b: "T" },
      kills: [{ tick: t(1), killer: "a", victim: "b", at: { weapon: "awp" } }],
      shots: [{ tick: t(1), steamid: "a", weapon: "awp", speed_2d: 150, scoped: null }],
    });
    expect(rollup([f], { player: "a" }).m).toMatchObject({ gunKills: 1 });
    expect(rollup([f], { player: "a" }).m.rgKnown ?? 0).toBe(0);
    expect(METRIC.runAndGunKills.value(rollup([f], { player: "a" }))).toBeNull();
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
  // a's eye at (0, 0, 64) looks along +x. Every target stands with his feet at z 0 and his eye at 64, so his
  // box runs to 70 and its centre is 35 up: 29 below a's eye.
  const tick = { a_x: 0, a_y: 0, a_z: 0, a_eye_z: 64, a_pitch: 0, a_yaw: 0, v_z: 0, v_eye_z: 64, mesh_visible: true, smoke_blocked: false };
  const deg = 180 / Math.PI;
  /** the aim from a's eye at a target's box centre at (x, y) */
  const at = (x: number, y: number) => ({ bullet_pitch: Math.atan(29 / Math.hypot(x, y)) * deg, bullet_yaw: Math.atan2(y, x) * deg });
  const shot = (s: number, aim: Record<string, number>, extra: Record<string, unknown> = {}) =>
    ({ tick: t(s), steamid: "a", weapon: "ak47", inaccuracy: 0, spread: 0, eye_x: 0, eye_y: 0, eye_z: 64, ...aim, ...extra });
  const hit = (s: number, victim: string) => ({ tick: t(s), attacker_steamid: "a", victim_steamid: victim, weapon: "ak47", dmg_health: 20, dmg_health_capped: 20, health_after: null });
  /** a round where a sees each target at (x, y) from 1 s to 3 s, with these shots and hits */
  const round = (targets: Record<string, [number, number]>, shots: Record<string, unknown>[], damages: Record<string, unknown>[]) => {
    const ids = Object.keys(targets);
    return oneRound({
      players: { a: "CT", ...Object.fromEntries(ids.map((id) => [id, "T" as const])) },
      engagements: ids.map((v, e) => ({ engagement_id: e, attacker_steamid: "a", victim_steamid: v, start_tick: t(1), end_tick: t(3), first_visible_tick: t(1) })),
      engagement_ticks: ids.flatMap((v, e) => [t(1), t(2), t(3)].map((tk) => ({ engagement_id: e, tick: tk, ...tick, v_x: targets[v][0], v_y: targets[v][1] }))),
      shots, damages,
    });
  };
  const sure = calibrated(1), miss = calibrated(0);

  it("scores each shot's hit against its chance, for the shooter and against the target", () => {
    // fails if the chance, the target or the sign convention is wrong: a's first shot is a geometric
    // certainty (no cone, on the box's centre) and the second a certain miss (5 degrees wide); both hit,
    // so a's luck is 2 minus their calibrated chances, over one round, and b has the same against him
    const f = round({ b: [1000, 0] }, [shot(1, at(1000, 0)), shot(2, { ...at(1000, 0), bullet_yaw: 5 })], [hit(1, "b"), hit(2, "b")]);
    const a = rollup([f], { player: "a" }), b = rollup([f], { player: "b" });
    expect(a.m).toMatchObject({ luckShots: 2, luckHits: 2 });
    expect(a.m.luckExp).toBeCloseTo(sure + miss, 12);
    expect(METRIC.luckHits.value(a)).toBeCloseTo(24 * (2 - sure - miss), 9);
    expect(METRIC.luckScore.value(a)).toBeCloseTo(24 * (2 - sure - miss), 9);
    expect(METRIC.luckAgainst.value(b)).toBeCloseTo(24 * (2 - sure - miss), 9);
    expect(METRIC.luckScore.value(b)).toBeCloseTo(-24 * (2 - sure - miss), 9);
  });

  it("scores a shot against the visible target nearest its aim, with two in view", () => {
    // fails if the target is not the one the shot aimed at: b straight ahead, c 300 to the left; the
    // shot at b and the shot at c each count once, against its own target, and both hit
    const f = round({ b: [1000, 0], c: [1000, 300] }, [shot(1, at(1000, 0)), shot(2, at(1000, 300))], [hit(1, "b"), hit(2, "c")]);
    for (const id of ["b", "c"]) expect(rollup([f], { player: id }).m, id).toMatchObject({ luckAgShots: 1, luckAgHits: 1 });
    expect(rollup([f], { player: "a" }).m.luckExp).toBeCloseTo(2 * sure, 12);
  });

  it("counts a target 29 degrees off the aim and leaves one 31 degrees off out", () => {
    // fails if the 30-degree gate moves or is applied to the angle in the wrong units
    const off = (d: number) => [1000, 1000 * Math.tan(d / deg)] as [number, number];
    const shots = (d: number) => rollup([round({ b: off(d) }, [shot(1, { bullet_pitch: 0, bullet_yaw: 0 })], [])], { player: "a" }).m.luckShots ?? 0;
    expect([shots(29), shots(31)]).toEqual([1, 0]);
  });

  it("gives one hit to one shot when two shot rows share a tick", () => {
    // fails if a single hit counts for both rows of its tick; with two hits on that tick each row gets one
    const two = [shot(1, at(1000, 0)), shot(1, at(1000, 0))];
    expect(rollup([round({ b: [1000, 0] }, two, [hit(1, "b")])], { player: "a" }).m).toMatchObject({ luckShots: 2, luckHits: 1 });
    expect(rollup([round({ b: [1000, 0] }, two, [hit(1, "b"), hit(1, "b")])], { player: "a" }).m).toMatchObject({ luckShots: 2, luckHits: 2 });
  });

  it("leaves a round with a shot missing an input unknown, not zero", () => {
    // fails if a shot without its aim yaw (or any other input) is skipped and the round scored as covered
    const f = round({ b: [1000, 0] }, [shot(1, at(1000, 0)), shot(2, at(1000, 0), { bullet_yaw: null })], [hit(1, "b")]);
    const a = rollup([f], { player: "a" });
    expect([a.m.spreadRounds ?? 0, a.m.luckShots ?? 0]).toEqual([0, 0]);
    expect([METRIC.luckHits.value(a), METRIC.luckScore.value(a), METRIC.luckAgainst.value(rollup([f], { player: "b" }))]).toEqual([null, null, null]);
  });

  it("gives no value without the cone or line of sight, and never a pro percentile", () => {
    // fails if a plugin match (no engagements, no cone) gets a luck value, or luck is ranked against pros
    const plugin = oneRound({ players: { a: "CT", b: "T" }, shots: [{ tick: t(1), steamid: "a", weapon: "ak47" }] });
    const covered = round({ b: [1000, 0] }, [shot(1, at(1000, 0))], [hit(1, "b")]);
    const pools = { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(0)])) } };
    const pros: Baselines = { version: 1, built: "x", source: "t", model: plugin.match.model, n: {}, pools: { ...pools, rifler: pools.all } };
    expect(compare(rollup([plugin], { player: "a" }), pros).luckScore).toMatchObject({ value: null, pct: null, reason: "Not compared: shot spread and line of sight known for 0 of 1 rounds" });
    expect(compare(rollup([covered], { player: "a" }), pros).luckScore).toMatchObject({ pct: null, reason: "Not compared: for fun, with no pro percentile" });
    const units = Array.from({ length: 8 }, () => ({ pools: ["all"], side: "both" as const, s: rollup([covered], { player: "a" }) }));
    expect(buildPools(units).pools.all.both!.luckScore).toBeNull();
  });
});
