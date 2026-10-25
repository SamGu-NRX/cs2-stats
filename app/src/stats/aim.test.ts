// Aim measures on a hand-built match at 64 ticks/s, where every expected value is worked out by hand.
import { CS2RB } from "./model-params";
import { describe, expect, it } from "vitest";
import { aimAngle, aimError } from "./aim-geometry";
import { emptyAim, foldAim, type ShotFact, type SightFact, type SprayFact } from "./aim";
import { METRIC } from "./metrics";
import type { Summary } from "./rollup";
import { derive } from "./derive";
import { emptyTable, kindOf, SCHEMA, type MatchTables, type TableName } from "./tables";
import { pushRow } from "./testing/tables";

/** Appends a row, filling unnamed columns with null (nullable) or a zero value. */
function add<N extends TableName>(t: MatchTables[N] & object, name: N, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = {};
  for (const col of Object.keys(SCHEMA[name])) {
    const k = kindOf(name, col);
    full[col] = col in row ? row[col] : k.endsWith("?") ? null : k === "ss" ? [] : k === "b" ? false : k === "s" || k === "id" ? "" : 0;
  }
  pushRow(t as never, full as never);
}

const RATE = 64;
// Attacker A stands at the origin; victim V stands 1,000 units along +x, so his eye is at yaw 0.
const ENG = { start: 100, end: 400, onset: 120 };
/** A's yaw per tick: still at 10 until 130, a 2-degree-per-tick flick that ends 2 degrees past V at 136, then two small corrections. */
function yawAt(tick: number): number {
  if (tick <= 130) return 10;
  if (tick <= 136) return 10 - 2 * (tick - 130);
  return ({ 137: -1.5, 138: -1.5, 139: -1, 140: -1 } as Record<number, number>)[tick] ?? -0.5;
}
/** A's velocity before each counter-strafe test shot (ticks 145, 200, 260, 320). */
function velAt(tick: number): [number, number] {
  if (tick >= 184 && tick < 200) return [200, 0];
  if (tick >= 244 && tick < 260) return [200, 0];
  if (tick >= 304 && tick < 320) return [60, 0];
  return [0, 0];
}

