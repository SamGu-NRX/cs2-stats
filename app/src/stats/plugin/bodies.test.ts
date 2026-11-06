// What a human does in a bot's body after a takeover belongs to the bot (bodies.ts, adapter.ts), on a
// synthetic one-round file. The human (H) and two bots (A, B) are CT; two enemy bots (E1, E2) are T.
import { describe, expect, it } from "vitest";
import { pluginToTables } from "./adapter";
import { validateMatch, type MatchFile, type Takeovers } from "./schema";

const KEY = ["76561190000000001", "BOT_A", "BOT_B", "BOT_E1", "BOT_E2"];
const NAME: Record<string, string> = Object.fromEntries(KEY.map((k, i) => [k, ["H", "A", "B", "E1", "E2"][i]]));
const [H, A, B, E1, E2] = [0, 1, 2, 3, 4];

type Kill = [tick: number, killer: number, victim: number, kBody: number | null, vBody: number | null];
type Hit = [tick: number, attacker: number, victim: number, nade?: number];

/**
 * One round from tick 1000 to 5000. The human throws an HE at 1100 that detonates at 1200 (grenades
 * row 0, throws row 0); `extra` adds rows to the base. Kills and hits are listed per test.
 */
function round(kills: Kill[], hits: Hit[], extra: Partial<MatchFile> = {}): MatchFile {
  const none = { ri: [], tick: [] };
  const z = <T,>(rows: unknown[], v: T) => rows.map(() => v);
  return {
    v: 1, id: "t", map: "de_test", startUtc: "2026-10-25T00:00:00Z", endUtc: "2026-10-25T00:30:00Z", status: "complete",
    env: { plugin: "1.1.0", cssharp: null, game: null, tickrate: 64, maxrounds: 24, botDifficulty: null },
    firstFullRound: 0, weapons: ["ak47", "hegrenade"], places: [], human: H,
    players: { key: KEY, name: KEY.map((k) => NAME[k]), isBot: [false, true, true, true, true], startSide: [3, 3, 3, 2, 2] },
    rounds: {
      winSide: [2], how: ["elim"], freezeTick: [1000], durTicks: [4000], bombSite: [null], plantTick: [null], planter: [null],
      defuser: [null], ctSetup: [null], score: [[0, 0]], side: [[3, 3, 3, 2, 2]], equip: [[4000, 4000, 4000, 4000, 4000]], money: [[800, 800, 800, 800, 800]],
    },
    kills: {
      ri: z(kills, 0), tick: kills.map((k) => k[0]), killer: kills.map((k) => k[1]), victim: kills.map((k) => k[2]), assister: z(kills, null),
      flashAssister: z(kills, null), weapon: z(kills, 0), flags: z(kills, 0), kpos: z(kills, null), vpos: z(kills, null), state: z(kills, null),
      kBody: kills.map((k) => k[3]), vBody: kills.map((k) => k[4]),
    },
    damage: {
      ri: z(hits, 0), tick: hits.map((h) => h[0]), attacker: hits.map((h) => h[1]), victim: hits.map((h) => h[2]), dmg: z(hits, 20), dmgArmor: z(hits, 0),
      weapon: hits.map((h) => (h[3] === undefined ? 0 : 1)), hitgroup: z(hits, null), nade: hits.map((h) => h[3] ?? null),
    },
    blinds: { ...none, attacker: [], victim: [], ms: [], flash: [] },
    grenades: { ri: [0], tick: [1200], thrower: [H], type: ["he"], pos: [[0, 0, 0]], throw: [0] },
    throws: { ri: [0], tick: [1100], thrower: [H], type: ["he"], pos: [[0, 0, 0]] },
    pos: { ...none, pi: [], x: [], y: [], z: [], place: [], alive: [] },
    aim: {
      engagements: { ri: [], enemy: [], tVis: [], angVis: [], angVisYaw: [], angVisPitch: [], dist: [], tAimStart: [], tFirstShot: [], tFirstDmg: [], tEnd: [], outcome: [] },
      shots: { ri: [], tick: [], weapon: [], burst: [], idx: [], speed: [], maxSpeed: [], scoped: [], ducked: [], target: [], aimErr: [], impact: [], hit: [] },
    },
    ...extra,
  };
}

/** Damage rows as "tick attacker>victim". */
const hits = (m: MatchFile) => {
  const d = pluginToTables(m).damages;
  return d.tick.map((t, i) => `${t} ${NAME[d.attacker_steamid[i]!]}>${NAME[d.victim_steamid[i]]}`);
};

// The human dies in his own body at 1150 and takes over A; A dies at 1400 and he takes over B; he kills
// E1 with B at 1600, and B dies at 1700.
const TWO: Kill[] = [[1150, E1, H, null, null], [1400, E2, H, null, A], [1600, H, E1, B, null], [1700, E2, H, null, B]];

