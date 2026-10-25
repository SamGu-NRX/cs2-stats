import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { deriveMatch } from "./derive";
import { computeTrades } from "./rules";
import {
  DEFAULT_DUEL, DEFAULT_R3, duelWinProb, ECO_GROUPS, fitDuelStrengths, groupFromEquip, inferGroup, killPoints, r3Inputs, rating3, RATING3_LABEL, weaponGroup,
  type EcoGroup,
} from "./rating3";
import type { Side } from "./schema";
import { computeSwing } from "./swing";
import { MatchBuilder } from "./testing/build";
import { loadPluginMatch, PLUGIN_MATCHES } from "./testing/load";
import type { WinModel } from "./winprob";

describe("economy groups", () => {
  test("weapons", () => {
    expect(["awp", "scar20", "ak47", "m4a1_silencer", "galilar", "ssg08", "mac10", "xm1014", "negev", "deagle", "elite", "glock", "usp_silencer", "knife", "hegrenade", "taser"].map(weaponGroup))
      .toEqual(["sniper", "sniper", "rifle1", "rifle1", "rifle2", "rifle2", "smg", "smg", "smg", "pistolPlus", "pistolPlus", "pistol", "pistol", null, null, null]);
  });
  test("equipment bands at their edges", () => {
    expect([0, 799, 800, 1599, 1600, 2399, 2400, 3399, 3400, 9000].map(groupFromEquip))
      .toEqual(["pistol", "pistol", "pistolPlus", "pistolPlus", "smg", "smg", "rifle2", "rifle2", "rifle1", "rifle1"]);
  });
  test("a seen primary decides; a seen pistol defers to a stronger band", () => {
    expect(inferGroup("smg", 4500)).toBe("smg");
    expect(inferGroup("pistol", 3600)).toBe("rifle1");
    expect(inferGroup("pistolPlus", 200)).toBe("pistolPlus");
    expect(inferGroup(null, 900)).toBe("pistolPlus");
    expect(inferGroup(null, null)).toBeNull();
  });
});

describe("duel table", () => {
  test("reproduces HLTV's four published anchors", () => {
    expect(duelWinProb("rifle1", "rifle1", 2)).toBeCloseTo(0.48, 3);
    expect(duelWinProb("rifle1", "pistol", 2)).toBeCloseTo(0.75, 2);
    expect(duelWinProb("sniper", "rifle1", 2)).toBeCloseTo(0.56, 2);
    expect(duelWinProb("sniper", "rifle1", 3)).toBeCloseTo(0.6, 2);
    // one k cannot hit both published kill values exactly (1.10/0.52 = 2.115, 0.54/0.25 = 2.16)
    expect(Math.abs(killPoints("rifle1", "rifle1", 2) - 1.1)).toBeLessThan(0.015);
    expect(Math.abs(killPoints("rifle1", "pistol", 2) - 0.54)).toBeLessThan(0.006);
  });
  test("both sides of a duel add to 1 and the groups are ordered", () => {
    for (const a of ECO_GROUPS) for (const b of ECO_GROUPS) {
      expect(duelWinProb(a, b, 2) + duelWinProb(b, a, 3)).toBeCloseTo(1, 12);
    }
    const s = ECO_GROUPS.map((g) => DEFAULT_DUEL.strength[g]);
    expect([...s].sort((x, y) => y - x)).toEqual(s);
  });
  test("the fit recovers a known strength from exact counts", () => {
    // rifle2 at 0.8 against tier-1 rifles with no side edge: P = σ(0.8 − 1.179) ≈ 0.406 → 406 of 1000 duels
    const prior = { ...DEFAULT_DUEL, ctEdge: 0 };
    const duels: { winner: EcoGroup; loser: EcoGroup; winnerSide: Side }[] = [];
    for (let i = 0; i < 406; i++) duels.push({ winner: "rifle2", loser: "rifle1", winnerSide: 2 });
    for (let i = 0; i < 594; i++) duels.push({ winner: "rifle1", loser: "rifle2", winnerSide: 2 });
    const s = fitDuelStrengths(duels, ["rifle2"], prior, 0, 400, 0.004);
    expect(s.rifle2).toBeCloseTo(0.8, 2);
    expect(s.rifle1).toBe(DEFAULT_DUEL.strength.rifle1);
  });
});

