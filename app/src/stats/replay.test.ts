import { describe, expect, it } from "vitest";
import { buildRoundTimeline, FIRE_MAX_S, SMOKE_MAX_S, weaponId, type GrenadePaths, type RoundTimeline } from "./replay";
import { deathsOf, frameIndex, lerpYaw, playersAt } from "./replay-interp";
import { emptyTable, SCHEMA, type MatchTables, type Table, type TableName } from "./tables";
import { FREEZE_END, ROUND_END, oneRoundTables, type OneRound } from "./testing/match";
import { pushRow } from "./testing/tables";
import { rosterTables } from "./roster";

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
function tables(roundRow: Row = {}, moreKills: NonNullable<OneRound["kills"]> = []): MatchTables {
  const t = oneRoundTables({
    players: { a: "CT", b: "T" },
    roundRow,
    kills: [{ tick: 664, killer: "a", victim: "b", at: { a_x: 24, a_y: 8, a_z: 0, v_x: 100, v_y: 0, v_z: 0, headshot: true } }, ...moreKills],
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
  const tl = buildRoundTimeline(rosterTables(tables()), PATHS, 1);

  it("starts at freeze end and runs to the window's end, past the last sample", () => {
    expect(tl.zeroTick).toBe(FREEZE_END);
    expect(tl.frames.map((f) => f.t)).toEqual([0, 0.25, 0.5]);
    // no official end: the window is round end + END_TAIL_S, cut at the official end (here round end itself)
    expect(tl.duration).toBe(s(ROUND_END));
    expect(tl.endT).toBe(s(ROUND_END));
  });

  it("reaches an event after the last sample, with players holding their last sample", () => {
    // a second kill at 1200, well after the last sample (672)
    const t = tables({ end_tick: 1280, official_end_tick: 1600 }, [{ tick: 1200, killer: "b", victim: "a", at: { v_x: 60, v_y: 40, v_z: 0 } }]);
    const tl2 = buildRoundTimeline(rosterTables(t), null, 1);
    // end 1280 + 3 s = 1472, before the official end 1600
    expect(tl2.duration).toBe(s(1472));
    expect(tl2.kills.map((k) => k.t)).toEqual([0.375, s(1200)]);
    const p = Object.fromEntries(playersAt(tl2, s(1100), true).map((x) => [x.id, { ...x }]));
    expect(p.a).toMatchObject({ alive: true, x: 48, y: 32 });
    expect(Object.fromEntries(playersAt(tl2, s(1200), true).map((x) => [x.id, { ...x }])).a).toMatchObject({ alive: false, x: 60, y: 40 });
  });

  it("keeps the last sample before freeze end when none falls on it", () => {
    const late = buildRoundTimeline(rosterTables(tables({ freeze_end_tick: 648 })), null, 1);
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
    expect(() => buildRoundTimeline(rosterTables(t), null, 2)).toThrow("round 2 is not in this match");
    expect(() => buildRoundTimeline(rosterTables({ ...t, positions: null }), null, 1)).toThrow("no position samples");
  });

  it("stops the window before the next round starts", () => {
    const t = tables({ end_tick: 1280, official_end_tick: 1600 });
    // round 2 starts at 1400, before round 1's official end and before end + 3 s (1472)
    const two = { ...t, rounds: { ...t.rounds, round: [1, 2], start_tick: [0, 1400], freeze_end_tick: [FREEZE_END, 2000], end_tick: [1280, 3000], official_end_tick: [1600, 3400], winner_side: ["CT", "T"] } };
    expect(buildRoundTimeline(rosterTables(two), null, 1).duration).toBe(s(1399));
  });

  it("cuts an effect at the window's end", () => {
    const t = tables();
    const short = { ...t, rounds: { ...t.rounds, end_tick: [800], official_end_tick: [880] } };
    // window: end 800 + 3 s (992) cut to the official end, 880; the smoke expires at 900
    expect(buildRoundTimeline(rosterTables(short), null, 1).effects[0].until).toBe(s(880));
  });

  describe("effects without an end in the events", () => {
    const events = (rows: Row[]) => ({ ...tables(), grenade_events: table("grenade_events", rows.map((r) => ({ round: 1, steamid: "a", z: 0, ...r }))) });
    const smoke = { tick: 700, event: "smoke_detonate", entity_id: 7, x: 500, y: 500 };
    const fire = { tick: 701, event: "inferno_start", entity_id: 99, x: 200, y: 200 };

    it("never run to the window's end: a smoke lasts SMOKE_MAX_S, a fire FIRE_MAX_S", () => {
      const tl2 = buildRoundTimeline(rosterTables(events([smoke, fire])), null, 1);
      expect(tl2.effects.map((e) => e.until)).toEqual([s(700) + SMOKE_MAX_S, s(701) + FIRE_MAX_S]);
    });

    it("take a stop event that names no entity from the open effect of its kind beside it", () => {
      const tl2 = buildRoundTimeline(rosterTables(events([
        smoke, { ...smoke, tick: 705, entity_id: 8, x: 900, y: 900 },
        { tick: 900, event: "smoke_expired", entity_id: null, x: 905, y: 900 },
        // a stop far from every open smoke ends none of them
        { tick: 950, event: "smoke_expired", entity_id: null, x: 0, y: 0 },
      ])), null, 1);
      expect(tl2.effects.map((e) => e.until)).toEqual([s(700) + SMOKE_MAX_S, s(900)]);
    });

    it("leave an ambiguous stop unmatched: two open smokes beside it both fall back", () => {
      const t = events([
        smoke, { ...smoke, tick: 705, entity_id: 8, x: 520, y: 500 },
        { tick: 900, event: "smoke_expired", entity_id: null, x: 510, y: 500 },
      ]);
      // without a lifetime row: both run to the cap
      expect(buildRoundTimeline(rosterTables(t), null, 1).effects.map((e) => e.until)).toEqual([s(700) + SMOKE_MAX_S, s(705) + SMOKE_MAX_S]);
      // with lifetime rows: each takes its own
      const tl2 = buildRoundTimeline(rosterTables({
        ...t,
        smokes: table("smokes", [
          { entity_id: 7, steamid: "a", round: 1, start_tick: 700, end_tick: 1000, x: 500, y: 500, z: 0 },
          { entity_id: 8, steamid: "a", round: 1, start_tick: 705, end_tick: 900, x: 520, y: 500, z: 0 },
        ]),
      }), null, 1);
      expect(tl2.effects.map((e) => e.until)).toEqual([s(1000), s(900)]);
    });

    it("read their end from the smokes and infernos lifetime tables", () => {
      const t = events([smoke, fire]);
      const tl2 = buildRoundTimeline(rosterTables({
        ...t,
        smokes: table("smokes", [{ entity_id: 7, steamid: "a", round: 1, start_tick: 700, end_tick: 1000, x: 500, y: 500, z: 0 }]),
        // no entity id: matched on its start tick and place
        infernos: table("infernos", [{ entity_id: null, steamid: "a", round: 1, start_tick: 701, end_tick: 900, x: 210, y: 200, z: 0 }]),
      }), null, 1);
      expect(tl2.effects.map((e) => e.until)).toEqual([s(1000), s(900)]);
    });

    it("cap a lifetime longer than the longest seen", () => {
      const t = events([smoke]);
      const tl2 = buildRoundTimeline(rosterTables({ ...t, smokes: table("smokes", [{ entity_id: 7, steamid: "a", round: 1, start_tick: 700, end_tick: 700 + 64 * 700, x: 500, y: 500, z: 0 }]) }), null, 1);
      expect(tl2.effects[0].until).toBe(s(700) + SMOKE_MAX_S);
    });
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
  const tl: RoundTimeline = buildRoundTimeline(rosterTables(tables()), null, 1);
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

  it("never moves a corpse: without a kill position it lies at the last living sample", () => {
    // b dies at 664 with no victim position; later samples drift (as a ragdoll would)
    const t = oneRoundTables({
      players: { a: "CT", b: "T" },
      kills: [{ tick: 664, killer: "a", victim: "b" }],
      positions: [
        pos(640, "a", "CT", 0, 0, 0, "AK-47"), pos(640, "b", "T", 100, 0, 0, "AK-47"),
        pos(656, "a", "CT", 0, 0, 0, "AK-47"), pos(656, "b", "T", 110, 0, 0, "AK-47"),
        pos(672, "a", "CT", 0, 0, 0, "AK-47"), pos(672, "b", "T", 130, 5, 0, "AK-47", { is_alive: false, health: 0 }),
        pos(688, "a", "CT", 0, 0, 0, "AK-47"), pos(688, "b", "T", 150, 9, 0, "AK-47", { is_alive: false, health: 0 }),
      ],
    });
    const tl2 = buildRoundTimeline(rosterTables(t), null, 1);
    expect(deathsOf(tl2)[0]).toEqual({ t: s(664), at: [110, 0, 0] });
    for (const when of [s(664), s(672), s(688), 10]) {
      expect(playersAt(tl2, when, true).find((p) => p.id === "b")).toMatchObject({ alive: false, x: 110, y: 0 });
    }
  });

  it("lays a player marked dead without a kill row at his last living sample", () => {
    const t = oneRoundTables({
      players: { a: "CT", b: "T" },
      positions: [
        pos(640, "a", "CT", 0, 0, 0, "AK-47"), pos(640, "b", "T", 100, 0, 0, "AK-47"),
        pos(656, "a", "CT", 0, 0, 0, "AK-47"), pos(656, "b", "T", 140, 0, 0, "AK-47", { is_alive: false, health: 0 }),
        pos(672, "a", "CT", 0, 0, 0, "AK-47"), pos(672, "b", "T", 170, 0, 0, "AK-47", { is_alive: false, health: 0 }),
      ],
    });
    const tl2 = buildRoundTimeline(rosterTables(t), null, 1);
    expect(deathsOf(tl2)).toEqual([{ t: 0.25, at: [100, 0, 0] }, null]);
    expect(playersAt(tl2, 0.5, true).find((p) => p.id === "b")).toMatchObject({ alive: false, x: 100 });
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
