import { describe, expect, test } from "vitest";
import {
  aimAggregate, angleBetweenDeg, combinedAngleDeg, crosshairAngleDeg, engFor, histMedian, isCounterStrafed, segmentBursts,
  shotsFor, sprayControl,
} from "./aim";
import { MatchBuilder, TR } from "./testing/build";

describe("burst segmentation", () => {
  test("a gap of 0.3 s or more, a weapon change or a new round starts a new burst", () => {
    const gap = 0.3 * TR; // 19.2 ticks
    const shots = [
      { ri: 0, tick: 0, weapon: 1 }, { ri: 0, tick: 6, weapon: 1 }, { ri: 0, tick: 25, weapon: 1 }, // 19 ticks: same burst
      { ri: 0, tick: 25 + Math.ceil(gap), weapon: 1 }, // 20 ticks: new burst
      { ri: 0, tick: 50, weapon: 2 }, // weapon change
      { ri: 1, tick: 52, weapon: 2 }, // new round
    ];
    expect(segmentBursts(shots, TR)).toEqual({ burst: [0, 0, 0, 1, 2, 3], idx: [1, 2, 3, 1, 1, 1] });
  });
});

describe("counter-strafe", () => {
  test("speed at most 34 % of max speed", () => {
    expect(isCounterStrafed(85, 250)).toBe(true); // exactly 34 %
    expect(isCounterStrafed(85.01, 250)).toBe(false);
    expect(isCounterStrafed(0, 215)).toBe(true);
    expect(isCounterStrafed(null, 215)).toBeNull();
    expect(isCounterStrafed(10, null)).toBeNull();
  });
});

describe("crosshair angle", () => {
  test("straight ahead, sideways and below", () => {
    expect(crosshairAngleDeg(0, 0, [0, 0, 0], [100, 0, 0])).toBeCloseTo(0, 9);
    expect(crosshairAngleDeg(0, 0, [0, 0, 0], [0, 100, 0])).toBeCloseTo(90, 9);
    expect(crosshairAngleDeg(90, 0, [0, 0, 0], [0, 100, 0])).toBeCloseTo(0, 9);
    // Source pitch is positive looking down: a target 45° below is on the crosshair at pitch 45
    expect(crosshairAngleDeg(0, 0, [0, 0, 64], [100, 0, -36])).toBeCloseTo(45, 9);
    expect(crosshairAngleDeg(0, 45, [0, 0, 64], [100, 0, -36])).toBeCloseTo(0, 9);
  });
  test("yaw and pitch offsets combine on the sphere, not as a flat sum", () => {
    expect(combinedAngleDeg(10, 0)).toBeCloseTo(10, 9);
    expect(combinedAngleDeg(0, -10)).toBeCloseTo(10, 9);
    const c = combinedAngleDeg(3, 4);
    expect(c).toBeCloseTo((Math.acos(Math.cos((3 * Math.PI) / 180) * Math.cos((4 * Math.PI) / 180)) * 180) / Math.PI, 9);
    expect(angleBetweenDeg([2, 0], [-1, 0])).toBeCloseTo(3, 9);
  });
});

