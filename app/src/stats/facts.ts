// What derive() returns: plain, JSON-safe facts about one match, one record per event or per player
// per round. rollup() sums them under filters; nothing downstream reads the tables again.
import type { BuyClass } from "./economy";
import type { Side } from "./tables";

/** Bump when a definition changes, so cached facts are rebuilt. */
export const DERIVE_VERSION = 1;

export interface MatchInfo {
  id: string;
  source: string;
  map: string;
  /** YYYY-MM-DD, null when the source has no date */
  date: string | null;
  tickRate: number;
  maxRounds: number;
  /** team names: [the team that started CT, the team that started T] */
  teams: [string, string];
  /** rounds won, same order as teams */
  score: [number, number];
  nRounds: number;
}

export interface PlayerInfo {
  id: string;
  name: string;
  /** 0 = started CT, 1 = started T; null when the player never had a side */
  team: 0 | 1 | null;
}

export interface RoundFact {
  ri: number;
  /** the team (0/1) on CT this round */
  ctTeam: 0 | 1;
  winner: Side | null;
  reason: string | null;
  durationS: number | null;
  plantTick: number | null;
  plantSite: string | null;
  defused: boolean;
  exploded: boolean;
  /** team equipment at freeze end and HLTV's buy class, per side */
  equip: Record<Side, number | null>;
  buy: Record<Side, BuyClass | null>;
}

export interface KillFact {
  ri: number;
  tick: number;
  /** seconds since freeze end */
  t: number | null;
  killer: number | null;
  victim: number;
  assister: number | null;
  /** the assist was a flash assist */
  flashAssist: boolean;
  killerSide: Side | null;
  victimSide: Side | null;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  smoke: boolean;
  noscope: boolean;
  /** an enemy kill: a killer on the other side (not a team kill, suicide or world death) */
  enemy: boolean;
  /** first death of the round that is not a team kill or suicide */
  opening: boolean;
  /** the killer killed a player who had killed one of the killer's teammates within TRADE_WINDOW_S */
  tradeKill: boolean;
  /** the victim's killer was killed by the victim's team within TRADE_WINDOW_S */
  traded: boolean;
}

/** Additive per-player-round measures; rollup sums them. Keep this list and PlayerRound in step. */
export const MEASURES = [
  "rounds", "won", "kills", "deaths", "assists", "flashAssists", "hsKills", "dmg", "kast", "survived",
  "tradeKills", "tradedDeaths", "openingKills", "openingDeaths", "openingTraded", "openingWins",
  "multiKillRounds", "killRounds",
] as const;
export type Measure = (typeof MEASURES)[number];
export type Measures = Record<Measure, number>;

export interface PlayerRound extends Measures {
  ri: number;
  pi: number;
  side: Side;
  team: 0 | 1;
  ownBuy: BuyClass | null;
  oppBuy: BuyClass | null;
}

export interface MatchFacts {
  v: number;
  match: MatchInfo;
  players: PlayerInfo[];
  rounds: RoundFact[];
  /** sorted by round, then player */
  pr: PlayerRound[];
  kills: KillFact[];
}

export const emptyMeasures = (): Measures => Object.fromEntries(MEASURES.map((k) => [k, 0])) as Measures;
