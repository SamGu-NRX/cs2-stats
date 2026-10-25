// Team buy types, as in CS Demo Manager's computeTeamEconomyType (pkg/api/economy.go).
import type { MatchCtx } from "./context";
import { CT, type Side } from "./schema";

export const BUY_TYPES = ["pistol", "eco", "semi", "force-buy", "full"] as const;
export type BuyType = (typeof BUY_TYPES)[number];

/**
 * - pistol: first round of either regulation half
 * - eco: team equipment ≤ $1,000 per player
 * - full: ≥ $4,500 per player on CT, ≥ $4,000 on T
 * - force-buy: lost the previous round and the team holds < $400 per player
 * - semi: everything else
 * CS Demo Manager counts only human players in "per player"; in a bot match that leaves one or
 * zero, so here every player on the side counts. Equipment and money are read at freeze end
 * (CS Demo Manager reads them 7 s later). Returns null when a teammate's value is unknown.
 */
export function teamBuyType(ctx: MatchCtx, ri: number, side: Side): BuyType | null {
  const m = ctx.m;
  const maxrounds = m.env.maxrounds ?? 24;
  const half = maxrounds / 2;
  if (ri < maxrounds && ri % half === 0) return "pistol";
  let n = 0;
  let equip = 0;
  let money = 0;
  let moneyKnown = true;
  for (let pi = 0; pi < ctx.nPlayers; pi++) {
    if (ctx.side(ri, pi) !== side) continue;
    n++;
    const e = m.rounds.equip[ri][pi];
    if (e === null) return null;
    equip += e;
    const mo = m.rounds.money[ri][pi];
    if (mo === null) moneyKnown = false;
    else money += mo;
  }
  if (n === 0) return null;
  if (equip <= 1000 * n) return "eco";
  if (equip >= (side === CT ? 4500 : 4000) * n) return "full";
  if (ri > 0 && m.rounds.winSide[ri - 1] !== side) {
    if (!moneyKnown) return null;
    if (money < 400 * n) return m.rounds.winSide[ri - 1] === null ? null : "force-buy";
  }
  return "semi";
}

export function teamEquip(ctx: MatchCtx, ri: number, side: Side): { equip: number | null; money: number | null } {
  let equip: number | null = 0;
  let money: number | null = 0;
  for (let pi = 0; pi < ctx.nPlayers; pi++) {
    if (ctx.side(ri, pi) !== side) continue;
    const e = ctx.m.rounds.equip[ri][pi];
    const mo = ctx.m.rounds.money[ri][pi];
    equip = e === null || equip === null ? null : equip + e;
    money = mo === null || money === null ? null : money + mo;
  }
  return { equip, money };
}
