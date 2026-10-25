// What derive() returns: plain, JSON-safe facts about one match, one record per event or per player
// per round. rollup() sums them under filters; nothing downstream reads the tables again.
import type { AggroFact } from "./aggression";
import type { AimFact } from "./aim";
import type { BuyClass } from "./economy";
import type { InfoFact } from "./information";
import type { MoveFact } from "./movement";
import type { UtilQFact } from "./utilq";
import type { Side } from "./tables";

/** Bump when a definition changes, so cached facts are rebuilt. */
export const DERIVE_VERSION = 2;

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
  /** ok when the extractor computed mesh visibility; aim families that need it are unavailable otherwise */
  visibility: string;
}

export interface PlayerInfo {
  id: string;
  name: string;
  /** 0 = started CT, 1 = started T; null when the player never had a side */
  team: 0 | 1 | null;
  bot: boolean;
}

export interface RoundFact {
  ri: number;
  /** the team (0/1) on CT this round */
  ctTeam: 0 | 1;
  winner: Side | null;
  reason: string | null;
  durationS: number | null;
  freezeEndTick: number | null;
  endTick: number;
  plantTick: number | null;
  plantSite: string | null;
  defused: boolean;
  exploded: boolean;
  /** team equipment at freeze end and HLTV's buy class, per side */
  equip: Record<Side, number | null>;
  buy: Record<Side, BuyClass | null>;
  /** P(T wins) after each event, from the win-probability lookup (winprob.ts); null when unknown */
  winProb: { tick: number; event: "start" | "kill" | "plant"; pT: number }[] | null;
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
  /** the victim's weapon in hand */
  victimWeapon: string | null;
  headshot: boolean;
  wallbang: boolean;
  smoke: boolean;
  noscope: boolean;
  /** world position of killer and victim, [x, y] */
  kpos: [number, number] | null;
  vpos: [number, number] | null;
  /** an enemy kill: a killer on the other side (not a team kill, suicide or world death) */
  enemy: boolean;
  /** first enemy kill of the round */
  opening: boolean;
  /** the killer killed a player who had killed one of the killer's teammates within TRADE_WINDOW_S */
  tradeKill: boolean;
  /** this death was avenged by a trade kill (rules.ts markTrades) */
  traded: boolean;
  /** eco-adjusted value of the kill (rating3.ts killPoints); null when a duel group is unknown */
  ecoPoints: number | null;
  /** swing credits [player, win-probability points]; empty when the round is not valued */
  credits: [number, number][];
}

/**
 * Additive per-player-round measures, grouped by the family that fills them. rollup sums every one.
 * A measure whose data is missing for a match stays 0 there; the family's `*Rounds` measure counts
 * the rounds where it could be measured, and metrics divide by that.
 */
export const MEASURES = [
  // scoreboard (scoreboard.ts)
  "rounds", "won", "kills", "deaths", "assists", "flashAssists", "hsKills", "dmg", "dmgTaken", "kast", "survived",
  "tradeKills", "tradedDeaths", "openingKills", "openingDeaths", "openingTraded", "openingWins",
  "killRounds", "multiKillRounds", "k3Rounds", "k4Rounds", "k5Rounds", "killsInWins", "dmgInWins", "teamKills",
  "perfectKills", "tradeDenials", "failedTrades", "assistedKills", "savedTeammate", "savedByTeammate", "baitKills",
  // closing (closing.ts)
  "aliveSecs", "lastAlive", "postPlantRounds", "aliveAtPlant", "saves", "lostRounds",
  "clutch1", "clutch2", "clutch3", "clutch4", "clutch5", "clutchWon1", "clutchWon2", "clutchWon3", "clutchWon4", "clutchWon5",
  // sniping (sniping.ts)
  "sniperKills", "awpKills", "sniperKillRounds", "sniperMultiRounds", "sniperOpeningKills", "roundsWithSniper", "roundsWithAwp",
  "awpDuels", "awpDuelWins",
  // opening and trading context (duels.ts): positions needed for the *Pos measures
  "duelRounds", "duelRankSum", "duelTimeSum", "gunShots",
  "posRounds", "deathsPos", "tradeableDeaths", "tradeOpps", "tradeOppsTaken",
  // utility (utility.ts)
  "smokes", "flashes", "hes", "molotovs", "decoys", "enemiesFlashed", "enemyBlindSecs", "teamFlashed", "teamBlindSecs",
  "selfFlashed", "flashKills", "effectiveFlashes", "heDmg", "heHits", "fireDmg", "utilDmg", "utilKills", "utilDmgTaken",
  "utilBought", "utilUnused",
  // swing and Rating 3.0 inputs (swing.ts, rating3.ts)
  "swing", "swingRounds", "rws", "rwsRounds", "openingSwing", "clutchSwing", "awpSwing", "ecoKills", "ecoDeaths", "ecoDmg", "ecoKast", "ecoUnknown",
] as const;
export type Measure = (typeof MEASURES)[number];
export type Measures = Record<Measure, number>;

export interface PlayerRound {
  ri: number;
  pi: number;
  side: Side;
  team: 0 | 1;
  /** null when the round has no result */
  won: boolean | null;
  ownBuy: BuyClass | null;
  oppBuy: BuyClass | null;
  /** at freeze end */
  equip: number | null;
  moneyStart: number | null;
  spent: number | null;
  /** the primary in hand at freeze end */
  primary: string | null;
  m: Measures;
}

/** Per player, round and weapon: what the weapon did. Gun proficiency and accuracy by gun read these. */
export interface WeaponFact {
  ri: number;
  pi: number;
  weapon: string;
  shots: number;
  /** damaging hits on enemies and their damage */
  hits: number;
  headHits: number;
  dmg: number;
  kills: number;
  hsKills: number;
  deaths: number;
}

export interface MatchFacts {
  v: number;
  match: MatchInfo;
  players: PlayerInfo[];
  rounds: RoundFact[];
  /** sorted by round, then player */
  pr: PlayerRound[];
  kills: KillFact[];
  weapons: WeaponFact[];
  /** event facts of the families with their own modules; each carries ri and pi */
  aim: AimFact[];
  movement: MoveFact[];
  aggression: AggroFact[];
  information: InfoFact[];
  utilq: UtilQFact[];
}

export const emptyMeasures = (): Measures => Object.fromEntries(MEASURES.map((k) => [k, 0])) as Measures;
