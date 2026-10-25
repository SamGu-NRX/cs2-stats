// Team buy types: CS Demo Manager's five (computeTeamEconomyType, pkg/api/economy.go) for the existing
// tables, a four-way pistol/eco/force/full class for the round inspector, and the economy views.
import type { MatchCtx } from "./context";
import type { RoundDetail, TeamId, TeamRound } from "./rounds";
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

// ---- Four-way buy classes for the round inspector and economy views ----------------------------
// CS Demo Manager's five types above stay what the existing tables show. These four follow the
// bands of HLTV's match economy tab as I recall them (team equipment under $5,000 is an eco, $20,000
// and up a full buy, for five players); they have not been checked against HLTV. "force" merges
// HLTV's semi-eco and semi-buy bands. Amounts are per player so short-handed teams classify the same.

export const BUY_CLASSES = ["pistol", "eco", "force", "full"] as const;
export type BuyClass = (typeof BUY_CLASSES)[number];

/** Average equipment per player at or below which a buy is an eco. */
export const ECO_MAX_PER_PLAYER = 1000;
/** Average equipment per player at or above which a buy is a full buy. */
export const FULL_MIN_PER_PLAYER = 4000;

/** First round of either regulation half. Overtime rounds start with money for a full buy and are never pistol rounds. */
export function isPistolRound(ri: number, maxrounds: number | null): boolean {
  const max = maxrounds ?? 24;
  return ri < max && ri % (max / 2) === 0;
}

/** Buy class from equipment per player at freeze end. */
export function classifyBuy(perPlayer: number, pistolRound: boolean): BuyClass {
  if (pistolRound) return "pistol";
  if (perPlayer <= ECO_MAX_PER_PLAYER) return "eco";
  if (perPlayer >= FULL_MIN_PER_PLAYER) return "full";
  return "force";
}

/** A team's buy class in round ri: null when the side has no players or anyone's equipment is unknown. */
export function teamBuyClass(ctx: MatchCtx, ri: number, side: Side): BuyClass | null {
  const { equip } = teamEquip(ctx, ri, side);
  let n = 0;
  for (let pi = 0; pi < ctx.nPlayers; pi++) if (ctx.side(ri, pi) === side) n++;
  if (n === 0) return null;
  const pistol = isPistolRound(ri, ctx.m.env.maxrounds);
  if (pistol) return "pistol";
  return equip === null ? null : classifyBuy(equip / n, false);
}

// ---- Economy views ------------------------------------------------------------------------------

export interface TeamEcon {
  side: Side;
  buy: BuyClass | null;
  equip: number | null;
  money: number | null;
  /** estimated money spent (rounds.ts estimateSpent), null when any player's estimate is missing */
  spent: number | null;
  /** players who saved a weapon in a lost round, and the equipment they kept (null without round-end equipment) */
  saves: number;
  savedValue: number | null;
}

export interface EconRound {
  ri: number;
  winner: TeamId | null;
  us: TeamEcon;
  them: TeamEcon;
}

export interface WinTally { rounds: number; wins: number }

export interface EconomyView {
  /** every round in order: buy classes, money and equipment curves, spend and saves per team */
  rounds: EconRound[];
  /** rounds and wins by a team's own buy class, BUY_CLASSES order */
  winRate: Record<TeamId, WinTally[]>;
  /** our buy class (row) against theirs (column); wins are ours */
  matchup: WinTally[][];
  /** rounds with a result but an unclassified buy on either side */
  unknown: number;
  saves: Record<TeamId, { players: number; value: number }>;
}

const tally = (): WinTally => ({ rounds: 0, wins: 0 });

/** Economy tables from the round details. Rounds without a result count in the curves only. */
export function economyView(details: RoundDetail[]): EconomyView {
  const view: EconomyView = {
    rounds: [], winRate: { us: BUY_CLASSES.map(tally), them: BUY_CLASSES.map(tally) },
    matchup: BUY_CLASSES.map(() => BUY_CLASSES.map(tally)), unknown: 0,
    saves: { us: { players: 0, value: 0 }, them: { players: 0, value: 0 } },
  };
  for (const r of details) {
    const econ = (tr: TeamRound): TeamEcon => {
      const saved = tr.saves.map((pi) => r.players[pi]?.equipEnd ?? null);
      return {
        side: tr.side, buy: tr.buy, equip: tr.equip, money: tr.money, spent: tr.spent, saves: tr.saves.length,
        savedValue: saved.some((v) => v === null) ? null : saved.reduce<number>((a, v) => a + v!, 0),
      };
    };
    const usT = r.usSide === 2;
    const us = econ(usT ? r.teams.t : r.teams.ct);
    const them = econ(usT ? r.teams.ct : r.teams.t);
    view.rounds.push({ ri: r.ri, winner: r.winner, us, them });
    view.saves.us.players += us.saves;
    view.saves.them.players += them.saves;
    view.saves.us.value += us.savedValue ?? 0;
    view.saves.them.value += them.savedValue ?? 0;
    if (r.winner === null) continue;
    if (!us.buy || !them.buy) { view.unknown++; continue; }
    const a = BUY_CLASSES.indexOf(us.buy);
    const b = BUY_CLASSES.indexOf(them.buy);
    const won = r.winner === "us" ? 1 : 0;
    view.winRate.us[a].rounds++; view.winRate.us[a].wins += won;
    view.winRate.them[b].rounds++; view.winRate.them[b].wins += 1 - won;
    view.matchup[a][b].rounds++; view.matchup[a][b].wins += won;
  }
  return view;
}
