// The contact measures (aim.ts sighting, METRICS.md "Contact") on a hand-built round at 64 ticks/s.
// a (CT) runs along +x at 4 units a tick (256 u/s) from x = 0 at tick 1000 and stops at x = 80 on
// tick 1020; b (T) stands at x = 1,000. Both become visible to each other at tick 1010, when a is at
// x = 40. a fires at 1030, b at 1040, and a kills b at 1050.
import { describe, expect, it } from "vitest";
import { aggressionScore, AGGRO_PARTS, type AggroScale } from "./aggro-scale";
import type { SightFact } from "./aim";
import { compare, type Baselines } from "./compare";
import { METRIC, METRICS } from "./metrics";
import { rollup } from "./rollup";
import { oneRound } from "./testing/match";

const ax = (tick: number) => 4 * (Math.min(tick, 1020) - 1000);
const av = (tick: number) => (tick <= 1020 ? 256 : 0);

function ticks(id: number, aIsAttacker: boolean, shotAt: number) {
  const rows = [];
  for (let tick = 1000; tick <= 1100; tick++) {
    const a = { x: ax(tick), vx: av(tick), yaw: 3 };
    const b = { x: 1000, vx: 0, yaw: 180 };
    const [att, vic] = aIsAttacker ? [a, b] : [b, a];
    rows.push({
      engagement_id: id, tick, a_x: att.x, a_y: 0, a_z: 0, a_eye_z: 64, a_pitch: 0, a_yaw: att.yaw, a_vel_x: att.vx, a_vel_y: 0,
      a_shot_fired: tick === shotAt, v_x: vic.x, v_y: 0, v_z: 0, v_eye_z: 64, v_vel_x: vic.vx, v_vel_y: 0,
      mesh_visible: tick >= 1010, smoke_blocked: false,
    });
  }
  return rows;
}

const window = { start_tick: 1000, end_tick: 1100, first_visible_tick: 1010 };
/** b's last 4 Hz sample before the onset is at `bSample`, with 73 health; a's is at 1000 with 100. */
const contactRound = (bSample = 1000) => oneRound({
  players: { a: "CT", b: "T" },
  engagements: [{ engagement_id: 0, attacker_steamid: "a", victim_steamid: "b", ...window }, { engagement_id: 1, attacker_steamid: "b", victim_steamid: "a", ...window }],
  engagement_ticks: [...ticks(0, true, 1030), ...ticks(1, false, 1040)],
  kills: [{ tick: 1050, killer: "a", victim: "b" }],
  positions: [{ steamid: "a", tick: 1000, x: 0, y: 0, health: 100 }, { steamid: "b", tick: 900, x: 1000, y: 0, health: 100 }, { steamid: "b", tick: bSample, x: 1000, y: 0, health: 73 }],
});
const match = contactRound();

describe("contact measures", () => {
  const sight = (pi: number) => match.aim.find((f): f is SightFact => f.k === "sight" && f.pi === pi)!;

  it("measures distance, peek travel, the first shot, the stop and the duel from the onset", () => {
    // fails if a window, the moving cut or the stop buffer's one-tick offset moves: a is 960 units
    // from b at the onset, moves 40 units by tick 1026 (stopped at 1020), shoots standing at 1030
    // with the crosshair 3 degrees off, 9 ticks after his last moving tick, and wins the duel 40 ticks in
    expect(sight(0)).toMatchObject({ dist: 960, travel: 40, shotSpeed: 0, stopBuf: 9 / 64, duelS: 40 / 64, duelWon: true, first: true });
    expect(sight(0).shotErr).toBeCloseTo(3, 3);
    // b never moved, so he has no stop buffer, and he fired 10 ticks after a
    expect(sight(1)).toMatchObject({ dist: 960, travel: 0, stopBuf: null, duelWon: false, first: false });
  });

  it("records the duel's context at the onset for the expected-duel model", () => {
    // fails if a feature moves or reads the wrong player: placement 3, distance 960, a at 256 u/s and
    // b still, health 100 and 73, one alive a side, 370 ticks (5.781 s, facts keep 0.001) after freeze end, no pitch error
    expect(sight(0).xf).toEqual([3, 960, 256, 0, 100, 73, 0, 5.781, 0]);
    // fails if a 4 Hz sample older than 0.3 s (30 ticks > 19.2) gives b's health
    expect(contactRound(980).aim.find((f): f is SightFact => f.k === "sight" && f.pi === 0)!.xf).toBeNull();
  });

  it("reads health from before the onset, never a sample that already holds the duel's outcome", () => {
    // fails if the onset tick's sample (b already hit: 0 health, dead) gives the model the result it is
    // meant to predict; b's last sample strictly before the onset says 73
    const leaked = oneRound({
      players: { a: "CT", b: "T" },
      engagements: [{ engagement_id: 0, attacker_steamid: "a", victim_steamid: "b", ...window }, { engagement_id: 1, attacker_steamid: "b", victim_steamid: "a", ...window }],
      engagement_ticks: [...ticks(0, true, 1030), ...ticks(1, false, 1040)],
      kills: [{ tick: 1050, killer: "a", victim: "b" }],
      positions: [
        { steamid: "a", tick: 1000, x: 0, y: 0, health: 100 }, { steamid: "b", tick: 1000, x: 1000, y: 0, health: 73 },
        { steamid: "b", tick: 1010, x: 1000, y: 0, health: 0, is_alive: false },
      ],
    });
    expect(leaked.aim.find((f): f is SightFact => f.k === "sight" && f.pi === 0)!.xf![5]).toBe(73);
  });

  it("turns the sightings into the contact metrics", () => {
    // fails if a metric reads the wrong sample or scale (ms, percent)
    const s = rollup([match], { player: "a" });
    expect(["peekTravel", "engageDistance", "duelExposure", "firedFirst", "shotSpeed", "stopBuffer"].map((id) => METRIC[id].value(s)))
      .toEqual([40, 960, 0.625, 100, 0, (1000 * 9) / 64]);
    expect(METRIC.firedFirst.value(rollup([match], { player: "b" }))).toBe(0);
  });

  it("gives no value and says why on a match without line of sight", () => {
    // fails if a plugin match (no engagements) gets a contact value from anything but line of sight
    const plugin = oneRound({ players: { a: "CT", b: "T" }, kills: [{ tick: 1050, killer: "a", victim: "b" }] });
    const s = rollup([plugin], { player: "a" });
    const pools = { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(0)])) } };
    const pros: Baselines = { version: 1, built: "x", source: "t", model: plugin.match.model, n: {}, pools: { ...pools, rifler: pools.all } };
    expect(compare(s, pros).peekTravel).toMatchObject({ value: null, pct: null, reason: "Not compared: line of sight known for 0 of 1 rounds" });
  });
});

