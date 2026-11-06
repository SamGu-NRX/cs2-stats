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
 * One round from tick 1000 to 5000, every player alive at freeze end. The human throws an HE at 1100
 * that detonates at 1200 (grenades row 0, throws row 0); `extra` adds rows to the base. Kills and hits
 * are listed per test.
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
      alive0: [[1, 1, 1, 1, 1]],
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

  it("count a grenade with a bad throw link as unlinked, keeping its detonation with no thrower", () => {
    // fails if a link out of range, to another round's throw or to another thrower's throw is followed:
    // each would give the human the HE that detonates at 1200, inside A's takeover before the file names
    // A (A is first seen dying at 1400). Unlinked, the hit is left out and the detonation has no thrower
    const linked = (link: Partial<MatchFile>) => {
      const m = round(TWO, [[1210, H, E1, 0]], link);
      return [hits(m), pluginToTables(m).grenade_events!.steamid];
    };
    const throwRow = { ri: [0], tick: [1100], thrower: [H], type: ["he" as const], pos: [[0, 0, 0] as [number, number, number]] };
    const he = { ri: [0], tick: [1200], thrower: [H], type: ["he" as const], pos: [[0, 0, 0] as [number, number, number]] };
    expect(linked({ grenades: { ...he, throw: [5] } })).toEqual([[], [null]]);
    expect(linked({ throws: { ...throwRow, ri: [1] } })).toEqual([[], [null]]);
    expect(linked({ throws: { ...throwRow, thrower: [A] } })).toEqual([[], [null]]);
  });

  it("give an unlinked grenade a bot body only once the file has named that bot", () => {
    // fails if a detonation tick stands in for the throw inside a takeover that began implicitly: A
    // starts the tick after the human's death at 1150 but is first named by his kill at 1300, so an
    // unlinked HE detonating at 1250 is left out, one detonating at 1350 is A's
    const kills: Kill[] = [[1150, E1, H, null, null], [1300, H, E1, A, null], [1400, E2, H, null, A]];
    const at = (tick: number) => hits(round(kills, [[tick + 10, H, E2, 0]], { grenades: { ri: [0], tick: [tick], thrower: [H], type: ["he"], pos: [[0, 0, 0]], throw: [null] } }));
    expect([at(1250), at(1350)]).toEqual([[], [`1360 A>E2`]]);
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

  it("stay the human's after a freeze-time death he respawned from", () => {
    // fails if a freeze-time death, which the kills table leaves out, starts a takeover: the human dies
    // at 900 before freeze end, is alive at freeze end, and plays the live round in his own body, so
    // his hit, shot and position at 1300 are his and not dropped
    const m = round([[900, E1, H, null, null]], [[1300, H, E2]]);
    m.kills.flags = [128];
    m.rounds.alive0 = [[1, 1, 1, 1, 1]];
    m.aim.shots = { ri: [0], tick: [1300], weapon: [0], burst: [0], idx: [1], speed: [0], maxSpeed: [215], scoped: [false], ducked: [false], target: [null], aimErr: [null], impact: [null], hit: [null] };
    m.pos = { ri: [0], tick: [1300], pi: [H], x: [0], y: [0], z: [0], place: [null], alive: [true] };
    const t = pluginToTables(m);
    expect([hits(m), t.shots!.tick, t.positions!.steamid.map((x) => NAME[x])]).toEqual([["1300 H>E2"], [1300], ["H"]]);
  });

  it("give a human dead at freeze end only the bodies the kills name, from their first kills row", () => {
    // fails if a human with no own body in the live round (rounds.alive0 = 0) keeps his rows, or if a
    // body is assumed before the file names it: A is named by his kill at 1600, so his hit at 1300 is
    // left out and the hits at 1600 and 1700 are A's
    const named = round([[1600, H, E1, A, null]], [[1300, H, E2], [1600, H, E1], [1700, H, E2]]);
    named.rounds.alive0 = [[0, 1, 1, 1, 1]];
    expect(hits(named)).toEqual(["1600 A>E1", "1700 A>E2"]);
    const none = round([], [[1300, H, E2]]);
    none.rounds.alive0 = [[0, 1, 1, 1, 1]];
    expect(hits(none)).toEqual([]);
  });

  it("keep the kills' bodies when the human's own death is missing", () => {
    // fails if a missing own-death row throws away the kBody the kills record: alive at freeze end, he
    // kills E1 in his own body at 1200, the file never records his death, and his kill at 1600 names A.
    // His hit at 1200 is his, the hit at 1300 falls between the two kills and is left out, and the
    // hits at 1600 and 1700 are A's
    const m = round([[1200, H, E1, null, null], [1600, H, E2, A, null]], [[1200, H, E1], [1300, H, E2], [1600, H, E2], [1700, H, E2]]);
    m.rounds.alive0 = [[1, 1, 1, 1, 1]];
    expect(hits(m)).toEqual(["1200 H>E1", "1600 A>E2", "1700 A>E2"]);
  });

  it("end a body with no recorded death at its last kills row when another body follows", () => {
    // fails if a body that never died is held until the next one's first row, or if the last body
    // stops before round end: own death at 1150 (hit that tick is his), A kills at 1300 and is never
    // seen dying, B kills at 1600. 1200 and 1300 are A's, 1400 is in no body, 1600 and 1800 are B's
    const kills: Kill[] = [[1150, E1, H, null, null], [1300, H, E1, A, null], [1600, H, E2, B, null]];
    expect(hits(round(kills, [[1150, H, E2], [1200, H, E2], [1300, H, E1], [1400, H, E2], [1600, H, E2], [1800, H, E1]]))).toEqual([
      "1150 H>E2", "1200 A>E2", "1300 A>E1", "1600 B>E2", "1800 B>E1",
    ]);
  });

  it("start a body seen again after another body at its next kills row, not after the other's death", () => {
    // fails if a reused body's second use starts the tick after B's death and overlaps the gap: own
    // death 1150, A kills at 1300 and is never seen dying, B kills at 1500 and dies at 1600, A kills
    // again at 1800. 1450 and 1700 are in no body; B runs 1500..1600; A's second use starts at 1800
    const kills: Kill[] = [[1150, E1, H, null, null], [1300, H, E1, A, null], [1500, H, E2, B, null], [1600, E2, H, null, B], [1800, H, E2, A, null]];
    expect(hits(round(kills, [[1300, H, E1], [1450, H, E2], [1550, H, E2], [1600, H, E1], [1700, H, E2], [1800, H, E2]]))).toEqual([
      "1300 A>E1", "1550 B>E2", "1600 B>E1", "1800 A>E2",
    ]);
  });

  it("keep a kill made in no known body, with no attacker, so the victim's death still counts", () => {
    // fails if the kill row is dropped (E2's death would vanish) or credited to the human, whose own
    // body died at 1150 and who is named in no bot
    const t = pluginToTables(round([[1150, E1, H, null, null], [1300, H, E2, null, null]], []));
    expect([t.kills.attacker_steamid, t.kills.victim_steamid.map((x) => NAME[x])]).toEqual([["BOT_E1", null], ["H", "E2"]]);
  });

  it("resume the human's own body at a respawn, shown by his next alive position row", () => {
    // fails if one death ends his own body for the round in a session that respawns him, or if a death
    // with no alive row after it is read as a respawn: he dies at 1150, is seen alive at 1300, dies
    // again at 1500. 1200 is in no body; 1300 and 1400 are his; 1600 is in no body
    const alive = (ticks: number[]): MatchFile["pos"] => ({ ri: ticks.map(() => 0), tick: ticks, pi: ticks.map(() => H), x: ticks.map(() => 0), y: ticks.map(() => 0), z: ticks.map(() => 0), place: ticks.map(() => null), alive: ticks.map(() => true) });
    const kills: Kill[] = [[1150, E1, H, null, null], [1500, E1, H, null, null]];
    const shots: Hit[] = [[1200, H, E2], [1300, H, E2], [1400, H, E2], [1600, H, E2]];
    expect(hits(round(kills, shots, { pos: alive([1100, 1300]) }))).toEqual(["1300 H>E2", "1400 H>E2"]);
    expect(hits(round(kills.slice(0, 1), shots, { pos: alive([1100]) }))).toEqual([]);
  });

  it("use the timeline for a kill whose kBody or vBody entry is missing, and keep an explicit entry", () => {
    // fails if an absent or short column falls back to the controller: the takeovers table puts the
    // human in A from 1151 to 1400, so his kill at 1300 and his death at 1400 are A's; an explicit kBody
    // of B on the kill outranks the table
    const kills: Kill[] = [[1150, E1, H, null, null], [1300, H, E2, null, null], [1400, E1, H, null, null]];
    const t = (k: Partial<MatchFile["kills"]>) => {
      const m = round(kills, [], { takeovers: { ri: [0, 0], tick: [1151, 1401], pi: [H, H], body: [A, null] } });
      m.kills = { ...m.kills, kBody: undefined, vBody: undefined, ...k };
      const x = pluginToTables(m).kills;
      return x.attacker_steamid.map((a, i) => `${NAME[a!]}>${NAME[x.victim_steamid[i]]}`);
    };
    expect(t({})).toEqual(["E1>H", "A>E2", "E1>A"]);
    expect(t({ kBody: [null], vBody: [null] })).toEqual(["E1>H", "A>E2", "E1>A"]);
    expect(t({ kBody: [null, B, null], vBody: [null, null, null] })).toEqual(["E1>H", "B>E2", "E1>H"]);
  });

  it("read a death with no vBody entry inside a takeover as the bot's, so the dead human stays dead after it", () => {
    // fails if the missing entry at 1400 is taken for his own death, or his real death at 1150 is
    // missed, either of which brings his own body back after the end row at 1401: his hit at 1450 is in
    // no body and left out
    const kills: Kill[] = [[1150, E1, H, null, null], [1400, E1, H, null, null]];
    const m = round(kills, [[1300, H, E2], [1450, H, E2]], { takeovers: { ri: [0, 0], tick: [1151, 1401], pi: [H, H], body: [A, null] } });
    m.kills = { ...m.kills, kBody: undefined, vBody: undefined };
    expect(hits(m)).toEqual(["1300 A>E2"]);
  });

  it("credit an unlinked grenade kill with kBody null to the human only while his own body is alive", () => {
    // fails if kBody null on an unlinked grenade kill is always read as his own pawn, or never: alive at
    // 1140 his HE kill is his; after his death at 1150 he is in no body, so the kill at 1210 has no attacker
    const kills: Kill[] = [[1140, H, E2, null, null], [1150, E1, H, null, null], [1210, H, E1, null, null]];
    const m = round(kills, []);
    m.kills.weapon = [1, 0, 1];
    expect(pluginToTables(m).kills.attacker_steamid.map((a) => (a === null ? null : NAME[a]))).toEqual(["H", "E1", null]);
  });

  it("start the human's own body at his first own-body sighting when alive0 is missing", () => {
    // fails if a round with no alive0 for the human leaves his own body unknown all round despite a gun
    // kill with kBody null at 1300, or assumes it from round start: 1200 stays unresolved. A grenade kill
    // is no such sighting
    const at = (weapon: number) => {
      const m = round([[1300, H, E2, null, null]], [[1200, H, E2], [1300, H, E2], [1400, H, E1]]);
      m.rounds.alive0 = [[null, 1, 1, 1, 1]];
      m.kills.weapon = [weapon];
      return hits(m);
    };
    expect(at(0)).toEqual(["1300 H>E2", "1400 H>E1"]);
    expect(at(1)).toEqual([]);
  });

  it("give a throw rebuilt from a detonation a bot body only once the file has named that bot", () => {
    // fails if a file with no throw log credits a rebuilt throw by its detonation tick like a logged
    // throw: A starts after the human's death at 1150 but is first named at 1300, so the throw rebuilt at
    // 1250 is left out and the one at 1350 is A's
    const kills: Kill[] = [[1150, E1, H, null, null], [1300, H, E1, A, null], [1400, E2, H, null, A]];
    const m = round(kills, [], { grenades: { ri: [0, 0], tick: [1250, 1350], thrower: [H, H], type: ["he", "he"], pos: [[0, 0, 0], [0, 0, 0]] }, throws: undefined });
    const t = pluginToTables(m);
    expect([t.grenade_throws!.tick, t.grenade_throws!.steamid.map((x) => NAME[x!])]).toEqual([[1350], ["A"]]);
  });

  it("take no grenade kill with kBody null as evidence of the human's own body", () => {
    // fails if a posthumous HE kill extends his own body: alive at freeze end, he kills E1 with a gun at
    // 1100, his death is not recorded, his HE kills E2 at 1250 with kBody null (no pawn), and his kill at
    // 1600 names A. His own body ends at 1100, so the hit at 1200 is in no body and left out
    const kills: Kill[] = [[1100, H, E1, null, null], [1250, H, E2, null, null], [1600, H, E2, A, null]];
    const m = round(kills, [[1100, H, E1], [1200, H, E2], [1600, H, E2]]);
    m.kills.weapon = [0, 1, 0];
    expect(hits(m)).toEqual(["1100 H>E1", "1600 A>E2"]);
  });

  it("credit a grenade or fire kill to the body that threw it, even after the thrower died", () => {
    // fails if a grenade kill's kBody null, which the plugin writes when the thrower has no pawn at all,
    // is read as his own body (the timeline puts him in none, so the attacker is cleared), or if a kBody
    // naming the bot he drives at the kill outranks the throw. He throws an HE at 1100 and a molotov at
    // 1120, dies at 1150, and they kill at 1210 and 1300
    const two = (o: { links?: (number | null)[]; kBody?: (number | null)[] } = {}) => {
      const kills: Kill[] = [[1150, E1, H, null, null], [1210, H, E2, o.kBody?.[0] ?? null, null], [1300, H, E1, o.kBody?.[1] ?? null, null]];
      const m = round(kills, [], {
        weapons: ["ak47", "hegrenade", "inferno"],
        grenades: { ri: [0, 0], tick: [1200, 1250], thrower: [H, H], type: ["he", "molotov"], pos: [[0, 0, 0], [0, 0, 0]], throw: [0, 1] },
        throws: { ri: [0, 0], tick: [1100, 1120], thrower: [H, H], type: ["he", "molotov"], pos: [[0, 0, 0], [0, 0, 0]] },
      });
      m.kills.weapon = [0, 1, 2];
      m.kills.nade = [null, ...(o.links ?? [0, 1])];
      return pluginToTables(m).kills.attacker_steamid.map((a) => (a === null ? null : NAME[a]));
    };
    expect(two()).toEqual(["E1", "H", "H"]);
    // unlinked, the kill tick stands in and he is in no body there: the kill keeps no attacker
    expect(two({ links: [null, null] })).toEqual(["E1", null, null]);
    // linked, a kBody naming A at the kill is where he is then, not where the grenades were thrown
    expect(two({ kBody: [A, A] })).toEqual(["E1", "H", "H"]);
    // unlinked, a kBody naming A stands: nothing says when they were thrown
    expect(two({ links: [null, null], kBody: [A, A] })).toEqual(["E1", "A", "A"]);
  });

  it("give grenade damage with no grenade link a bot body only once the file has named that bot", () => {
    // fails if HE damage whose damage.nade is null is read at its hit tick like a bullet: A starts the
    // tick after the human's death at 1150 but is first named by his kill at 1300, so the HE hit at 1250
    // is left out while a bullet at 1250 is A's, and an HE hit at 1350 is A's
    const kills: Kill[] = [[1150, E1, H, null, null], [1300, H, E1, A, null], [1400, E2, H, null, A]];
    const m = round(kills, [[1250, H, E2], [1250, H, E2], [1350, H, E2]]);
    m.damage.weapon = [1, 0, 1];
    expect(hits(m)).toEqual(["1250 A>E2", "1350 A>E2"]);
    expect(pluginToTables(m).damages.weapon).toEqual(["ak47", "hegrenade"]);
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

  it("reads each row from its tick, and an end row after his own death leaves the human in no body", () => {
    // fails if a row is applied before its tick (the hit at 1400 would leave A), or the end row at A's
    // death tick + 1 returns him to his own body, which died at 1150: the hit at 1410 is left out
    const kills: Kill[] = [[1150, E1, H, null, null], [1400, E2, H, null, A]];
    const m = round(kills, [[1300, H, E2], [1400, H, E2], [1410, H, E1]], { takeovers: takeovers([[1151, A], [1401, null]]) });
    expect(hits(m)).toEqual(["1300 A>E2", "1400 A>E2"]);
  });

  it("returns the human to his own body on a null row only while that body is alive", () => {
    // fails if a null row with no recorded own death leaves him in no body, or his own death is not
    // applied the tick after it: he drives A from 1200 to 1299, is back in his own body from 1300, and
    // dies there at 1500
    const kills: Kill[] = [[1500, E1, H, null, null]];
    const m = round(kills, [[1250, H, E2], [1350, H, E2], [1500, H, E1], [1501, H, E1]], { takeovers: takeovers([[1200, A], [1300, null]]) });
    expect(hits(m)).toEqual(["1250 A>E2", "1350 H>E2", "1500 H>E1"]);
  });

  it("starts a human dead at freeze end in no body", () => {
    // fails if rounds.alive0 = 0 is ignored on this path: his hit at 1300, before the row naming A, is left out
    const m = round([], [[1300, H, E2], [1600, H, E2]], { takeovers: takeovers([[1500, A]]) });
    m.rounds.alive0 = [[0, 1, 1, 1, 1]];
    expect(hits(m)).toEqual(["1600 A>E2"]);
  });

  it("gives the bot the human's position row only when the bot has none of its own that second", () => {
    // fails if a row in A's body repeats A's own row under the human or under A, or is lost when A has
    // no row: A has a row at 1290, none near 1600
    const m = round([[1150, E1, H, null, null]], [], { takeovers: takeovers([[1151, A]]) });
    m.pos = { ri: [0, 0, 0], tick: [1290, 1300, 1600], pi: [A, H, H], x: [1, 2, 3], y: [0, 0, 0], z: [0, 0, 0], place: [null, null, null], alive: [true, true, true] };
    const t = pluginToTables(m);
    expect(t.positions!.tick.map((x, i) => `${x} ${NAME[t.positions!.steamid[i]]} ${t.positions!.x[i]}`)).toEqual(["1290 A 1", "1600 A 3"]);
  });

  it("falls back to the kills when the plugin dropped takeover rows", () => {
    // fails if a table missing rows (recon.dropped.takeovers) is trusted: here its end row was lost, so it
    // would keep the human in A after A died
    const m = round(TWO, [[1500, H, E1]], { takeovers: takeovers([[1151, A]]), recon: { dropped: { takeovers: 1 } } });
    expect(hits(m)).toEqual(["1500 B>E1"]);
  });

  it("rejects a row for another player or a body that is not a bot", () => {
    // fails if a malformed row loads and credits the wrong player
    const bad = (t: Takeovers) => () => validateMatch(round([], [], { takeovers: t }), "t.json.gz");
    expect(bad(takeovers([[1151, A]]))).not.toThrow();
    expect(bad(takeovers([[1151, H]]))).toThrow("takeovers.body[0] is 0, expected null or a bot's index");
    expect(bad(takeovers([[1151, 9]]))).toThrow("takeovers.body[0] is 9, expected null or a bot's index");
    expect(bad({ ...takeovers([[1151, B]]), pi: [A] })).toThrow("takeovers.pi[0] is 1, expected the human's index 0");
    expect(bad({ ri: [0], tick: [1], pi: [H] } as unknown as Takeovers)).toThrow('column "takeovers.body" is missing or not an array');
  });

  it("rejects a kBody or vBody entry that is not null or a player index, and accepts an absent or short column", () => {
    // fails if a bad body index loads and credits a player who does not exist
    const kills: Kill[] = [[1150, E1, H, null, null], [1300, H, E2, A, null]];
    const load = (k: Partial<MatchFile["kills"]>) => () => {
      const m = round(kills, []);
      m.kills = { ...m.kills, ...k };
      return validateMatch(m, "t.json.gz");
    };
    expect(load({})).not.toThrow();
    expect(load({ kBody: undefined, vBody: [null] })).not.toThrow();
    expect(load({ kBody: [null, 9] })).toThrow("kills.kBody[1] is 9, expected null or a player index 0..4");
    expect(load({ vBody: [1.5, null] })).toThrow("kills.vBody[0] is 1.5, expected null or a player index 0..4");
    expect(load({ kBody: "A" as unknown as number[] })).toThrow('column "kills.kBody" is not an array');
  });

  it("accepts an end row after a bomb blast past the round's end, and bounds rows by the round's ticks", () => {
    // fails if a real 1.3.0 file is rejected: A, driven by the human, dies to the bomb at 5022, after
    // the round's end at 5000, and the plugin stamps the end row at 5023. Rows may run to the next
    // round's freeze end, or in the last round to the end plus the plugin's finalize delay (5080 at 64
    // ticks/s) or the tick after its last death; no row comes before freeze end, known length or not
    const blast: Kill[] = [[1150, E1, H, null, null], [5022, null as unknown as number, H, null, A]];
    const check = (rows: [number, number | null][], o: { kills?: Kill[]; next?: number; noLength?: boolean } = {}) => () => {
      const m = round(o.kills ?? [], [], { takeovers: takeovers(rows) });
      m.env.plugin = "1.3.0";
      if (o.noLength) m.rounds.durTicks = [null];
      if (o.next !== undefined) {
        const R = m.rounds as unknown as Record<string, unknown[]>;
        for (const k of Object.keys(R)) R[k] = [...R[k], R[k][0]];
        m.rounds.freezeTick = [1000, o.next];
      }
      return validateMatch(m, "t.json.gz");
    };
    expect(check([[1151, A], [5023, null]], { kills: blast })).not.toThrow();
    expect(check([[1151, A], [5023, null]], { kills: blast, next: 7000 })).not.toThrow();
    expect(check([[1151, A], [5080, null]])).not.toThrow();
    expect(check([[1151, A], [5081, null]])).toThrow("takeovers.tick[1] is 5081, after round 0's last tick 5080");
    // a kill after round_end but before the next round, past the finalize delay, still ends a takeover
    const late: Kill[] = [[1150, E1, H, null, null], [5200, E1, H, null, A]];
    expect(check([[1151, A], [5201, null]], { kills: late })).not.toThrow();
    expect(check([[1151, A], [5202, null]], { kills: late })).toThrow("takeovers.tick[1] is 5202, after round 0's last tick 5201");
    expect(check([[1151, A], [7000, null]], { next: 7000 })).not.toThrow();
    expect(check([[1151, A], [7001, null]], { next: 7000 })).toThrow("takeovers.tick[1] is 7001, after round 0's last tick 7000");
    expect(check([[999, A]])).toThrow("takeovers.tick[0] is 999, before round 0's freeze end 1000");
    expect(check([[999, A]], { noLength: true })).toThrow("takeovers.tick[0] is 999, before round 0's freeze end 1000");
    expect(check([[9999, A]], { noLength: true })).not.toThrow();
  });
});