/** hideAt: V leaves sight from this tick; sprayVisible: whether V is on screen during the round-2 spray. */
function match({ hideAt, sprayVisible = true }: { hideAt?: number; sprayVisible?: boolean } = {}): MatchTables {
  const t = {
    match: emptyTable("match"), players: emptyTable("players"), rounds: emptyTable("rounds"), player_rounds: emptyTable("player_rounds"),
    kills: emptyTable("kills"), damages: emptyTable("damages"), blinds: emptyTable("blinds"), bomb: emptyTable("bomb"),
    grenade_throws: null, grenade_events: null, smokes: null, infernos: null, positions: null, spotted: null,
    shots: emptyTable("shots"), engagements: emptyTable("engagements"), engagement_ticks: emptyTable("engagement_ticks"), purchases: null,
  } satisfies MatchTables;
  add(t.match, "match", { match_id: "m", source: "local", map: "de_test", tick_rate: RATE, team_ct_start: "A", team_t_start: "B", schema_version: 1, convars: "{}", extra: "{}", visibility_status: "ok" });
  add(t.players, "players", { steamid: "1", name: "a", team: "A" });
  add(t.players, "players", { steamid: "2", name: "v", team: "B" });
  for (const r of [1, 2]) {
    add(t.rounds, "rounds", { round: r, start_tick: (r - 1) * 1000, freeze_end_tick: (r - 1) * 1000 + 50, end_tick: r * 1000, winner_side: "CT" });
    add(t.player_rounds, "player_rounds", { round: r, steamid: "1", side: "CT" });
    add(t.player_rounds, "player_rounds", { round: r, steamid: "2", side: "T" });
  }
  add(t.damages, "damages", { tick: 145, round: 1, attacker_steamid: "1", victim_steamid: "2", weapon: "ak47", dmg_health: 27, dmg_health_capped: 27, health_before: 100, health_after: 73 });
  add(t.engagements, "engagements", {
    engagement_id: 0, round: 1, attacker_steamid: "1", victim_steamid: "2", start_tick: ENG.start, end_tick: ENG.end,
    first_visible_tick: ENG.onset, first_shot_tick: 145, first_damage_tick: 145, hits: 1, damage: 27, outcome: "damage-only", truncated: false,
  });
  const shotTicks = [145, 200, 260, 320];
  for (let tick = ENG.start; tick <= ENG.end; tick++) {
    const [vx, vy] = velAt(tick);
    add(t.engagement_ticks, "engagement_ticks", {
      engagement_id: 0, tick, a_x: 0, a_y: 0, a_z: 0, a_eye_z: 64, a_pitch: 0, a_yaw: yawAt(tick), a_vel_x: vx, a_vel_y: vy, a_duck: 0,
      a_shot_fired: shotTicks.includes(tick), v_x: 1000, v_y: 0, v_z: 0, v_eye_z: 64, v_pitch: 0, v_yaw: 180, v_vel_x: 0, v_vel_y: 0, v_duck: 0,
      mesh_visible: tick >= ENG.onset && (hideAt === undefined || tick < hideAt), smoke_blocked: false,
    });
  }
  // Round 2: V in front of A for the whole spray (or hidden, with sprayVisible false).
  add(t.engagements, "engagements", {
    engagement_id: 1, round: 2, attacker_steamid: "1", victim_steamid: "2", start_tick: 1090, end_tick: 1140,
    first_visible_tick: sprayVisible ? 1090 : null, first_shot_tick: 1100, first_damage_tick: null, hits: 0, damage: 0, outcome: "sight-only", truncated: false,
  });
  for (let tick = 1090; tick <= 1140; tick++) {
    add(t.engagement_ticks, "engagement_ticks", {
      engagement_id: 1, tick, a_x: 0, a_y: 0, a_z: 0, a_eye_z: 64, a_pitch: 0, a_yaw: 180, a_vel_x: 0, a_vel_y: 0, a_duck: 0,
      a_shot_fired: false, v_x: -1000, v_y: 0, v_z: 0, v_eye_z: 64, v_pitch: 0, v_yaw: 0, v_vel_x: 0, v_vel_y: 0, v_duck: 0,
      mesh_visible: sprayVisible, smoke_blocked: false,
    });
  }
  // Counter-strafe shots: [tick, velocity at the shot]. 73.1 u/s is 34% of the AK's 215.
  const strafes: [number, [number, number]][] = [[145, [73, 0]], [200, [80, 0]], [260, [-80, 0]], [320, [80, 0]]];
  for (const [tick, [vx, vy]] of strafes) {
    add(t.shots, "shots", {
      tick, round: 1, steamid: "1", weapon: "ak47", pitch: 0, yaw: yawAt(tick), recoil_index: 0, ammo_clip: 30, airborne: false, scoped: false,
      flash_duration: 0, vel_x: vx, vel_y: vy, speed_2d: Math.hypot(vx, vy),
    });
  }
  // Round 2 sprays: four bullets 6-7 ticks apart (the AK's 0.1 s cycle), yaw crossing +-180, then a
  // 10-tick gap that breaks the run, then two more bullets that cannot start a spray (recoil not reset).
  const spray: [number, number, number, number][] = [[1100, 0, 179, 0], [1106, 0.5, -179.5, 1], [1113, 1.5, -179, 2], [1119, 3, -178.5, 3], [1129, 3.5, -178, 4], [1135, 4, -178, 5]];
  spray.forEach(([tick, pitch, yaw, ri], j) => add(t.shots, "shots", {
    tick, round: 2, steamid: "1", weapon: "ak47", pitch, yaw, recoil_index: ri, ammo_clip: 30 - j, airborne: false, scoped: false,
    flash_duration: 0, vel_x: 0, vel_y: 0, speed_2d: 0,
  }));
  return t;
}

