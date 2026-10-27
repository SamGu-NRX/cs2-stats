// Round buy classes, HLTV's four: PISTOL, ECO, HALF, FULL; and a match's economy team against team.
import type { MatchFacts, PlayerRound } from "./facts";
import type { Side } from "./tables";
//
// HLTV labels each team's round with its equipment value and class: ECO below $5,000, HALF from
// $5,000, FULL from $16,250, and PISTOL on the first round of each half (bands read from HLTV's labels
// over every HLTV map, VALIDATION.md, pnpm scoreboard-variants). For five players that is $1,000 and
// $3,250 per player, which is how the engine classifies, so a short-handed team classifies the same.
// The extractor no longer writes buy types (#24); the engine classifies from equipment value alone.
export const BUY_CLASSES = ["pistol", "eco", "half", "full"] as const;
export type BuyClass = (typeof BUY_CLASSES)[number];

/** Team equipment per player below which a round is an eco. */
export const ECO_BELOW_PER_PLAYER = 1000;
/** Team equipment per player from which a round is a full buy. */
export const FULL_FROM_PER_PLAYER = 3250;

/**
 * First round of either regulation half (ri is 0-based). CS2's MR12 overtime is MR3 halves that start
 * every player on $10,000 (mp_overtime_startmoney), so overtime has no pistol rounds.
 */
export function isPistolRound(ri: number, maxRounds: number): boolean {
  return ri === 0 || ri === maxRounds / 2;
}

/**
 * Finer tiers for the buy splits: HLTV's half buy split at FORCE_FROM_PER_PLAYER into a semi-eco and a
 * force. Leetify shows semi-eco and force splits without publishing its bands; these are ours.
 */
export const BUY_TIERS = ["pistol", "eco", "semiEco", "force", "full"] as const;
export type BuyTier = (typeof BUY_TIERS)[number];
/** Team equipment per player from which a half buy is a force rather than a semi-eco. Ours, no fit: the middle of HLTV's half band in round dollars. */
export const FORCE_FROM_PER_PLAYER = 2000;

export function buyTier(teamEquip: number, players: number, pistol: boolean): BuyTier {
  const c = classifyBuy(teamEquip, players, pistol);
  if (c !== "half") return c;
  return teamEquip / Math.max(1, players) >= FORCE_FROM_PER_PLAYER ? "force" : "semiEco";
}

export function classifyBuy(teamEquip: number, players: number, pistol: boolean): BuyClass {
  if (pistol) return "pistol";
  const per = teamEquip / Math.max(1, players);
  if (per < ECO_BELOW_PER_PLAYER) return "eco";
  if (per >= FULL_FROM_PER_PLAYER) return "full";
  return "half";
}

// ---- a match's economy, team against team ------------------------------------------------------

export interface WinTally { rounds: number; wins: number }

export interface TeamEcon {
  side: Side;
  buy: BuyClass | null;
  /** team equipment at freeze end, money left after buying, and money spent; null when a player's is unknown */
  equip: number | null;
  money: number | null;
  spent: number | null;
  /** players alive at the end of a lost round, and their equipment at freeze end (grenades thrown since still count) */
  saves: number;
  savedEquip: number;
}

export interface EconRound {
  ri: number;
  number: number;
  winner: "us" | "them" | null;
  us: TeamEcon;
  them: TeamEcon;
}

export type Teams<T> = Record<"us" | "them", T>;

export interface EconomyView {
  rounds: EconRound[];
  /** rounds and wins by the team's own buy class, BUY_CLASSES order */
  winRate: Teams<WinTally[]>;
  /** our buy class (row) against theirs (column); wins are ours */
  matchup: WinTally[][];
  /** rounds with a result but an unclassified buy on either side */
  unknown: number;
  /** rounds where the team made the round's first kill, and how many of those it won */
  afterOpening: Teams<WinTally>;
  /** the team's bomb plants (as T) and how they ended */
  plants: Teams<{ planted: number; exploded: number; defused: number }>;
  /** mean team equipment over rounds where both teams' is known */
  avgEquip: Teams<number | null>;
  saves: Teams<{ players: number; equip: number }>;
}

const tally = (): WinTally => ({ rounds: 0, wins: 0 });
const sumOrNull = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + x!, 0));

/** One match's economy from the side of `team` (0 = started CT, 1 = started T). Rounds without a result count in the curves only. */
export function economyOf(f: MatchFacts, team: 0 | 1): EconomyView {
  const v: EconomyView = {
    rounds: [], winRate: { us: BUY_CLASSES.map(tally), them: BUY_CLASSES.map(tally) }, matchup: BUY_CLASSES.map(() => BUY_CLASSES.map(tally)), unknown: 0,
    afterOpening: { us: tally(), them: tally() }, plants: { us: { planted: 0, exploded: 0, defused: 0 }, them: { planted: 0, exploded: 0, defused: 0 } },
    avgEquip: { us: null, them: null }, saves: { us: { players: 0, equip: 0 }, them: { players: 0, equip: 0 } },
  };
  const prOf = new Map<number, PlayerRound[]>();
  for (const r of f.pr) { const l = prOf.get(r.ri); if (l) l.push(r); else prOf.set(r.ri, [r]); }
  const openingSide = new Map<number, Side | null>();
  for (const k of f.kills) if (k.opening) openingSide.set(k.ri, k.killerSide);
  const known: Teams<number[]> = { us: [], them: [] };
  for (const rf of f.rounds) {
    const usSide: Side = rf.ctTeam === team ? "CT" : "T";
    const econ = (side: Side): TeamEcon => {
      const rows = (prOf.get(rf.ri) ?? []).filter((r) => r.side === side);
      const savers = rows.filter((r) => r.m.saves);
      return {
        side, buy: rf.buy[side], equip: rf.equip[side], money: sumOrNull(rows.map((r) => r.money)), spent: sumOrNull(rows.map((r) => r.spent)),
        saves: savers.length, savedEquip: savers.reduce((a, r) => a + (r.equip ?? 0), 0),
      };
    };
    const us = econ(usSide), them = econ(usSide === "CT" ? "T" : "CT");
    const winner = rf.winner === null ? null : rf.winner === usSide ? "us" : "them";
    v.rounds.push({ ri: rf.ri, number: rf.number, winner, us, them });
    for (const [k, t] of [["us", us], ["them", them]] as const) {
      v.saves[k].players += t.saves;
      v.saves[k].equip += t.savedEquip;
      if (t.side === "T" && rf.plantTick !== null) {
        v.plants[k].planted++;
        if (rf.exploded) v.plants[k].exploded++;
        if (rf.defused) v.plants[k].defused++;
      }
    }
    if (us.equip !== null && them.equip !== null) { known.us.push(us.equip); known.them.push(them.equip); }
    if (winner === null) continue;
    const opener = openingSide.get(rf.ri);
    if (opener) {
      const k = opener === usSide ? "us" : "them";
      v.afterOpening[k].rounds++;
      if (winner === k) v.afterOpening[k].wins++;
    }
    if (!us.buy || !them.buy) { v.unknown++; continue; }
    const a = BUY_CLASSES.indexOf(us.buy), b = BUY_CLASSES.indexOf(them.buy);
    const won = winner === "us" ? 1 : 0;
    v.winRate.us[a].rounds++; v.winRate.us[a].wins += won;
    v.winRate.them[b].rounds++; v.winRate.them[b].wins += 1 - won;
    v.matchup[a][b].rounds++; v.matchup[a][b].wins += won;
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  v.avgEquip = { us: mean(known.us), them: mean(known.them) };
  return v;
}