describe("Rating 3 inputs on a built round", () => {
  // CT 0-4, T 5-9, everyone at $4,700 (tier-1 rifle band), all kills with an AK
  const b = new MatchBuilder();
  b.kill(0, 10, 5, 0, { state: [5, 5, 500, 500, 23500, 23500, 0, null] });
  b.damage(0, 11, 2, 5, 45).damage(0, 12, 1, 5, 55);
  b.kill(0, 12, 1, 5, { flash: 3, state: [4, 5, 400, 500, 23500, 23500, 0, null] });
  b.kill(0, 14, 1, 6, { state: [4, 4, 400, 400, 23500, 23500, 0, null] });
  b.kill(0, 15, 7, 1, { state: [4, 3, 400, 300, 23500, 23500, 0, null] });
  b.kill(0, 16, 7, 2, { state: [3, 3, 300, 300, 23500, 23500, 0, null] });
  const m = b.build();
  const ctx = buildCtx(m);
  const fake: WinModel = { kind: "model", label: "test", winProbability: (s) => 0.5 + 0.1 * (s.ctAlive - s.tAlive) };
  const x = r3Inputs(ctx, computeTrades(ctx), computeSwing(ctx, fake));
  const T_KILL = 2.14 * 0.52;
  const CT_KILL = 2.14 * 0.48;

  test("eco kills, deaths and damage", () => {
    expect(x[5].ecoKills).toBeCloseTo(T_KILL, 9);
    expect(x[1].ecoKills).toBeCloseTo(2 * CT_KILL, 9);
    expect(x[0].ecoDeaths).toBeCloseTo(T_KILL, 9);
    expect(x[2].ecoDmg).toBeCloseTo(45 * CT_KILL, 9);
    expect(x[1]).toMatchObject({ kills: 2, mkRounds: 1, ecoMk: 1, rounds: 1 });
  });
  test("trade denials, failed trades and 40-damage assists", () => {
    expect([x[1].tradeDenials, x[7].tradeDenials, x[5].tradeDenials]).toEqual([1, 1, 0]);
    expect([x[2].failedTrades, x[6].failedTrades, x[5].failedTrades, x[1].failedTrades]).toEqual([1, 1, 0, 0]);
    expect(x[2].assists40).toBe(1);
  });
  test("swing split: final damage, 40+ damage share, flash assist, traded relief", () => {
    const sw = x.map((p) => +p.swing.toFixed(6));
    expect(sw.slice(0, 4)).toEqual([-0.075, 0.072, -0.082, 0.01]);
    expect(sw.slice(5, 8)).toEqual([0.025, -0.075, 0.2]);
  });
  test("rating from the default weights", () => {
    const r = rating3(x[1]);
    expect(r.label).toBe(RATING3_LABEL);
    expect(r.calibrated).toBe(false);
    const f = r.features!;
    const want = DEFAULT_R3.intercept + DEFAULT_R3.w.kpr * f.kpr + DEFAULT_R3.w.adr * f.adr + DEFAULT_R3.w.dpr * f.dpr + DEFAULT_R3.w.kast * f.kast;
    expect(r.value).toBeCloseTo(Math.max(0, want), 12);
  });
});

describe("Rating 3 on the plugin recordings", () => {
  test("raw inputs equal the match counters and the average kill is worth about 1", async () => {
    let kills = 0;
    let points = 0;
    for (const f of PLUGIN_MATCHES) {
      const v = deriveMatch(await loadPluginMatch(f), f);
      for (const p of v.players) {
        expect([p.c.r3.kills, p.c.r3.deaths, p.c.r3.dmg, p.c.r3.kastRounds], `${f} ${p.name}`).toEqual([p.c.fullKills, p.c.fullDeaths, p.c.dmg, p.c.kastRounds]);
        expect(p.c.r3.unknownGroups).toBe(0);
        expect(p.rating3.value).not.toBeNull();
        kills += p.c.r3.kills;
        points += p.c.r3.ecoKills;
      }
    }
    // HLTV sets k so an average kill is worth about 1; on these bot matches it comes to:
    expect(points / kills).toBeGreaterThan(0.9);
    expect(points / kills).toBeLessThan(1.1);
  });
});
