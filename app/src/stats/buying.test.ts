// Buy deviation and the save measures (buying.ts) on a hand-built two-round match: a and b on CT
// (team A) and c on T (team B). CT loses the first round; c kills b, so a survives it: a save.
import { describe, expect, it } from "vitest";
import { derive } from "./derive";
import { compare, type Baselines } from "./compare";
import { METRIC, METRICS } from "./metrics";
import { CS2RB } from "./model-params";
import { rollup } from "./rollup";
import { kindOf, SCHEMA, type MatchTables, type TableName } from "./tables";
import { FREEZE_END, oneRoundTables, ROUND_END } from "./testing/match";
import { pushRow } from "./testing/tables";

function add<N extends TableName>(t: MatchTables, name: N, row: Record<string, unknown>): void {
  const full: Record<string, unknown> = {};
  for (const col of Object.keys(SCHEMA[name])) full[col] = col in row ? row[col] : kindOf(name, col) === "ss" ? [] : null;
  pushRow(t[name] as never, full as never);
}

/**
 * Rounds numbered `first` and `first + 1`, CT on both. a's equipment is 4,000 then 3,700, b's 1,000 then
 * 5,000; the second round records each player's starting equipment unless `carry` is false.
 */
function twoRounds(first: number, carry = true) {
  const t = oneRoundTables({
    round: first, players: { a: "CT", b: "CT", c: "T" }, roundRow: { winner_side: "T" },
    kills: [{ tick: FREEZE_END + 200, killer: "c", victim: "b" }],
    player_rounds: { a: { equip_value_game: 4000 }, b: { equip_value_game: 1000 }, c: { equip_value_game: 800 } },
  });
  const r2 = first + 1, start = ROUND_END + 100;
  add(t, "rounds", { round: r2, start_tick: start, freeze_end_tick: start + FREEZE_END, end_tick: start + ROUND_END, ct_team: "A", t_team: "B", winner_side: "CT" });
  for (const [id, side, equip, carried] of [["a", "CT", 3700, 3700], ["b", "CT", 5000, 200], ["c", "T", 4000, 800]] as const) {
    add(t, "player_rounds", { round: r2, steamid: id, side, equip_value_game: equip, round_start_equip_value: carry ? carried : null });
  }
  return derive(t, CS2RB);
}
const twoRoundsWithoutCarry = () => twoRounds(1, false);

describe("buying", () => {
  it("measures your equipment against your side's mean", () => {
    // fails if the mean takes the whole team's five-player share, or the enemy's equipment: a is
    // 4,000 against a CT mean of 2,500 (+1,500), then 3,700 against 4,350 (-650); the mean is +425
    const s = rollup([twoRounds(1)], { player: "a" });
    expect([s.m.buyDevSum, s.m.buyDevRounds]).toEqual([850, 2]);
    expect(METRIC.buyDeviation.value(s)).toBe(425);
  });

  it("counts what a survived loss carries into the next round of the half", () => {
    // fails if a death counts as a save, or the carried value is not the next round's starting equipment
    const f = twoRounds(1);
    expect(rollup([f], { player: "a" }).m).toMatchObject({ saveEvents: 1, saveCarryKnown: 1, saveCarrySum: 3700 });
    expect(rollup([f], { player: "b" }).m.saveEvents).toBe(0);
  });

  it("does not carry a save across the end of regulation", () => {
    // fails if round 24's survivors are credited with round 25's overtime equipment, which the game resets
    expect(rollup([twoRounds(24)], { player: "a" }).m.saveEvents).toBe(0);
  });
});

describe("save conversion", () => {
  const pros = (model: string): Baselines => {
    const pools = { all: { both: Object.fromEntries(METRICS.map((m) => [m.id, Array(21).fill(0)])) } };
    return { version: 1, built: "x", source: "t", model, n: {}, pools: { ...pools, rifler: pools.all } };
  };

  it("shows the value with its sample, and no percentile under 10 saved rounds", () => {
    // fails if one save is ranked: the research's reliability (0.27) needs a sample, and 10 saves reach 0.54 on the pros
    const f = twoRounds(1);
    expect(compare(rollup([f], { player: "a" }), pros(f.match.model)).saveConversion)
      .toMatchObject({ value: 3700, n: 1, pct: null, reason: "Not compared: 1 of the 10 saved rounds a percentile needs" });
  });

  it("gives no value, and says why, when the next round's starting equipment is not recorded", () => {
    // fails if a plugin file's saves (no starting equipment) read as carrying nothing
    const f = twoRoundsWithoutCarry();
    expect(compare(rollup([f], { player: "a" }), pros(f.match.model)).saveConversion)
      .toMatchObject({ value: null, pct: null, reason: "Not compared: next round's starting equipment known for 0 of 1 saved rounds" });
  });
});
