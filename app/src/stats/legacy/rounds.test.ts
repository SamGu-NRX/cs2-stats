import { describe, expect, test } from "vitest";
import { winProbabilityCT } from "@model/winprob";
import { deriveMatch } from "./derive";
import { BUY_CLASSES, classifyBuy, economyView, isPistolRound } from "./economy";
import { buildRoundDetails, estimateSpent, isHalfStart, type RoundDetail } from "./rounds";
import type { MatchFile } from "./schema";
import { MatchBuilder } from "./testing/build";
import { loadPluginMatch, loadSample, PLUGIN_MATCHES, SAMPLE_1714, SAMPLE_1809, SAMPLE_1939 } from "./testing/load";
import { modelFromModule, stubModel, type WinModel } from "./winprob";

describe("buy classes", () => {
  test("thresholds per player: eco up to $1,000, full from $4,000", () => {
    expect(classifyBuy(0, false)).toBe("eco");
    expect(classifyBuy(1000, false)).toBe("eco");
    expect(classifyBuy(1001, false)).toBe("force");
    expect(classifyBuy(3999, false)).toBe("force");
    expect(classifyBuy(4000, false)).toBe("full");
    expect(classifyBuy(6000, true)).toBe("pistol");
  });
  test("pistol rounds are the first of each regulation half only", () => {
    expect([0, 1, 11, 12, 13, 24, 27].map((ri) => isPistolRound(ri, 24))).toEqual([true, false, false, true, false, false, false]);
    expect([0, 15, 30].map((ri) => isPistolRound(ri, 30))).toEqual([true, true, false]);
  });
  test("half starts include overtime halves (MR3)", () => {
    expect([0, 12, 24, 25, 27, 30].map((ri) => isHalfStart(ri, 24))).toEqual([true, true, true, false, true, true]);
  });
});

describe("estimateSpent", () => {
  test("equipment minus what was carried in", () => {
    expect(estimateSpent(4700, 3900, false)).toBe(800);
    expect(estimateSpent(4700, 0, false)).toBe(4500); // died last round: starting pistol only
    expect(estimateSpent(850, 3900, true)).toBe(650); // half start: everyone restarts with the pistol
    expect(estimateSpent(3000, 3900, false)).toBe(0); // kept more than the freeze-end value (dropped a weapon)
    expect(estimateSpent(4700, null, false)).toBeNull();
    expect(estimateSpent(4700, undefined, false)).toBeNull();
    expect(estimateSpent(null, 100, false)).toBeNull();
  });
});

describe("round details on a built match", () => {
  const b = new MatchBuilder(2);
  b.kill(0, 10, 5, 0, { weapon: "awp", hs: true }); // T 5 kills CT 0
  b.kill(0, 12, 1, 5, { assister: 2 }); // CT 1 trades within 5 s
  b.m.kills.flags[1] = 2 | 4; // wallbang through smoke
  b.damage(0, 9, 2, 5, 40).damage(0, 12, 1, 5, 60).damage(0, 10, 5, 0, 100);
  b.blind(0, 8, 3, 1, 1500).blind(0, 8, 3, 6, 2000);
  b.grenade(0, 7, 3, "flash");
  const d = buildRoundDetails(b.build());
  const r = d[0];

  test("kills, death, flags and trades", () => {
    const p1 = r.players[1]!;
    expect(p1.k).toBe(1);
    expect(p1.kills[0]).toMatchObject({ victim: 5, weapon: "ak47", wallbang: true, throughSmoke: true, headshot: false, tradeKill: true, opening: false });
    const p0 = r.players[0]!;
    expect(p0.death).toMatchObject({ killer: 5, weapon: "awp", headshot: true, opening: true, traded: true });
    expect([p0.survived, p0.traded, p0.kast]).toEqual([false, true, true]);
    expect(r.players[2]!.a).toBe(1);
  });
  test("damage dealt and taken, flashes and team-flash time", () => {
    expect(r.players[2]!.dmg).toBe(40);
    expect(r.players[5]!.dmgTaken).toBe(100);
    expect(r.players[3]!).toMatchObject({ enemiesFlashed: 1, enemyBlindSecs: 2, teamFlashSecs: 1.5 });
    expect(r.players[3]!.utilThrown.flash).toBe(1);
  });
  test("team rows and bomb", () => {
    expect(r.teams.ct).toMatchObject({ team: "us", buy: "pistol", won: true, aliveEnd: 4 });
    expect(d[1].teams.t.buy).toBe("full"); // 4,700 per player
    expect(r.bomb).toMatchObject({ plantTick: null, defused: false, exploded: false });
  });
});

