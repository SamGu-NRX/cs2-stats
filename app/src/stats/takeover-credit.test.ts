// The takeover measures (facts.ts, scoreboard.ts takeovers): what a human makes in a bot's body after
// he dies is credited to the bot, as the game's round stats do, and counted once more on both, so the
// views' switch (ui/data/credit.ts) can move it to him. A synthetic one-round plugin file: the human (H)
// and two bots (A, B) are CT, two enemy bots (E1, E2) are T. Every hit does 20.
import { describe, expect, it, vi } from "vitest";
import { METRICS } from "./metrics";
import { metricDeltas } from "./career";
import { deriveBase } from "./derive";
import { emptyMeasures, type Measures as AllMeasures } from "./facts";
import { yourMatch } from "./matchviews";
import { emptySummary } from "./rollup";
import type { Measure } from "./facts";
import { pluginToTables } from "./plugin/adapter";
import { KILL_FLAG, type MatchFile } from "./plugin/schema";

const KEY = ["76561190000000001", "BOT_A", "BOT_B", "BOT_E1", "BOT_E2"];
const [H, A, B, E1, E2] = [0, 1, 2, 3, 4];

type Kill = [tick: number, killer: number, victim: number, kBody: number | null, vBody: number | null, headshot?: boolean];
type Hit = [tick: number, attacker: number, victim: number];

/** One round from tick 1000 to 5000, every player alive at freeze end, the human recorded without a takeovers table. */
function round(kills: Kill[], hits: Hit[]): MatchFile {
  const z = <T,>(rows: unknown[], v: T) => rows.map(() => v);
  return {
    v: 1, id: "t", map: "de_test", startUtc: "2026-10-25T00:00:00Z", endUtc: "2026-10-25T00:30:00Z", status: "complete",
    env: { plugin: "1.1.0", cssharp: null, game: null, tickrate: 64, maxrounds: 24, botDifficulty: null },
    firstFullRound: 0, weapons: ["ak47"], places: [], human: H,
    players: { key: KEY, name: ["H", "A", "B", "E1", "E2"], isBot: [false, true, true, true, true], startSide: [3, 3, 3, 2, 2] },
    rounds: {
      winSide: [2], how: ["elim"], freezeTick: [1000], durTicks: [4000], bombSite: [null], plantTick: [null], planter: [null],
      defuser: [null], ctSetup: [null], score: [[0, 0]], side: [[3, 3, 3, 2, 2]], equip: [[4000, 4000, 4000, 4000, 4000]], money: [[800, 800, 800, 800, 800]],
      alive0: [[1, 1, 1, 1, 1]],
    },
    kills: {
      ri: z(kills, 0), tick: kills.map((k) => k[0]), killer: kills.map((k) => k[1]), victim: kills.map((k) => k[2]), assister: z(kills, null),
      flashAssister: z(kills, null), weapon: z(kills, 0), flags: kills.map((k) => (k[5] ? KILL_FLAG.headshot : 0)), kpos: z(kills, null), vpos: z(kills, null), state: z(kills, null),
      kBody: kills.map((k) => k[3]), vBody: kills.map((k) => k[4]),
    },
    damage: {
      ri: z(hits, 0), tick: hits.map((h) => h[0]), attacker: hits.map((h) => h[1]), victim: hits.map((h) => h[2]), dmg: z(hits, 20), dmgArmor: z(hits, 0),
      weapon: z(hits, 0), hitgroup: z(hits, null), nade: z(hits, null),
    },
    blinds: { ri: [], tick: [], attacker: [], victim: [], ms: [], flash: [] },
    grenades: { ri: [], tick: [], thrower: [], type: [], pos: [], throw: [] },
    throws: { ri: [], tick: [], thrower: [], type: [], pos: [] },
    pos: { ri: [], tick: [], pi: [], x: [], y: [], z: [], place: [], alive: [] },
    aim: {
      engagements: { ri: [], enemy: [], tVis: [], angVis: [], angVisYaw: [], angVisPitch: [], dist: [], tAimStart: [], tFirstShot: [], tFirstDmg: [], tEnd: [], outcome: [] },
      shots: { ri: [], tick: [], weapon: [], burst: [], idx: [], speed: [], maxSpeed: [], scoped: [], ducked: [], target: [], aimErr: [], impact: [], hit: [] },
    },
  };
}

const SHOWN: Measure[] = [
  "kills", "hsKills", "deaths", "dmg",
  "takeoverKills", "takeoverHsKills", "takeoverDeaths", "takeoverDmg", "drivenKills", "drivenHsKills", "drivenDeaths", "drivenDmg",
];

/** Each player's scoreboard and takeover measures in the round, the zeros left out. */
function measures(m: MatchFile): Record<string, Partial<Record<Measure, number>>> {
  const { facts } = deriveBase(pluginToTables(m));
  return Object.fromEntries(facts.pr.map((r) => [m.players.name[r.pi], Object.fromEntries(SHOWN.filter((k) => r.m[k]).map((k) => [k, r.m[k]]))]));
}