describe("aim geometry", () => {
  it("measures the angle and the turn needed to reach a target", () => {
    // fails if pitch sign, yaw wrap or the 3-D angle is wrong
    const eye: [number, number, number] = [0, 0, 64];
    expect(aimAngle(0, 0, eye, [100, 100, 64])).toBeCloseTo(45, 9);
    expect(aimError(0, 0, eye, [100, 0, 164])).toEqual([0, -45].map((x) => expect.closeTo(x, 9)));
    expect(aimError(0, 170, eye, [-100, -100 * Math.tan((10 * Math.PI) / 180), 64])[0]).toBeCloseTo(20, 9);
  });
});

describe("deriveAim on a hand-built match", () => {
  const facts = derive(match(), CS2RB).aim;

  it("times and measures a sighting", () => {
    // fails if the onset, the reaction tick, the flick's overshoot or the correction count moves
    const s = facts.filter((f): f is SightFact => f.k === "sight");
    expect(s).toHaveLength(1);
    const f = s[0];
    expect(f.place).toBeCloseTo(10, 6);
    expect(f.react).toBe((131 - 120) / RATE);
    expect(f.shot).toBe((145 - 120) / RATE);
    expect(f.ttd).toBe((145 - 120) / RATE);
    // the view turned from yaw 10 at the onset to -0.5 at the damage tick
    expect(f.moved).toBeCloseTo(10.5, 3);
    expect(f.ttk).toBeNull();
    expect(f.over).toBeCloseTo(2, 6);
    expect(f.micro).toBe(2);
    expect(f.weapon).toBe("ak47");
  });

  it("classifies first shots by counter-strafe and links hits by tick", () => {
    // fails if the 34% boundary, the reversal or deceleration test, or the hit link changes
    const s = facts.filter((f): f is ShotFact => f.k === "shots" && f.ri === 0);
    expect(s).toHaveLength(1);
    expect(s[0].cs).toEqual([1, 1, 1, 1, 0]);
    expect([s[0].shots, s[0].hits, s[0].first, s[0].firstHits]).toEqual([4, 1, 4, 1]);
  });

  it("cuts sprays by the recoil asset's rule and unwraps yaw", () => {
    // fails if a run is stitched across a gap, starts without a reset, or yaw is not unwrapped
    const s = facts.filter((f): f is SprayFact => f.k === "spray");
    expect(s).toHaveLength(1);
    expect(s[0].bullets).toBe(4);
    expect(s[0].dp).toEqual([0.5, 1.5, 3]);
    expect(s[0].dy.map((x) => +x.toFixed(9))).toEqual([1.5, 2, 2.5]);
  });

  it("compares a spray with the pros' only while an enemy is on screen", () => {
    // fails if a spray at nobody (no visible engagement) counts toward the pro-path comparison
    const s = derive(match({ sprayVisible: false }), CS2RB).aim.filter((f): f is SprayFact => f.k === "spray");
    expect(s.map((f) => [f.bullets, f.dp.length])).toEqual([[4, 0]]);
  });

  it("times the kill from the sighting, and leaves out time to damage of a second or more", () => {
    // fails if a kill while visible is not timed, or a 1 s+ time to damage counts as a reaction
    const t = match();
    add(t.kills, "kills", { tick: 150, round: 1, attacker_steamid: "1", victim_steamid: "2", weapon: "ak47", headshot: true, a_side: "CT", v_side: "T" });
    expect(derive(t, CS2RB).aim.find((x): x is SightFact => x.k === "sight")!.ttk).toBe((150 - 120) / RATE);
    const late = match();
    late.engagements!.first_damage_tick[0] = 120 + RATE;
    late.damages.tick[0] = 120 + RATE;
    const agg = emptyAim();
    for (const f of derive(late, CS2RB).aim) foldAim(agg, f);
    expect(agg.ttd).toEqual([1]);
    expect(METRIC.timeToDamage.value({ aim: agg } as Summary)).toBeNull();
  });

  it("times a sighting only within the stretch the enemy stays visible", () => {
    // fails if damage or a shot after the enemy left sight is timed from this onset
    const f = derive(match({ hideAt: 140 }), CS2RB).aim.find((x): x is SightFact => x.k === "sight")!;
    expect([f.ttd, f.shot]).toEqual([null, null]);
    expect(f.react).toBe((131 - 120) / RATE);
  });
});
