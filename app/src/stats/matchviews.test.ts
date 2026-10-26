// The per-match views (matchviews.ts) on hand-built rounds at 64 ticks per second: CT a and b against
// T c and d unless a test says otherwise.
import { describe, expect, it } from "vitest";
import { addSituations, bombsites, headToHead, mapZones, openingDuels, roundRatings, yourMatch, type Situations } from "./matchviews";
import { RATING3_INTERCEPT } from "./rating3";
import { rating3Of } from "./rating3";
import { emptySummary, rollup } from "./rollup";
import { FREEZE_END, oneRound, oneRoundTables } from "./testing/match";
import { derive } from "./derive";
import { CS2RB } from "./model-params";

const t = (s: number) => FREEZE_END + 64 * s;
const equip = { equip_value_game: 4000 };

describe("rating by round", () => {
  it("gives each rated round the rating of that round alone, split by input", () => {
    // fails if a term, the intercept or the per-round scale (KAST and multi-kill as 0 or 100, swing in
    // points) is wrong: one rated round's rating equals Rating 3.0 over that round, and its terms sum to it
    const f = oneRound({ players: { a: "CT", c: "T" }, player_rounds: { a: equip, c: equip }, kills: [{ tick: t(1), killer: "a", victim: "c" }] });
    const [r] = roundRatings(f, "a", 1);
    expect(r.rating).toBeCloseTo(rating3Of(rollup([f], { player: "a" })).value!, 12);
    expect(RATING3_INTERCEPT + Object.values(r.terms!).reduce((x, y) => x + y, 0)).toBeCloseTo(r.rating!, 12);
    expect(r.vsAverage).toBeCloseTo(r.rating! - 1, 12);
    expect(r.swing).not.toBeNull();
  });

  it("leaves a round Rating 3.0 cannot rate without a rating", () => {
    // fails if a round without eco values (no equipment recorded) gets a rating made of zeros
    const f = oneRound({ players: { a: "CT", c: "T" }, kills: [{ tick: t(1), killer: "a", victim: "c" }] });
    expect(roundRatings(f, "a", 1).map((r) => [r.rating, r.terms, r.vsAverage])).toEqual([[null, null, null]]);
  });
});

describe("head to head", () => {
  it("records kills, damage, weapon classes, flashes and openings each way, for enemies only", () => {
    // fails if a pair's direction flips, teammates pair up, or a short blind counts: a kills c with an AK
    // (the opening kill) after 100 damage, c hits a for 30 and kills b with an AWP; a blinds c for 2 s,
    // c blinds a for 0.5 s (under Leetify's 1.1 s)
    const hit = (tick: number, a: string, v: string, dmg: number) => ({ tick, attacker_steamid: a, victim_steamid: v, weapon: "ak47", dmg_health: dmg, dmg_health_capped: dmg, health_before: 100, a_side: a === "c" ? "T" : "CT", v_side: v === "c" ? "T" : "CT" });
    const m = { players: { a: "CT", b: "CT", c: "T" } as const, damages: [hit(t(1), "a", "c", 100), hit(t(1), "c", "a", 30)],
      blinds: [{ tick: t(1), attacker_steamid: "a", victim_steamid: "c", duration: 2 }, { tick: t(1), attacker_steamid: "c", victim_steamid: "a", duration: 0.5 }],
      kills: [{ tick: t(2), killer: "a", victim: "c" }, { tick: t(3), killer: "c", victim: "b", at: { weapon: "awp" } }] };
    const tables = oneRoundTables(m);
    const pairs = headToHead(tables, derive(tables, CS2RB));
    const ac = pairs.find((p) => [p.a, p.b].sort().join() === "a,c")!, bc = pairs.find((p) => [p.a, p.b].sort().join() === "b,c")!;
    const ofA = ac.a === "a" ? 0 : 1, ofC = 1 - ofA;
    expect([ac.kills[ofA], ac.kills[ofC], ac.damage[ofA], ac.damage[ofC], ac.openings[ofA]]).toEqual([1, 0, 100, 30, 1]);
    expect([ac.weapons[ofA], ac.flashes[ofA], ac.flashes[ofC]]).toEqual([{ rifle: 1 }, { count: 1, secs: 2 }, { count: 0, secs: 0 }]);
    expect(bc.weapons[bc.a === "c" ? 0 : 1]).toEqual({ sniper: 1 });
    expect(pairs).toHaveLength(2);
  });
});

