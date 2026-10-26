// The transitional adapter plus derive must reproduce the game's own per-round totals. Converted
// logs (public/samples) carry the game's per-player, per-round kills, deaths, assists, damage and
// headshot kills in rounds.basic, recorded by the server, independent of the event log.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CS2RB } from "../model-params";
import { RECOIL } from "../recoil-ref";
import { describe, expect, it } from "vitest";
import type { SprayFact } from "../aim";
import { ON_SCREEN_NOTE } from "../facts";
import { derive } from "../derive";
import { rollup } from "../rollup";
import { pluginToTables } from "./adapter";
import { decodeMatch } from "./decode";
import type { Env, MatchFile } from "./schema";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");

it("kills, deaths and headshot kills match the game's per-round totals in every converted log", async () => {
  const wrong: string[] = [];
  let checked = 0;
  for (const file of readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"))) {
    const m = await decodeMatch(readFileSync(path.join(SAMPLES, file)), file);
    if (!m.rounds.basic) continue;
    const f = derive(pluginToTables(m), CS2RB);
    for (const r of f.pr) {
      const game = m.rounds.basic[f.rounds[r.ri].number - 1]?.[m.players.key.indexOf(f.players[r.pi].id)];
      if (!game) continue;
      checked++;
      const [k, d, , , hs] = game;
      const got = [r.m.kills ?? 0, r.m.deaths ?? 0, r.m.hsKills ?? 0];
      if (got[0] !== k || got[1] !== d || got[2] !== hs) wrong.push(`${file} round ${f.rounds[r.ri].number} ${f.players[r.pi].name}: ${got.join("/")} vs ${k}/${d}/${hs}`);
    }
  }
  expect(checked).toBeGreaterThan(500);
  expect(wrong).toEqual([]);
});

it("gives a converted log its whole match's score, not the score of the rounds it covers", async () => {
  // fails if a log whose kill-by-kill rounds are few shows a score like 1:0 for a finished match
  for (const file of readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"))) {
    const m = await decodeMatch(readFileSync(path.join(SAMPLES, file)), file);
    const f = derive(pluginToTables(m), CS2RB);
    expect(f.match.score[0] + f.match.score[1], file).toBe(m.rounds.winSide.filter((w) => w !== null).length);
    expect(f.match.complete, file).toBe(m.status === "complete");
  }
});

it("marks throws rebuilt from detonations as such, and logged throws as logged", async () => {
  // fails if a file without a throw log presents detonation points as exact throws
  for (const file of readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"))) {
    const m = await decodeMatch(readFileSync(path.join(SAMPLES, file)), file);
    const f = derive(pluginToTables(m), CS2RB);
    expect(f.match.inputs.throws, file).toBe(m.throws ? "logged" : "rebuilt");
  }
});

/** One shot by the human: tick, and the aim error to the bot as [yaw, pitch] degrees (null: no target). */
type Shot = [number, [number, number] | null];
const HUMAN = "76561190000000001";

/**
 * A one-round plugin file at 64 ticks/s: the human (CT) fires an AK standing still at one bot (T).
 * visTarget defaults to 1 for every shot; `los` rows are the bot's line-of-sight transitions.
 */