describe("rows made in a bot's body", () => {
  it("go to each of two bodies a human takes over in one round, as attacker and as victim", () => {
    // fails if damage after the human's own death stays his (his ADR then counts the bots'), if a body's
    // death-tick hit leaves it, or if a hit on the body the human drives stays a hit on the human
    expect(hits(round(TWO, [[1140, H, E1], [1300, H, E2], [1350, E2, H], [1400, H, E2], [1401, H, E1], [1650, E2, H]]))).toEqual([
      "1140 H>E1", "1300 A>E2", "1350 E2>A", "1400 A>E2", "1401 B>E1", "1650 E2>B",
    ]);
  });

  it("credit a grenade by its throw: one thrown before death that hurts after a takeover stays the human's", () => {
    // fails if a grenade hit is read at its own tick, which falls inside the takeover of A
    const m = round(TWO, [[1210, H, E1, 0]]);
    expect(hits(m)).toEqual(["1210 H>E1"]);
    const t = pluginToTables(m);
    expect([t.grenade_throws!.steamid, t.grenade_events!.steamid].map((c) => c.map((x) => NAME[x!]))).toEqual([["H"], ["H"]]);
  });

  it("are left out after the last body the kills name, where the file cannot say whose body it was", () => {
    // fails if a hit after B's death, when the human's own body is dead and no other is named, is
    // credited to the human; a hit on him there keeps him as the victim, so E2's damage still counts
    expect(hits(round(TWO, [[1800, H, E2], [1850, E2, H]]))).toEqual(["1850 E2>H"]);
  });

  it("leave out the human's shots in a bot's body", () => {
    // fails if bullets fired from A's body reach the human's aim
    const m = round(TWO, []);
    const at = [1100, 1300, 1500];
    const col = <T,>(v: T) => at.map(() => v);
    m.aim.shots = { ri: col(0), tick: at, weapon: col(0), burst: col(0), idx: col(1), speed: col(0), maxSpeed: col(215), scoped: col(false), ducked: col(false), target: col(null), aimErr: col(null), impact: col(null), hit: col(null) };
    expect(pluginToTables(m).shots!.tick).toEqual([1100]);
  });

  it("stay the human's in a round where he died in his own body more than once (a respawn mode)", () => {
    // fails if the deathmatch-like sessions, where a death respawns the human, lose his damage after his first death
    expect(hits(round([[1150, E1, H, null, null], [1500, E1, H, null, null]], [[1300, H, E2]]))).toEqual(["1300 H>E2"]);
  });
});

describe("the takeovers table (plugin 1.3.0)", () => {
  const takeovers = (rows: [tick: number, body: number | null][]): Takeovers => ({ ri: rows.map(() => 0), tick: rows.map((r) => r[0]), pi: rows.map(() => H), body: rows.map((r) => r[1]) });

  it("names a body the kills cannot", () => {
    // fails if the table is ignored: A survives and kills no one, so the kills name no body, and
    // without the table the hit at 1300 is left out
    const m = round([[1150, E1, H, null, null]], [[1140, H, E1], [1300, H, E2]], { takeovers: takeovers([[1151, A]]) });
    expect(hits(m)).toEqual(["1140 H>E1", "1300 A>E2"]);
    expect(hits({ ...m, takeovers: undefined })).toEqual(["1140 H>E1"]);
  });

  it("reads each row from its tick, so the end row at a body's death tick + 1 keeps a same-tick trade with the body", () => {
    // fails if a row is applied before its tick (the hit at 1400 would leave A) or the end row is
    // ignored (the hit at 1410 would stay with A, which is dead); null puts the human back in his own
    // or no pawn, so that row is his
    const kills: Kill[] = [[1150, E1, H, null, null], [1400, E2, H, null, A]];
    const m = round(kills, [[1300, H, E2], [1400, H, E2], [1410, H, E1]], { takeovers: takeovers([[1151, A], [1401, null]]) });
    expect(hits(m)).toEqual(["1300 A>E2", "1400 A>E2", "1410 H>E1"]);
  });

  it("falls back to the kills when the plugin dropped takeover rows", () => {
    // fails if a table missing rows (recon.dropped.takeovers) is trusted: here its end row was lost, so it
    // would keep the human in A after A died
    const m = round(TWO, [[1500, H, E1]], { takeovers: takeovers([[1151, A]]), recon: { dropped: { takeovers: 1 } } });
    expect(hits(m)).toEqual(["1500 B>E1"]);
  });

  it("rejects a row that names the player's own body or no player", () => {
    // fails if a malformed row loads and credits the wrong player
    const bad = (t: Takeovers) => () => validateMatch(round([], [], { takeovers: t }), "t.json.gz");
    expect(bad(takeovers([[1151, H]]))).toThrow("takeovers.body[0] is 0, expected null or another player's index 0..4");
    expect(bad({ ...takeovers([[1151, A]]), pi: [9] })).toThrow("takeovers.pi[0] is 9, expected a player index 0..4");
    expect(bad({ ri: [0], tick: [1], pi: [H] } as unknown as Takeovers)).toThrow('column "takeovers.body" is missing or not an array');
  });
});