describe("shooting while moving", () => {
  it("averages the moving-bullet share over rifle bursts whose bullets all have a speed", () => {
    // fails if the 0.3 s burst gap, the strict 75 u/s cut, the rifle-only rule or the unknown-speed
    // skip changes. Counted: 1000-1012 (2 of 3 above 75 u/s) and 1050-1056 (80 is above, 75 is not:
    // 1 of 2). Not counted: the lone shot at 1100, the pistol pair, the AK-to-M4 switch, and the pair
    // with no speed. Mean share (2/3 + 1/2) / 2.
    const shot = (tick: number, speed: number | null, weapon = "ak47") => ({ tick, steamid: "a", weapon, speed_2d: speed });
    const f = oneRound({
      players: { a: "CT", b: "T" },
      shots: [
        shot(1000, 0), shot(1006, 200), shot(1012, 100), shot(1050, 80), shot(1056, 75), shot(1100, 250),
        shot(1200, 200, "glock"), shot(1205, 200, "glock"), shot(1300, 200), shot(1305, 200, "m4a1"), shot(1400, null), shot(1406, null),
      ],
    });
    const s = rollup([f], { player: "a" });
    expect([s.aim.bursts, s.aim.movingShare]).toEqual([2, 2 / 3 + 1 / 2]);
    expect(METRIC.movingSpray.value(s)).toBeCloseTo((100 * (2 / 3 + 1 / 2)) / 2, 9);
  });
});

describe("aggressive-to-passive score", () => {
  const scale: AggroScale = { parts: [...AGGRO_PARTS], mean: [20, 50, 0.5, 800], sd: [10, 25, 0.25, 80], composite: { mean: 0.5, sd: 0.25 }, players: 1, source: "test" };

  it("standardizes the mean of the parts' signed z-scores against the pros, higher for more aggressive", () => {
    // fails if a sign flips, a part drops out or the score is not in pro standard deviations. a
    // travelled 40 (+2), fired first in 100% (+2), waited 0.625 s for the duel (-0.5: longer is more
    // passive) and met b at 960 units (-2: farther is more passive): a mean of 0.375, which against
    // pros averaging 0.5 with a spread of 0.25 is -0.5
    expect(aggressionScore(rollup([match], { player: "a" }), scale)).toBeCloseTo(-0.5, 12);
  });

  it("gives no score unless every part has a value, and refuses a scale for other parts", () => {
    // fails if a score is made from three parts, or a scale fitted on another list is read in the wrong order
    const noShots = oneRound({ players: { a: "CT", b: "T" } });
    expect(aggressionScore(rollup([noShots], { player: "a" }), scale)).toBeNull();
    expect(() => aggressionScore(rollup([match], { player: "a" }), { ...scale, parts: ["peekTravel", "engageDistance", "firedFirst", "duelExposure"] })).toThrow(/aggression scale is for/);
  });
});
