// A match's economy from one team's side, on a hand-built round.
import { expect, it } from "vitest";
import { BUY_CLASSES, economyOf } from "./economy";
import { FREEZE_END, oneRound } from "./testing/match";

it("credits the round, the opening kill, the plant and the money to the right team", () => {
  // fails if economyOf mixes up "us" and "them" when our team starts T, or loses the plant or money columns
  const f = oneRound({
    round: 5,
    players: { a: "CT", b: "CT", c: "T", d: "T" },
    kills: [{ tick: FREEZE_END + 300, killer: "c", victim: "a" }],
    player_rounds: {
      a: { money: 100, cash_spent: 4000, equip_value_game: 4500 }, b: { money: 200, cash_spent: 4000, equip_value_game: 4500 },
      c: { money: 50, cash_spent: 600, equip_value_game: 800 }, d: { money: 0, cash_spent: 700, equip_value_game: 900 },
    },
    roundRow: { plant_tick: FREEZE_END + 2000, plant_site: "A", defuse_tick: FREEZE_END + 3000 },
  });
  const e = economyOf(f, 1); // team 1 started T: "us" is T, which lost a defused plant
  const r = e.rounds[0];
  expect([r.number, r.winner, r.us.side, r.us.money, r.us.spent, r.us.equip, r.them.money]).toEqual([5, "them", "T", 50, 1300, 1700, 300]);
  expect(e.winRate.us[BUY_CLASSES.indexOf("eco")]).toEqual({ rounds: 1, wins: 0 });
  expect(e.winRate.them[BUY_CLASSES.indexOf("full")]).toEqual({ rounds: 1, wins: 1 });
  expect(e.afterOpening).toEqual({ us: { rounds: 1, wins: 0 }, them: { rounds: 0, wins: 0 } });
  expect(e.plants.us).toEqual({ planted: 1, exploded: 0, defused: 1 });
  expect(e.avgEquip).toEqual({ us: 1700, them: 9000 });
});
