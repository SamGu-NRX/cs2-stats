import { expect, it } from "vitest";
import { careerBaselines, compare, percentileOf, type Baselines } from "./compare";
import { METRICS } from "./metrics";
import { FREEZE_END, oneRound } from "./testing/match";
import { emptySummary, rollup } from "./rollup";
import { mostSimilar, similarity, STYLE, type PackPlayer } from "./identity";
import { rolled } from "../worker/views";

// Quantiles at 0, 5, ..., 100 percent. Values 0..200 in steps of 10: each step is 5 percentile points.
const linear = Array.from({ length: 21 }, (_, i) => i * 10);

it("reads percentiles between, below, above and across a flat run of quantiles", () => {
  expect(percentileOf(linear, 37)).toBeCloseTo(18.5); // 37 is 70% of the way from 30 (15%) to 40 (20%)
  expect(percentileOf(linear, -5)).toBe(0);
  expect(percentileOf(linear, 500)).toBe(100);
  // quantiles 20%..40% all equal 3: a value of 3 sits in the middle of that run
  const flat = [0, 1, 2, 2.5, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  expect(percentileOf(flat, 3)).toBe(30);
});

it("scores similarity by profile shape over both sides, not by level", () => {
  // fails if a profile at a different level but the same shape stops being a 100% match (the
  // populations differ, design/identity.md), or if "plays like" reads only one side
  expect(similarity({ entrying: 60, trading: 40 }, { entrying: 90, trading: 10, opening: 5 }, ["entrying", "trading", "opening"])).toBeCloseTo(100);
  expect(similarity({ entrying: 60, trading: 40 }, { entrying: 30, trading: 70 }, ["entrying", "trading"])).toBeCloseTo(-100);
  expect(similarity({ entrying: null }, { entrying: 40 }, ["entrying"])).toBeNull();
  const style = (hi: "entrying" | "sniping") => Object.fromEntries(STYLE.map((k) => [k, k === hi ? 90 : 40]));
  const mine = { T: style("entrying"), CT: style("sniping") };
  const pack: PackPlayer[] = [
    { name: "same on T only", sides: { T: { style: style("entrying") }, CT: { style: style("entrying") } } },
    { name: "same on both", sides: { T: { style: style("entrying") }, CT: { style: style("sniping") } } },
  ];
  expect(mostSimilar(mine, pack, "style").map((x) => x.name)).toEqual(["same on both", "same on T only"]);
});

it("ranks the user against bot careers of 150+ rounds, provisionally until 15 qualify", () => {
  // fails if short careers enter the user's pool, or the provisional label drops too early
  const career = (rounds: number, kills: number) => {
    const s = emptySummary();
    s.m.rounds = rounds; s.m.kills = kills;
    return { both: s, CT: s, T: s };
  };
  const fourteen = Array.from({ length: 14 }, (_, i) => career(150, 100 + i));
  expect(careerBaselines([...fourteen, career(149, 999)], "x")).toMatchObject({ provisional: true, careers: 14 });
  const r = careerBaselines([...fourteen, career(150, 120)], "x");
  expect(r).toMatchObject({ provisional: false, careers: 15 });
  expect(r.baselines.pools.all.both!.kpr![0]).toBeCloseTo(100 / 150);
});

it("shows no percentile, but a reason, when the matches lack an input a metric needs or the pros used another model", () => {
  // fails if a source without inventories is ranked on unused utility (counted as $0), or swing is
  // ranked against pros whose baselines were built with another win-probability source
  const f = oneRound({
    players: { a: "CT", b: "T" }, kills: [{ tick: FREEZE_END + 300, killer: "a", victim: "b" }],
    player_rounds: { a: { equip_value_game: 4000 }, b: { equip_value_game: 4000 } },
  });
  const s = rollup([f], { player: "a" });
  const pools = { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(0)])) } };
  const pros: Baselines = { version: 1, built: "x", source: "test", model: f.match.model, n: {}, pools: { ...pools, rifler: pools.all } };
  const same = compare(s, pros, {});
  // no inventories: unused utility is unmeasured (no value) and says why
  expect(same.utilUnused).toMatchObject({ value: null, pct: null, reason: "Not compared: freeze-end loadout known for 0 of 1 rounds" });
  expect(same.kpr.reason).toBeNull();
  expect(same.swing.pct).not.toBeNull();
  const other = compare(s, { ...pros, model: "hltv-0000-pffff" }, {});
  expect(other.swing).toMatchObject({ pct: null, reason: expect.stringMatching(/model/) });
  expect(other.kpr.pct).not.toBeNull();
});

it("computes a metric over the rows its input is known on, and gives no percentile while some are unknown", () => {
  // fails if a source with inventories on some rounds counts the others as empty loadouts, or is ranked
  const players = { a: "CT", b: "T" } as const;
  const known = oneRound({ players, player_rounds: { a: { inventory: ["AWP", "Glock-18"], best_primary: "AWP" } } });
  const unknown = oneRound({ players });
  const s = rollup([known, unknown], { player: "a" });
  const pools = { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(0)])) } };
  const p = compare(s, { version: 1, built: "x", source: "t", model: known.match.model, n: {}, pools: { ...pools, rifler: pools.all } }, {});
  expect(p.roundsWithAwp).toMatchObject({ value: 100, pct: null, reason: "Not compared: freeze-end loadout known for 1 of 2 rounds" });
});

it("gives the AWP duel win rate with the count of AWP duels it rests on", () => {
  // fails if the AWP duel percentile reaches the UI without its sample size: 4 wins in 7 AWP duels
  const s = emptySummary();
  Object.assign(s.m, { rounds: 20, awpDuels: 7, awpDuelWins: 4 });
  const pools = { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, linear])) } };
  const p = compare(s, { version: 1, built: "x", source: "t", n: {}, pools: { ...pools, rifler: pools.all } }, {});
  expect(p.awpDuelWin).toMatchObject({ value: (100 * 4) / 7, n: 7, reason: null });
  expect(p.kpr.n).toBeNull();
  expect(rolled(s).n).toEqual({ awpDuelWin: 7 });
});