describe("win-probability path", () => {
  const fake: WinModel = { kind: "model", label: "test", winProbability: (s) => 0.5 + 0.1 * (s.ctAlive - s.tAlive) };
  test("start, kills with the swing's values, plant, end", () => {
    const b = new MatchBuilder();
    b.kill(0, 10, 5, 0, { state: [5, 5, 500, 500, 23500, 23500, 0, null] });
    b.m.rounds.plantTick[0] = b.t(0, 30);
    b.m.rounds.winSide[0] = 2;
    const path = buildRoundDetails(b.build(), fake)[0].winProb!;
    expect(path.map((p) => p.event)).toEqual(["start", "kill", "plant", "end"]);
    expect(path[0].pCT).toBeCloseTo(0.5, 12);
    expect(path[1]).toMatchObject({ before: 0.5, secs: 10 });
    expect(path[1].pCT).toBeCloseTo(0.4, 12);
    expect(path[3].pCT).toBe(0);
  });
});

describe("economy view", () => {
  const r = (ri: number, winner: "us" | "them", us: string, them: string, savesThem: number[] = []): RoundDetail => ({
    ri, winner, usSide: 3, teams: {
      ct: { side: 3, team: "us", players: [], equip: 0, money: 0, spent: 0, buy: us as never, won: winner === "us", aliveEnd: 0, saves: [] },
      t: { side: 2, team: "them", players: [], equip: 0, money: 0, spent: 0, buy: them as never, won: winner === "them", aliveEnd: 0, saves: savesThem },
    },
    players: Array.from({ length: 10 }, (_, pi) => ({ equipEnd: pi === 6 ? 5000 : 0 })),
  }) as unknown as RoundDetail;
  test("win rate by buy class, matchup and saves", () => {
    const v = economyView([r(0, "us", "pistol", "pistol"), r(1, "us", "full", "eco"), r(2, "them", "full", "force", [6]), r(3, "us", "eco", "eco")]);
    const i = (b: string) => BUY_CLASSES.indexOf(b as never);
    expect(v.winRate.us[i("full")]).toEqual({ rounds: 2, wins: 1 });
    expect(v.winRate.them[i("eco")]).toEqual({ rounds: 2, wins: 0 });
    expect(v.matchup[i("full")][i("force")]).toEqual({ rounds: 1, wins: 0 });
    expect(v.saves.them).toEqual({ players: 1, value: 5000 });
    expect(v.unknown).toBe(0);
  });
});

/** Every per-round value sums to the match counters. */
function checkSums(m: MatchFile, file: string, model: WinModel) {
  const v = deriveMatch(m, file, model);
  const d = buildRoundDetails(m, model);
  for (const p of v.players) {
    const rows = d.map((r) => r.players[p.pi]).filter((x) => x !== null);
    const sum = (f: (x: (typeof rows)[number]) => number) => rows.reduce((a, x) => a + f(x!), 0);
    const c = p.c;
    expect([sum((x) => x!.k), sum((x) => x!.d), sum((x) => x!.a), sum((x) => x!.dmg), sum((x) => x!.hsKills), sum((x) => (x!.kast ? 1 : 0))], `${file} ${p.name}`)
      .toEqual([c.kills, c.deaths, c.assists, c.dmg, c.hsKills, c.kastRounds]);
    expect(sum((x) => x!.utilDmg)).toBe(c.utilDmg);
    expect(sum((x) => x!.flashAssists)).toBe(c.flashAssists);
    expect(sum((x) => (x!.saved ? 1 : 0))).toBe(c.saves);
    expect(sum((x) => x!.swing ?? 0)).toBeCloseTo(c.swing, 9);
  }
  expect(d.map((r) => r.scoreAfter)).toEqual(v.rounds.map((r) => r.scoreAfter));
}

describe("per-round sums equal match totals", () => {
  const model = winProbabilityCT === undefined ? stubModel : modelFromModule(winProbabilityCT);
  test.each(PLUGIN_MATCHES)("plugin match %s", async (f) => checkSums(await loadPluginMatch(f), f, model));
  test.each([SAMPLE_1714, SAMPLE_1809, SAMPLE_1939])("converted log %s", async (f) => checkSums(await loadSample(f), f, model));
  test("plugin matches have a win-probability path, human aim and spend for every captured round", async () => {
    for (const f of PLUGIN_MATCHES) {
      const d = buildRoundDetails(await loadPluginMatch(f), model);
      for (const r of d.filter((x) => x.captured)) {
        expect(r.winProb, `${f} r${r.ri}`).not.toBeNull();
        expect(r.human).not.toBeNull();
        expect(r.teams.t.spent).not.toBeNull();
      }
    }
  });
});