describe("takeover measures", () => {
  it("count two bodies driven in one round on the driver and on each body", () => {
    // H dies in his own body at 1150 and takes over A; A dies at 1400 and he takes over B; he kills E1
    // with B at 1600 (a headshot), and B dies at 1700. He hits E1 in his own body, E2 in A's, E1 in B's.
    // Fails if a body keeps no driven count, if the driver's own-body play is counted as a takeover, or
    // if a body's death is not moved with the rest
    const m = round(
      [[1150, E1, H, null, null], [1400, E2, H, null, A], [1600, H, E1, B, null, true], [1700, E2, H, null, B]],
      [[1140, H, E1], [1300, H, E2], [1401, H, E1]],
    );
    expect(measures(m)).toEqual({
      H: { deaths: 1, dmg: 20, takeoverKills: 1, takeoverHsKills: 1, takeoverDeaths: 2, takeoverDmg: 40 },
      A: { deaths: 1, dmg: 20, drivenDeaths: 1, drivenDmg: 20 },
      B: { kills: 1, hsKills: 1, deaths: 1, dmg: 20, drivenKills: 1, drivenHsKills: 1, drivenDeaths: 1, drivenDmg: 20 },
      E1: { kills: 1, deaths: 1 },
      E2: { kills: 2 },
    });
  });

  it("move a bot body's death to its driver and nothing else when he did no damage in it", () => {
    // fails if a death of a driven body stays only on the body, or is counted on the driver twice
    const m = round([[1150, E1, H, null, null], [1300, E2, H, null, A]], []);
    expect([measures(m).H, measures(m).A]).toEqual([{ deaths: 1, takeoverDeaths: 1 }, { deaths: 1, drivenDeaths: 1 }]);
  });

  it("leave play in no known body uncredited, with no takeover counts", () => {
    // H dies at 1150 and no bot is named after it: his kill at 1600 and his hit at 1500 are in no known
    // body. The kill keeps its row with no attacker, so E1's death still counts; the hit is left out.
    // Fails if either is moved to H or to a bot as a takeover
    const m = round([[1150, E1, H, null, null], [1600, H, E1, null, null]], [[1500, H, E2]]);
    expect(measures(m)).toEqual({ H: { deaths: 1 }, A: {}, B: {}, E1: { kills: 1, deaths: 1 }, E2: {} });
  });

  it("credit the driver with a kill made in a body that has no row that round, and no body loses it", () => {
    // A has no side this round, so no round row and no enemy kill of its own. H dies at 1150, takes A
    // over, and kills E1 with it at 1600, a headshot. Fails if the kill is left uncredited under "You"
    // for want of A's row, or is counted as an enemy kill on its sideless body
    const m = round([[1150, E1, H, null, null], [1600, H, E1, A, null, true]], [[1500, H, E2]]);
    m.rounds.side = [[3, null, 3, 2, 2]];
    const got = measures(m);
    expect(got.H).toEqual({ deaths: 1, takeoverKills: 1, takeoverHsKills: 1, takeoverDmg: 20 });
    expect(got.A).toBeUndefined();
  });

  it("are zero when the tables do not record controllers, as an extractor demo's do not", () => {
    // fails if a missing controller column is read as a takeover by someone
    const p = pluginToTables(round([[1150, E1, H, null, null], [1400, E2, H, null, A], [1600, H, E1, B, null]], [[1300, H, E2]]));
    const none = (col: unknown[]) => col.map(() => null);
    const t = {
      ...p,
      kills: { ...p.kills, attacker_controller_steamid: none(p.kills.attacker_controller_steamid), victim_controller_steamid: none(p.kills.victim_controller_steamid) },
      damages: { ...p.damages, attacker_controller_steamid: none(p.damages.attacker_controller_steamid) },
    };
    const moved = deriveBase(t).facts.pr.flatMap((r) => SHOWN.slice(4).filter((k) => r.m[k]));
    expect(moved).toEqual([]);
  });
});

describe("a player's own comparisons under the takeover credit", () => {
  const sum = (m: Partial<AllMeasures>) => ({ ...emptySummary(), m: { ...emptyMeasures(), ...m } });
  // this match: 5 kills, 5 deaths and 700 damage of his own, and in a bot's body 2 kills and 100
  // damage; before: 6 kills, 4 deaths and 800 damage, no takeover
  const now = sum({ rounds: 10, kills: 5, deaths: 5, dmg: 700, dmgTaken: 600, takeoverKills: 2, takeoverDmg: 100 });
  const before = sum({ rounds: 10, kills: 6, deaths: 4, dmg: 800 });

  it("carry the credited figures for the metrics the credit moves, and only those", () => {
    // fails if ADR or KPR against the earlier figure ignores the takeover play under "You", or a metric
    // that mixes a moved count with an unmoved one (net damage) or does not move (DPR here) gets one
    const d = Object.fromEntries(metricDeltas(now, before).map((x) => [x.id, x]));
    expect([d.adr.value, d.adr.you]).toEqual([70, { value: 80, before: 80, delta: 0, direction: "same" }]);
    expect(d.kpr.you).toEqual({ value: 0.7, before: 0.6, delta: expect.closeTo(0.1, 9), direction: "better" });
    expect([d.netDamage.you, d.dpr.you]).toEqual([undefined, undefined]);
  });

  it("name the earlier figure average in this match against recent ones, under either credit", () => {
    // fails if the match card's row loses its "You" figures or keeps them under the delta's names
    const adr = yourMatch(now, before).find((r) => r.id === "adr")!;
    expect([adr.average, adr.you]).toEqual([80, { value: 80, average: 80, delta: 0, direction: "same" }]);
  });
});

describe("the takeover pass over a player's comparisons", () => {
  it("evaluates only the metrics the credit moves, and nothing without a takeover", () => {
    // fails if the "You" pass reads KAST (no takeover moves it) or runs at all without takeover play:
    // KAST is read once per summary in the game's pass, so twice in all
    const sum = (m: Partial<AllMeasures>) => ({ ...emptySummary(), m: { ...emptyMeasures(), ...m } });
    const kast = METRICS.find((x) => x.id === "kast")!;
    const spy = vi.spyOn(kast, "value");
    try {
      metricDeltas(sum({ rounds: 10, kills: 5 }), sum({ rounds: 10, kills: 6 }));
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockClear();
      metricDeltas(sum({ rounds: 10, kills: 5, takeoverKills: 2 }), sum({ rounds: 10, kills: 6 }));
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
