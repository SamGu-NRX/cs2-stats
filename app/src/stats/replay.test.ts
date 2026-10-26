import { describe, expect, it } from "vitest";
import { buildRoundTimeline, weaponId, type GrenadePaths, type RoundTimeline } from "./replay";
import { frameIndex, lerpYaw, playersAt } from "./replay-interp";
import { emptyTable, SCHEMA, type MatchTables, type Table, type TableName } from "./tables";
import { FREEZE_END, ROUND_END, oneRoundTables } from "./testing/match";
import { pushRow } from "./testing/tables";

type Row = Record<string, unknown>;
function table<N extends TableName>(name: N, rows: Row[]): Table<N> {
  const t = emptyTable(name);
  for (const r of rows) pushRow(t, { ...Object.fromEntries(Object.keys(SCHEMA[name]).map((c) => [c, null])), ...r } as Parameters<typeof pushRow<N>>[1]);
  return t;
}

const pos = (tick: number, steamid: string, side: string, x: number, y: number, yaw: number, weapon: string, extra: Row = {}): Row =>
  ({ tick, round: 1, steamid, side, x, y, z: 0, yaw, is_alive: true, health: 100, active_weapon: weapon, ...extra });

// a: CT, b: T. Samples every 16 ticks from freeze end (640) to 672, plus one of a's in freeze time;
// b has no sample at 672. a kills b at tick 664; b was hit to 60 HP at tick 648.
function tables(roundRow: Row = {}): MatchTables {
  const t = oneRoundTables({
    players: { a: "CT", b: "T" },
    roundRow,
    kills: [{ tick: 664, killer: "a", victim: "b", at: { a_x: 24, a_y: 8, a_z: 0, v_x: 100, v_y: 0, v_z: 0, headshot: true } }],
    damages: [{ tick: 648, attacker_steamid: "a", victim_steamid: "b", dmg_health_capped: 40, health_after: 60 }],
    positions: [
      pos(600, "a", "CT", -999, -999, 0, "USP-S"),
      pos(640, "a", "CT", 16, 0, 90, "M4A1-S"), pos(640, "b", "T", 100, 0, 170, "Glock-18"),
      pos(656, "a", "CT", 32, 16, 170, "M4A1-S"), pos(656, "b", "T", 100, 0, -170, "Butterfly Knife", { health: 60 }),
      pos(672, "a", "CT", 48, 32, 170, "M4A1-S"),
    ],
  });
  return {
    ...t,
    grenade_events: table("grenade_events", [
      { tick: 700, round: 1, event: "smoke_detonate", entity_id: 7, steamid: "a", x: 500, y: 500, z: 0 },
      { tick: 701, round: 1, event: "inferno_start", entity_id: 99, steamid: "b", x: 200, y: 200, z: 0 },
      { tick: 710, round: 1, event: "flash_detonate", entity_id: 8, steamid: "b", x: 300, y: 300, z: 0 },
      { tick: 900, round: 1, event: "smoke_expired", entity_id: 7, steamid: "a", x: 500, y: 500, z: 0 },
      { tick: 1000, round: 1, event: "inferno_expire", entity_id: 99, steamid: null, x: 200, y: 200, z: 0 },
    ]),
    bomb: table("bomb", [
      { tick: 656, round: 1, event: "planted", steamid: "b", site: "B", place: null },
      { tick: 672, round: 1, event: "exploded", steamid: null, site: "B", place: null },
      { tick: 650, round: 1, event: "pickup", steamid: "b", site: null, place: null },
    ]),
  };
}

function paths(rows: [number, number, string, number, number, number, string | null][]): GrenadePaths {
  // [projectile, entity, type, tick, x, y, steamid]
  return {
    n: rows.length, projectile: rows.map((r) => r[0]), entity_id: rows.map((r) => r[1]), round: rows.map(() => 1), tick: rows.map((r) => r[3]),
    type: rows.map((r) => r[2]), steamid: rows.map((r) => r[6]), x: rows.map((r) => r[4]), y: rows.map((r) => r[5]), z: rows.map(() => 0),
  };
}