describe("map zones", () => {
  it("places kills and deaths by the kill's place, else your nearest position sample", () => {
    // fails if a zone is read from the wrong player or the fallback is lost: a kills c standing in Long A;
    // d kills a, whose death has no place, and a's position sample nearest it says Pit
    const tables = oneRoundTables({
      players: { a: "CT", c: "T", d: "T" },
      kills: [{ tick: t(1), killer: "a", victim: "c", at: { a_place: "LongA", a_x: 10, a_y: 20 } }, { tick: t(2), killer: "d", victim: "a", at: { v_place: null } }],
      positions: [{ steamid: "a", tick: t(2) - 8, x: 0, y: 0, place: "Pit" }, { steamid: "c", tick: t(1), x: 5, y: 5, place: "LongA" }],
    });
    const z = mapZones(tables, "a");
    expect(z.zones).toEqual(["LongA", "Pit"]);
    expect(z.rows.map((r) => [r.zone, r.side, r.kills, r.deaths, r.kd])).toEqual([["LongA", "CT", 1, 0, null], ["Pit", "CT", 0, 1, 0]]);
    expect(z.rows[0].killsAt).toEqual([[10, 20]]);
  });
});

describe("your match", () => {
  it("gives each metric's delta against your recent matches, and which way is better", () => {
    // fails if lowerIsBetter is ignored or identity metrics get better and worse: KPR 1 against 0.5 is
    // better; DPR 0.2 against 0.5 is lower, so better; opening attempts 40% against 20% is higher
    const s = (kills: number, deaths: number, openings: number) => { const x = emptySummary(); Object.assign(x.m, { rounds: 10, kills, deaths, openingKills: openings }); return x; };
    const rows = Object.fromEntries(yourMatch(s(10, 2, 4), s(5, 5, 2)).map((r) => [r.id, [r.delta, r.direction]]));
    expect(rows.kpr).toEqual([0.5, "better"]);
    expect(rows.dpr[1]).toBe("better");
    expect(rows.dpr[0]).toBeCloseTo(-0.3, 12);
    expect(rows.openingAttempts).toEqual([20, "higher"]);
  });
});

describe("opening duels", () => {
  it("lists each round's opening kill and converts it for both players", () => {
    // fails if the best weapon, the traded flag or a round's result is read for the wrong side: a opens
    // with an AK and CT wins, so a has 1 of 1 after the kill and c 0 of 1 after the death
    const f = oneRound({ players: { a: "CT", c: "T", d: "T" }, kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "d" }] });
    const a = openingDuels(f, "a"), c = openingDuels(f, "c");
    expect(a.rows.map((r) => [r.number, r.killer, r.victim, r.weapon, r.traded, r.killerWon])).toEqual([[1, "a", "c", "ak47", false, true]]);
    expect([a.bestWeapon, a.afterKill, c.afterDeath]).toEqual([{ weapon: "ak47", kills: 1, won: 1 }, { rounds: 1, won: 1 }, { rounds: 1, won: 0 }]);
  });
});

describe("situations", () => {
  it("counts each alive-count state a round passed through once, with the round's result", () => {
    // fails if a state is counted from the wrong side or twice: c kills a (CT 1v2), b kills c (1v1) and
    // d, CT wins. b passed 2v2, 1v2 and 1v1 and won; c passed 2v2, 2v1 and 1v1 and lost
    const f = oneRound({
      players: { a: "CT", b: "CT", c: "T", d: "T" },
      kills: [{ tick: t(1), killer: "c", victim: "a" }, { tick: t(2), killer: "b", victim: "c" }, { tick: t(3), killer: "b", victim: "d" }],
    });
    const of = (player: string) => { const out: Situations = {}; addSituations(out, f, { player }); return out; };
    expect(of("b")).toEqual({ "2v2": { rounds: 1, won: 1 }, "1v2": { rounds: 1, won: 1 }, "1v1": { rounds: 1, won: 1 } });
    expect(of("c")).toEqual({ "2v2": { rounds: 1, won: 0 }, "2v1": { rounds: 1, won: 0 }, "1v1": { rounds: 1, won: 0 } });
  });
});

describe("bombsites", () => {
  it("scores take, hold, retake and post-plant per site from the zone entered and the plant", () => {
    // fails if a phase reads the wrong side or the entry is taken after the plant: c walks into Bombsite A
    // and plants there, T wins. c took A and won the post-plant; a failed to hold A and to retake it.
    // d's later visit to Bombsite B, after the plant, is not a take attempt
    const tables = oneRoundTables({
      players: { a: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T", plant_tick: t(5), plant_site: "A" },
      positions: [{ steamid: "c", tick: t(3), x: 0, y: 0, place: "BombsiteA" }, { steamid: "d", tick: t(6), x: 0, y: 0, place: "BombsiteB" }],
    });
    const f = derive(tables, CS2RB);
    const none = { attempts: 0, success: 0 };
    expect(bombsites(tables, f, "c")).toEqual({ A: { take: { attempts: 1, success: 1 }, hold: none, retake: none, postPlant: { attempts: 1, success: 1 } } });
    expect(bombsites(tables, f, "a")).toEqual({ A: { take: none, hold: { attempts: 1, success: 0 }, retake: { attempts: 1, success: 0 }, postPlant: none } });
  });
});
