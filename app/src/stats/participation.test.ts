// Who took part in a round (rules.ts onRoster, roundPopulation, liveKill): the scoreboard, KAST, time
// alive, saves, openings, trades, clutches and the man-advantage states, on hand-built rounds. CT a and
// b against T c and d unless a test says otherwise; round 1 freezes until FREEZE_END.
import { describe, expect, it } from "vitest";
import { addSituations, type Situations } from "./matchviews";
import { rollup } from "./rollup";
import { FREEZE_END, oneRound, type OneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;
const m = (f: ReturnType<typeof oneRound>, p: string) => rollup([f], { player: p }).m;
const pick = (f: ReturnType<typeof oneRound>, p: string, keys: (keyof ReturnType<typeof m>)[]) => keys.map((k) => m(f, p)[k]);
const states = (f: ReturnType<typeof oneRound>, p: string) => { const out: Situations = {}; addSituations(out, f, { player: p }); return out; };
const round = (o: Partial<OneRound>) => oneRound({ players: { a: "CT", b: "CT", c: "T", d: "T" }, ...o });

describe("who took part in a round", () => {
  it("leaves a player the source marks dead at freeze end out of the round entirely", () => {
    // fails if b, marked dead at freeze end, gets the round: a round played, survival and KAST 100%.
    // b never played it, so b's rounds are 0 and the round is not in b's KAST either
    const f = round({ player_rounds: { b: { alive_at_start: false } }, kills: [{ tick: t(10), killer: "a", victim: "c" }] });
    expect(pick(f, "b", ["rounds", "won", "kast", "survived", "aliveSecs"])).toEqual([0, 0, 0, 0, 0]);
    expect(f.pr.some((r) => f.players[r.pi].id === "b")).toBe(false);
    expect(pick(f, "a", ["rounds", "kast", "survived"])).toEqual([1, 1, 1]);
  });

  it("counts the round for a player who disconnected alive, without survival, KAST by survival or a save", () => {
    // fails if a disconnect reads as surviving: b leaves at 20 s and never dies. b played the round
    // (it counts), was alive 20 s, was gone before the plant at 30 s, did not survive, earned no KAST
    // and, the round lost, saved nothing
    const f = round({
      roundRow: { winner_side: "T", plant_tick: t(30) },
      leaves: [{ tick: t(20), steamid: "b", alive: true }],
      kills: [{ tick: t(40), killer: "c", victim: "a" }],
    });
    expect(pick(f, "b", ["rounds", "lostRounds", "survived", "kast", "kastS", "saves", "aliveAtPlant", "postPlantRounds"])).toEqual([1, 1, 0, 0, 0, 0, 0, 1]);
    expect(m(f, "b").aliveSecs).toBeCloseTo(20);
  });

  it("keeps the kill of a player who disconnected after it: KAST by the kill, not by survival", () => {
    // fails if the disconnect wipes the kill's KAST, or survival is credited: b kills c at 5 s, then
    // leaves at 20 s
    const f = round({ leaves: [{ tick: t(20), steamid: "b", alive: true }], kills: [{ tick: t(5), killer: "b", victim: "c" }] });
    expect(pick(f, "b", ["rounds", "kills", "kast", "killRounds", "kastS", "survived", "openingKills"])).toEqual([1, 1, 1, 1, 0, 0, 1]);
    expect(m(f, "b").aliveSecs).toBeCloseTo(20);
  });

  it("counts a death before freeze end as a death in a round played, but never as an opening or a trade", () => {
    // fails if a kill before freeze end is an opening duel or a trade, or its victim keeps survival or
    // KAST. c kills b 1 s before freeze end (as the bomb of the round before does in the data); the live
    // round's first kill is a's on c at 5 s, the opening, and d's kill on a at 7 s trades c, not b
    const f = round({
      roundRow: { winner_side: "T" },
      kills: [{ tick: FREEZE_END - 64, killer: "c", victim: "b" }, { tick: t(5), killer: "a", victim: "c" }, { tick: t(7), killer: "d", victim: "a" }],
    });
    expect(pick(f, "b", ["rounds", "deaths", "survived", "kast", "openingDeaths", "tradedDeaths", "aliveSecs"])).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(pick(f, "c", ["kills", "openingKills", "tradeKills", "kast"])).toEqual([1, 0, 0, 1]);
    expect(pick(f, "a", ["openingKills", "tradedDeaths"])).toEqual([1, 0]);
    expect(pick(f, "c", ["openingDeaths", "tradedDeaths"])).toEqual([1, 1]);
    expect(pick(f, "d", ["tradeKills"])).toEqual([1]);
    // b was never in the live round: a starts alone, the man-advantage states begin at 1v2
    expect(f.clutches.map((c) => [f.players[c.pi].id, c.opponents, c.t])).toEqual([["a", 2, 0], ["d", 1, 5]]);
    expect(states(f, "a")).toEqual({ "1v2": { rounds: 1, won: 0 }, "1v1": { rounds: 1, won: 0 } });
  });

  it("agrees across the scoreboard, KAST, openings, clutches and the man-advantage states on one round", () => {
    // fails if any of these views reads another population. e is marked dead at freeze end and b leaves
    // at 5 s: CT starts 2v2 (a and b), a is alone from 5 s, kills c at 10 s (the opening; d is left alone
    // too) and dies to d at 20 s, T winning
    const f = oneRound({
      players: { a: "CT", b: "CT", e: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T" },
      player_rounds: { e: { alive_at_start: false } },
      leaves: [{ tick: t(5), steamid: "b", alive: true }],
      kills: [{ tick: t(10), killer: "a", victim: "c" }, { tick: t(20), killer: "d", victim: "a" }],
    });
    const ids = ["a", "b", "e", "c", "d"];
    expect(ids.map((p) => m(f, p).rounds)).toEqual([1, 1, 0, 1, 1]);
    expect(ids.map((p) => m(f, p).kast)).toEqual([1, 0, 0, 0, 1]);
    expect(ids.map((p) => m(f, p).survived)).toEqual([0, 0, 0, 0, 1]);
    expect(ids.map((p) => [m(f, p).openingKills, m(f, p).openingDeaths])).toEqual([[1, 0], [0, 0], [0, 0], [0, 1], [0, 0]]);
    expect(f.clutches.map((c) => [f.players[c.pi].id, c.opponents, c.won, c.kills, c.t])).toEqual([["a", 2, false, 1, 5], ["d", 1, true, 1, 10]]);
    expect(states(f, "a")).toEqual({ "2v2": { rounds: 1, won: 0 }, "1v2": { rounds: 1, won: 0 }, "1v1": { rounds: 1, won: 0 } });
    expect(states(f, "e")).toEqual({});
  });
});
