// A match's economy from one team's side, on a hand-built round.
import { expect, it } from "vitest";
import { BUY_CLASSES, buyTier, economyOf } from "./economy";
import { rollup } from "./rollup";
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

it("splits HLTV's half buy into semi-eco and force at $2,000 a player", () => {
  // fails if a band edge moves: per player, under 1,000 is eco, under 2,000 semi-eco, under 3,250 force
  expect([999, 1000, 1999, 2000, 3249, 3250].map((x) => buyTier(5 * x, 5, false))).toEqual(["eco", "semiEco", "semiEco", "force", "force", "full"]);
  expect(buyTier(20000, 5, true)).toBe("pistol");
});

it("keeps only the rounds of the asked buy tier", () => {
  // fails if the tier filter is ignored: CT spends 1,500 a player in round 2, a semi-eco
  const f = oneRound({ players: { a: "CT", c: "T" }, round: 2, player_rounds: { a: { equip_value_game: 1500 }, c: { equip_value_game: 4000 } } });
  expect([rollup([f], { player: "a", ownTier: ["semiEco"] }).m.rounds, rollup([f], { player: "a", ownTier: ["force"] }).m.rounds]).toEqual([1, 0]);
});