function pluginMatch(shots: Shot[], o: { visTarget?: (0 | 1)[]; los?: [number, 0 | 1][]; killTick?: number; env?: Partial<Env>; angles?: [number, number][] } = {}): MatchFile {
  const col = <T,>(v: T) => shots.map(() => v);
  const none = { ri: [], tick: [] };
  return {
    v: 1, id: "p", map: "de_test", startUtc: "2026-10-25T00:00:00Z", endUtc: "2026-10-25T00:30:00Z", status: "complete",
    env: { plugin: "1.1.0", cssharp: null, game: null, tickrate: 64, maxrounds: 24, botDifficulty: null, ...o.env },
    firstFullRound: 0, weapons: ["ak47"], places: [], human: 0,
    players: { key: [HUMAN, "B:bot"], name: ["me", "bot"], isBot: [false, true], startSide: [3, 2] },
    rounds: {
      winSide: [3], how: ["elim"], freezeTick: [1000], durTicks: [4000], bombSite: [null], plantTick: [null], planter: [null],
      defuser: [null], ctSetup: [null], score: [[1, 0]], side: [[3, 2]], equip: [[4000, 4000]], money: [[800, 800]],
    },
    kills: o.killTick === undefined
      ? { ...none, killer: [], victim: [], assister: [], flashAssister: [], weapon: [], flags: [], kpos: [], vpos: [], state: [] }
      : { ri: [0], tick: [o.killTick], killer: [0], victim: [1], assister: [null], flashAssister: [null], weapon: [0], flags: [0], kpos: [null], vpos: [null], state: [null] },
    damage: { ...none, attacker: [], victim: [], dmg: [], dmgArmor: [], weapon: [], hitgroup: [] },
    blinds: { ...none, attacker: [], victim: [], ms: [] },
    grenades: { ...none, thrower: [], type: [], pos: [] },
    pos: { ...none, pi: [], x: [], y: [], z: [], place: [], alive: [] },
    aim: {
      engagements: { ri: [], enemy: [], tVis: [], angVis: [], angVisYaw: [], angVisPitch: [], dist: [], tAimStart: [], tFirstShot: [], tFirstDmg: [], tEnd: [], outcome: [] },
      shots: {
        ri: col(0), tick: shots.map((s) => s[0]), weapon: col(0), burst: col(0), idx: col(1), speed: col(0), maxSpeed: col(215),
        scoped: col(false), ducked: col(false), target: shots.map((s) => (s[1] ? 1 : null)),
        aimErr: shots.map((s) => (s[1] ? [Math.round(s[1][0] * 100), Math.round(s[1][1] * 100)] : null)), impact: col(null), hit: col(null),
        visTarget: o.visTarget ?? col(1),
        ...(o.angles && { pitch: o.angles.map((a) => a[0]), yaw: o.angles.map((a) => a[1]) }),
      },
      ...(o.los && { los: { ri: o.los.map(() => 0), tick: o.los.map((r) => r[0]), enemy: o.los.map(() => 1), vis: o.los.map((r) => r[1]) } }),
    },
  };
}

// The AK's cycle is 0.1 s, 6.4 ticks: shots 6 or 7 ticks apart continue a spray. Spray A is five
// bullets pulling down and right; an 11-tick pause (0.17 s) ends it, and the three shots after it
// cannot start a spray because recoil has not reset (0.3 s); spray B starts 0.78 s later.
const SPRAYS: Shot[] = [
  [2000, [0, 1]], [2006, [0.2, 0.5]], [2013, [0.4, 0]], [2019, [0.6, -0.5]], [2026, [0.8, -1]],
  [2037, [0, 0]], [2043, [0, 0]], [2050, [0, 0]],
  [2100, [0, 0]], [2106, [-0.1, -0.3]], [2113, [-0.3, -0.7]],
];
const sprays = (m: MatchFile) => derive(pluginToTables(m), CS2RB).aim.filter((f): f is SprayFact => f.k === "spray");