describe("aim aggregate", () => {
  test("accuracy family, counter-strafe and head hits", () => {
    const b = new MatchBuilder();
    // burst A: 5 bullets, first counter-strafed and a head hit, bullets 4-5 spray (one hit)
    b.shot(0, 100, { speed: 20, hit: 1, impact: [0, 0] }).shot(0, 106, { hit: 2 }).shot(0, 112).shot(0, 118, { hit: 2 }).shot(0, 124);
    // burst B: first bullet while running, missed
    b.shot(0, 300, { speed: 200 });
    // burst C: first bullet with no target: not spotted
    b.shot(0, 600, { target: null, hit: null });
    const s = shotsFor(aimAggregate(b.build())!, "all", "all");
    expect([s.shots, s.hits, s.headHits]).toEqual([7, 3, 1]);
    expect([s.spotted, s.spottedHits]).toEqual([6, 3]);
    expect([s.first, s.firstStrafeKnown, s.firstStrafed]).toEqual([3, 3, 2]); // B ran at 200 > 0.34 × 215
    expect([s.firstOnTarget, s.firstHits]).toEqual([2, 1]);
    expect([s.sprayOnTarget, s.sprayHits]).toEqual([2, 1]);
    // without the smoke and pen fields, adjusted accuracy and wallbang hits stay unknown
    expect([s.smokeKnown, s.penKnown]).toEqual([0, 0]);
  });
  test("adjusted accuracy drops smoke shots and wallbang kill shots; wallbangs come from pen", () => {
    const b = new MatchBuilder();
    b.shot(0, 100, { hit: 2 }).shot(0, 200, { hit: 2 }).shot(0, 300, { hit: null });
    b.m.aim.shots.smoke = [true, false, false];
    b.m.aim.shots.pen = [0, 1, 0];
    const s = shotsFor(aimAggregate(b.build())!, "all", "all");
    expect([s.smokeShots, s.adjusted, s.adjustedHits]).toEqual([1, 1, 0]);
    expect(s.wallbangHits).toBe(1);
  });
  test("splits by side and weapon class; grenades are not shots", () => {
    const b = new MatchBuilder(13);
    b.round(12, 3, "elim", { side: [2, 2, 2, 2, 2, 3, 3, 3, 3, 3] });
    b.shot(0, 100, { weapon: "ak47" }).shot(0, 400, { weapon: "awp" }).shot(12, b.t(12, 5), { weapon: "glock" }).shot(0, 900, { weapon: "hegrenade" });
    const a = aimAggregate(b.build())!;
    expect(shotsFor(a, "ct", "all").shots).toBe(2);
    expect(shotsFor(a, "t", "pistol").shots).toBe(1);
    expect(shotsFor(a, "all", "sniper").shots).toBe(1);
    expect(shotsFor(a, "all", "all").shots).toBe(3);
  });
  test("spray control: mean angle between bullet and target over bullets 4+", () => {
    const b = new MatchBuilder();
    for (let i = 0; i < 5; i++) b.shot(0, 100 + i * 6, { impact: [0, -100 * i] });
    // aim error stays at the crosshair, so bullet i lands i degrees off
    b.m.aim.shots.aimErr = b.m.aim.shots.aimErr.map(() => [0, 0]);
    const s = shotsFor(aimAggregate(b.build())!, "all", "all");
    expect(sprayControl(s)).toBeCloseTo((3 + 4) / 2, 9);
  });
  test("kill-based: headshot, wallbang and smoke kills", () => {
    const b = new MatchBuilder().shot(0, 10);
    b.kill(0, 5, 0, 5, { hs: true }).kill(0, 6, 0, 6);
    b.m.kills.flags[1] = 2 | 4;
    const s = shotsFor(aimAggregate(b.build())!, "all", "all");
    expect([s.kills, s.hsKills, s.wallbangKills, s.smokeKills]).toEqual([2, 1, 1, 1]);
  });
  test("engagement timings go to millisecond histograms; validation flag comes from env", () => {
    const b = new MatchBuilder();
    const e = b.m.aim.engagements;
    e.ri.push(0); e.enemy.push(5); e.tVis.push(1000); e.angVis.push(350); e.angVisYaw.push(300); e.angVisPitch.push(180);
    e.dist.push(900); e.tAimStart.push(1016); e.tFirstShot.push(1020); e.tFirstDmg.push(1032); e.tEnd.push(1100); e.outcome.push("kill");
    const a = aimAggregate(b.build())!;
    const g = engFor(a, "all");
    expect(g.ttd.sum).toBe(500); // 32 ticks
    expect(g.react.sum).toBe(250); // 16 ticks
    expect(g.xhair.sum).toBe(3.5);
    expect(histMedian(g.xhair)).toBe(3.5); // bin 3..4
    expect(a.validated).toBe(false);
    b.m.env.visibilityValidated = true;
    expect(aimAggregate(b.build())!.validated).toBe(true);
  });
  test("no aim data gives null", () => {
    expect(aimAggregate(new MatchBuilder().build())).toBeNull();
  });
});