const PATHS = paths([
  [1, 7, "smoke", 698, 490, 490, null], [1, 7, "smoke", 690, 400, 400, null],
  [2, 50, "molotov", 680, 150, 150, null], [2, 50, "molotov", 700, 200, 200, null],
  [3, 51, "molotov", 692, 800, 800, null], [3, 51, "molotov", 700, 900, 900, null],
]);

const s = (tick: number) => (tick - FREEZE_END) / 64;

describe("buildRoundTimeline", () => {
  const tl = buildRoundTimeline(tables(), PATHS, 1);

  it("starts at freeze end", () => {
    expect(tl.zeroTick).toBe(FREEZE_END);
    expect(tl.frames.map((f) => f.t)).toEqual([0, 0.25, 0.5]);
    expect(tl.duration).toBe(0.5);
    expect(tl.endT).toBe(s(ROUND_END));
  });

  it("keeps the last sample before freeze end when none falls on it", () => {
    const late = buildRoundTimeline(tables({ freeze_end_tick: 648 }), null, 1);
    expect(late.frames.map((f) => f.t)).toEqual([-0.125, 0.125, 0.375]);
  });

  it("lists T before CT and keeps every frame in roster order", () => {
    expect(tl.players).toEqual([{ id: "b", name: "b", side: "T" }, { id: "a", name: "a", side: "CT" }]);
    for (const f of tl.frames) expect(f.players.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("holds a player's last sample where a tick has none", () => {
    expect(tl.frames[2].players[0]).toMatchObject({ id: "b", x: 100, yaw: -170, hp: 60 });
  });

  it("names weapons by icon id", () => {
    expect(tl.frames.map((f) => f.players[0].weapon)).toEqual(["glock", "knife", "knife"]);
    expect(tl.frames[0].players[1].weapon).toBe("m4a1_silencer");
  });

  it("puts kills and hits on the round clock", () => {
    expect(tl.kills).toEqual([{ t: 0.375, killer: "a", victim: "b", killerSide: "CT", victimSide: "T", weapon: "ak47", headshot: true, kpos: [24, 8, 0], vpos: [100, 0, 0] }]);
    expect(tl.hits).toEqual([{ t: 0.125, victim: "b", hp: 60 }]);
  });

  it("links each flight to its detonation and thrower", () => {
    expect(tl.throws).toEqual([
      // a molotov's fire starts a tick after its flight, at its last point (FIRE_LINK_TICKS)
      { kind: "molotov", thrower: "b", side: "T", path: [s(680), 150, 150, 0, s(700), 200, 200, 0], end: s(701) },
      // the smoke's path names no thrower; its detonation (same entity) does
      { kind: "smoke", thrower: "a", side: "CT", path: [s(690), 400, 400, 0, s(698), 490, 490, 0], end: s(700) },
      // no fire near this one: it ends at its last point, thrower unknown
      { kind: "molotov", thrower: null, side: null, path: [s(692), 800, 800, 0, s(700), 900, 900, 0], end: s(700) },
    ]);
  });

  it("gives smokes and fires their lifetime, cut at the window's end", () => {
    // the window ends at round end here (ROUND_END), so every stop event is inside it
    expect(tl.effects).toEqual([
      { kind: "smoke", thrower: "a", side: "CT", t: s(700), until: s(900), at: [500, 500, 0] },
      { kind: "molotov", thrower: "b", side: "T", t: s(701), until: s(1000), at: [200, 200, 0] },
      { kind: "flash", thrower: "b", side: "T", t: s(710), until: s(710), at: [300, 300, 0] },
    ]);
  });

  it("places the bomb where its planter stood, and the explosion on the plant", () => {
    expect(tl.bomb).toEqual([
      { t: s(656), kind: "plant", by: "b", site: "B", at: [100, 0, 0] },
      { t: s(672), kind: "explode", by: null, site: "B", at: [100, 0, 0] },
    ]);
  });

  it("refuses a round without samples or not in the match", () => {
    const t = tables();
    expect(() => buildRoundTimeline(t, null, 2)).toThrow("round 2 is not in this match");
    expect(() => buildRoundTimeline({ ...t, positions: null }, null, 1)).toThrow("no position samples");
  });

  it("ends a smoke that never expired at the window's end", () => {
    const t = tables();
    const short = { ...t, rounds: { ...t.rounds, end_tick: [800], official_end_tick: [900] } };
    const tl2 = buildRoundTimeline(short, null, 1);
    // window: end 800 + 3 s (992) cut to the official end, 900; the smoke's expiry at 900 is its end
    expect(tl2.effects[0].until).toBe(s(900));
    const noExpiry = { ...short, grenade_events: table("grenade_events", [{ tick: 700, round: 1, event: "smoke_detonate", entity_id: 7, steamid: "a", x: 0, y: 0, z: 0 }]) };
    expect(buildRoundTimeline(noExpiry, null, 1).effects[0].until).toBe(s(900));
  });
});

describe("weaponId", () => {
  it("maps display names to the icon pack's ids", () => {
    expect(weaponId("AK-47")).toBe("ak47");
    expect(weaponId("M4A4")).toBe("m4a1");
    expect(weaponId("Zeus x27")).toBe("taser");
    expect(weaponId("C4 Explosive")).toBe("c4");
    expect(weaponId("M9 Bayonet")).toBe("knife");
    expect(weaponId("Shadow Daggers")).toBe("knife");
    expect(weaponId("knife_t")).toBe("knife");
    expect(weaponId(null)).toBe(null);
  });
});

describe("interpolation", () => {
  const tl: RoundTimeline = buildRoundTimeline(tables(), null, 1);
  const at = (t: number, smooth = true) => Object.fromEntries(playersAt(tl, t, smooth).map((p) => [p.id, { ...p }]));

  it("finds the last frame at or before t", () => {
    const f = [{ t: 0 }, { t: 1 }, { t: 2 }];
    expect([-1, 0, 0.5, 1, 1.5, 2, 5].map((t) => frameIndex(f, t))).toEqual([0, 0, 0, 1, 1, 2, 2]);
  });

  it("turns the short way round", () => {
    expect(lerpYaw(170, -170, 0.5)).toBe(180);
    expect(lerpYaw(-170, 170, 0.5)).toBe(180);
    expect(lerpYaw(10, 350, 0.5)).toBe(0);
    expect(lerpYaw(0, 90, 0.25)).toBe(22.5);
    expect(lerpYaw(90, 170, 0.5)).toBe(130);
  });

  it("moves in a straight line between samples", () => {
    expect(at(0.125).a).toMatchObject({ x: 24, y: 8, yaw: 130, alive: true, hp: 100, weapon: "m4a1_silencer" });
    expect(at(0.125).b).toMatchObject({ x: 100, y: 0, yaw: 180 });
  });

  it("holds the last sample with interpolation off", () => {
    expect(at(0.125, false).a).toMatchObject({ x: 16, y: 0, yaw: 90 });
    expect(at(0.2499, false).a).toMatchObject({ x: 16, y: 0, yaw: 90 });
    expect(at(0.25, false).a).toMatchObject({ x: 32, y: 16, yaw: 170 });
  });

  it("drops HP at the hit, between samples", () => {
    expect(at(0.1).b.hp).toBe(100);
    expect(at(0.125).b.hp).toBe(60);
  });

  it("kills at the kill's tick, at the victim's position", () => {
    expect(at(0.374).b.alive).toBe(true);
    expect(at(0.375).b).toMatchObject({ alive: false, hp: 0, x: 100, y: 0 });
  });

  it("clamps before the first frame and after the last", () => {
    expect(at(-5).a).toMatchObject({ x: 16, y: 0 });
    expect(at(99).a).toMatchObject({ x: 48, y: 32 });
  });

  it("reuses the objects it is given", () => {
    const out = playersAt(tl, 0, true);
    const first = out[0];
    expect(playersAt(tl, 0.1, true, out)[0]).toBe(first);
  });
});