describe("plugin sprays", () => {
  it("cuts sprays by the gun's cycle time and gives each bullet its offset from bullet 1", () => {
    // fails if plugin shots form no sprays, a pause shorter than the reset starts one, or a bullet's
    // offset is taken from the wrong bullet or with the wrong sign (aim error at bullet 1 minus this one)
    const got = sprays(pluginMatch(SPRAYS)).map((f) => ({ bullets: f.bullets, dp: f.dp, dy: f.dy }));
    expect(got).toEqual([
      { bullets: 5, dp: [0.5, 1, 1.5, 2], dy: [-0.2, -0.4, -0.6, -0.8] },
      { bullets: 3, dp: [0.3, 0.7], dy: [0.1, 0.3] },
    ]);
  });

  it("shows the plugin's sprays relative to the target and keeps them out of the pro comparison", () => {
    // fails if a path that includes the target's movement is compared with the pros' view paths, or the
    // plugin's sprays never reach the summary's relative per-bullet path
    const a = rollup([derive(pluginToTables(pluginMatch(SPRAYS)), CS2RB)], { player: HUMAN }).aim;
    expect([a.cmp, Object.keys(a.path)]).toEqual([0, []]);
    const p = a.relPath.ak47;
    expect(p.n).toEqual([2, 2, 1, 1]);
    [0.8, 1.7, 1.5, 2].forEach((x, j) => expect(p.dp[j]).toBeCloseTo(x, 9));
    [-0.1, -0.1, -0.6, -0.8].forEach((x, j) => expect(p.dy[j]).toBeCloseTo(x, 9));
  });

  it("compares a plugin 1.2.0 spray with the pros' from its absolute view angles", () => {
    // fails if recorded view angles are ignored (the spray stays relative to the target) or the path
    // is not the view's change from bullet 1
    const angles: [number, number][] = [[0, 10], [0.5, 9.9], [1.2, 9.8], [2, 9.8], [2.6, 9.7]];
    const f = derive(pluginToTables(pluginMatch(SPRAYS.slice(0, 5), { angles })), CS2RB);
    const [spray] = f.aim.filter((x): x is SprayFact => x.k === "spray");
    expect(spray.relative).toBe(false);
    [0.5, 1.2, 2, 2.6].forEach((x, j) => expect(spray.dp[j]).toBeCloseTo(x, 9));
    [-0.1, -0.2, -0.2, -0.3].forEach((x, j) => expect(spray.dy[j]).toBeCloseTo(x, 9));
    expect(rollup([f], { player: HUMAN }).aim.cmp).toBe(4);
    // the file records the view but not the bullet: each bullet lands at the view change plus the
    // game's kick for that bullet (recoil-ref.ts), marked as taken from the pattern
    const kick = RECOIL.ak47.kick;
    expect(spray.landing).toBe("pattern");
    spray.lp.forEach((x, j) => expect(x).toBeCloseTo(spray.dp[j] + kick[j + 1][0], 2));
    spray.ly.forEach((x, j) => expect(x).toBeCloseTo(spray.dy[j] + kick[j + 1][1], 2));
    expect(spray.lp.length).toBe(4);
  });

  it("compares no plugin M4A1-S spray, whose silencer state the plugin does not record", () => {
    // fails if a plugin M4A1-S spray is set against the silenced pattern without knowing the silencer
    // was on, or gets landing points inferred from that pattern
    const angles: [number, number][] = [[0, 10], [0.5, 9.9], [1.2, 9.8], [2, 9.8], [2.6, 9.7]];
    const m = pluginMatch(SPRAYS.slice(0, 5), { angles });
    m.weapons = ["m4a1_silencer"];
    const f = derive(pluginToTables(m), CS2RB);
    const [spray] = f.aim.filter((x): x is SprayFact => x.k === "spray");
    expect([spray.weapon, spray.recoilKnown, spray.dp.length, spray.landing, spray.lp]).toEqual(["m4a1_silencer", false, 4, null, []]);
    expect(rollup([f], { player: HUMAN }).aim.cmp).toBe(0);
  });

  it("keeps a plugin spray relative to the target when a bullet has no angles", () => {
    // fails if a file before 1.2.0, or a spray with one missing angle, is compared with the pros
    const angles: [number, number][] = [[0, 10], [0.5, 9.9], [NaN, NaN], [2, 9.8], [2.6, 9.7]];
    const f = derive(pluginToTables(pluginMatch(SPRAYS.slice(0, 5), { angles })), CS2RB);
    expect(f.aim.filter((x): x is SprayFact => x.k === "spray").map((x) => x.relative)).toEqual([true]);
    expect(rollup([f], { player: HUMAN }).aim.cmp).toBe(0);
  });

  it("reads a mixed file's spotted mask for the whole match and says so", () => {
    // fails if a "mixed" file (line of sight failed partway) reads line of sight up to a guessed failure
    // point: the LOS rows say visible from 1990 to 2015, the mask only at the fourth bullet
    const shots = SPRAYS.slice(0, 4);
    const m = pluginMatch(shots, { visTarget: [0, 0, 0, 1], env: { visSource: "mixed", losError: "trace returned no result" }, los: [[1990, 1], [2015, 0]] });
    const f = derive(pluginToTables(m), CS2RB);
    const read = (sp: SprayFact[]) => sp.map((x) => [x.bullets, x.dp.length]);
    const maskOnly = read(sprays(pluginMatch(shots, { visTarget: [0, 0, 0, 1] })));
    expect(maskOnly).not.toEqual([[4, 3]]);
    expect(read(f.aim.filter((x): x is SprayFact => x.k === "spray"))).toEqual(maskOnly);
    expect(ON_SCREEN_NOTE[f.match.inputs.onScreen!]).toBe("line of sight lost partway; using the game's spotted flags");
  });

  it("counts a bullet at the kill tick as on screen whether the death's hidden row is at the kill tick or the next", () => {
    // fails if a line-of-sight file is read from visTarget instead of aim.los, or a pre-#21 file's hidden
    // row at the kill tick drops the killing bullet from the pro comparison
    const shots = SPRAYS.slice(0, 4);
    const at = (hidden: number) => sprays(pluginMatch(shots, { visTarget: [0, 0, 0, 0], killTick: 2019, env: { visSource: "los" }, los: [[1990, 1], [hidden, 0]] }));
    expect(at(2019).map((f) => [f.bullets, f.dp.length])).toEqual([[4, 3]]);
    expect(at(2020).map((f) => [f.bullets, f.dp.length])).toEqual([[4, 3]]);
  });
});

it("scores a match across the half-time side swap from the human's side each round", () => {
  // fails if the score is read as [T, CT] or from the starting sides after the swap: the human starts
  // T and wins 9 of the first 12, then as CT wins 2 of the last 12, so loses 11-13 (the Oct 25 12:40
  // PM recording's shape)
  const base = pluginMatch([]);
  const won = [...[3, 3, 3], ...Array(9).fill(2), 2, 2, 2, 3, 2, 2, 2, 2, 3, 2, 2, 2] as (2 | 3)[];
  const side = won.map((_, ri): (2 | 3)[] => (ri < 12 ? [2, 3] : [3, 2]));
  const r = base.rounds;
  const m: MatchFile = {
    ...base,
    rounds: {
      ...r, winSide: won, how: won.map(() => "elim"), freezeTick: won.map((_, i) => 1000 + i * 5000), durTicks: won.map(() => 4000),
      bombSite: won.map(() => null), plantTick: won.map(() => null), planter: won.map(() => null), defuser: won.map(() => null),
      ctSetup: won.map(() => null), score: won.map(() => [0, 0] as [number, number]), side, equip: won.map(() => [4000, 4000]), money: won.map(() => [800, 800]),
    },
  };
  const f = derive(pluginToTables(m), CS2RB);
  const usTeam = f.players[f.players.findIndex((p) => p.id === HUMAN)].team!;
  expect([f.match.score[usTeam], f.match.score[1 - usTeam], f.match.complete]).toEqual([11, 13, true]);
});

it("names the rounds a converted log holds only as totals", () => {
  // fails if those rounds are dropped without a trace, so the round grid cannot show them: rounds 1-3
  // come before firstFullRound and round 10 is marked partial
  const base = pluginMatch([]);
  const won = Array(12).fill(3) as (2 | 3)[];
  const r = base.rounds;
  const m: MatchFile = {
    ...base, firstFullRound: 3, recon: { ...base.recon, partial: [9] },
    rounds: {
      ...r, winSide: won, how: won.map(() => "elim"), freezeTick: won.map((_, i) => 1000 + i * 5000), durTicks: won.map(() => 4000),
      bombSite: won.map(() => null), plantTick: won.map(() => null), planter: won.map(() => null), defuser: won.map(() => null),
      ctSetup: won.map(() => null), score: won.map(() => [0, 0] as [number, number]), side: won.map((): (2 | 3)[] => [3, 2]), equip: won.map(() => [4000, 4000]), money: won.map(() => [800, 800]),
      // the game's totals: round 2 only, the bot without a row
      basic: won.map((_, ri) => (ri === 1 ? [[2, 0, 1, 180, 1], null] : [null, null])),
    },
  };
  const f = derive(pluginToTables(m), CS2RB);
  expect([f.match.totalsOnly, f.rounds.map((x) => x.number)]).toEqual([[1, 2, 3, 10], [4, 5, 6, 7, 8, 9, 11, 12]]);
  // fails if a totals-only round's per-player totals are lost, so its grid cells and drawer stay empty
  expect(f.totalsRounds.filter((r) => r.players.length)).toEqual([{ number: 2, winner: "CT", players: [{ pi: 0, kills: 2, deaths: 0, assists: 1, dmg: 180, hsKills: 1 }] }]);
});

it("carries who was alive at freeze end and who disconnected into the tables and facts", () => {
  // fails if the adapter drops alive0 or the leaves the situations view reads: the bot starts dead, and
  // the human disconnects alive at tick 1500
  const m = pluginMatch([]);
  m.rounds.alive0 = [[1, 0]];
  m.leaves = { ri: [0], tick: [1500], pi: [0], alive: [1] };
  const t = pluginToTables(m);
  expect(t.player_rounds.alive_at_start).toEqual([true, false]);
  expect([t.leaves!.n, t.leaves!.steamid[0], t.leaves!.alive[0]]).toEqual([1, HUMAN, true]);
  const f = derive(t, CS2RB);
  // the bot dead at freeze end is off the round's roster, so the facts hold no row for it (rules.ts onRoster)
  expect(f.pr.map((r) => [r.pi, r.aliveAtStart])).toEqual([[0, true]]);
  expect(f.rounds[0].leaves).toEqual([{ tick: 1500, pi: 0 }]);
});
