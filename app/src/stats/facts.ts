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
export const DERIVE_VERSION = 14;

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
  /** rounds won over the whole match, same order as teams (match.extra "final_score" when the source holds rounds it does not cover) */
  score: [number, number];
  /**
   * The match was played to its end: the source says so (match.extra "status", the plugin's), else a
   * team passed half the round limit or the teams tied on it. Career views leave out the rest.
   */
  complete: boolean;
  nRounds: number;
  /** ok when the extractor computed mesh visibility; aim families that need it are unavailable otherwise */
  visibility: string;
  /** steamid of the player whose machine recorded the match (match.extra "pov"); null for pro demos */
  pov: string | null;
  /**
   * Rounds the match had. nRounds counts the rounds these facts cover, which is fewer when the source
   * held some rounds as totals only (the plugin adapter leaves those out); a rating over a small
   * covered share of a match is not that match's rating.
   */
  roundsPlayed: number;
  /**
   * round numbers the source holds only as totals (a converted log's first rounds, rounds the plugin
   * marked partial), from match.extra "totals_only_rounds": played, but absent from rounds and every
   * rate. Empty for demos.
   */
  totalsOnly: number[];
  /** when the match began, an ISO timestamp from match.extra "started_at"; null when the source has no clock time */
  startedAt: string | null;
  /** seconds from the first round's start to the last round's end (match.extra "duration_s" when the source knows it) */
  durationS: number | null;
  /** the round win-probability source swing was valued with (model-params.ts) */
  winProb: "hltv" | "cs2rb";
  /** model-params.ts modelFingerprint: the rating parameters and win-probability source these facts were derived with */
  model: string;
  inputs: {
    /** the source's throws: logged, or rebuilt from detonations (the plugin's older files), whose throw point and time are approximate */
    throws: "logged" | "rebuilt" | null;
    /**
     * what a plugin file's "target on screen" comes from: line of sight, the game's spotted flags, or
     * the spotted flags because line of sight failed partway (ON_SCREEN_NOTE). Null for demos, whose
     * visibility comes from the extractor's engagements.
     */
    onScreen: OnScreenSource | null;
  };
}

export type OnScreenSource = "los" | "spotted" | "spotted-los-lost";

/** The note a match whose on-screen source is a fallback carries wherever its aim numbers are shown. */
export const ON_SCREEN_NOTE: Partial<Record<OnScreenSource, string>> = {
  "spotted-los-lost": "line of sight lost partway; using the game's spotted flags",
};

/**
 * Inputs some metrics need, each counted per row by a pair of measures: [rows where the input is
 * known, rows the metric uses]. A metric whose input is known on only some rows is computed over the
 * known rows and gets no pro percentile; compare.ts says how many were known.
 */
export const INPUT_COVERAGE = {
  /** freeze-end inventory and best primary recorded for the player-round */
  loadout: ["loadoutRounds", "rounds", "freeze-end loadout", "rounds"],
  /** the weapon in the victim's hand recorded for an enemy kill */
  activeWeapon: ["deathsHandKnown", "deathsHandTotal", "weapon in hand", "deaths"],
  /**
   * both players' loadouts recorded for a kill or death the eco adjustment values. This gates only the
   * percentile: the rating's eco values need just the economy groups, which the weapon or equipment
   * value give (rating3.ts ecoAdjust).
   */
  eco: ["ecoEventsKnown", "ecoEvents", "both players' loadout", "kills and deaths"],
} as const;
export type Input = keyof typeof INPUT_COVERAGE;

export interface PlayerInfo {
  id: string;
  name: string;
  /** 0 = started CT, 1 = started T; null when the player never had a side */
  team: 0 | 1 | null;
  bot: boolean;
}

export interface RoundFact {
  /** row index; facts address rounds by it */
  ri: number;
  /** the round's number in the match, 1-based; equal to ri + 1 unless the source skipped rounds */
  number: number;
  /** the team (0/1) on CT this round */
  ctTeam: 0 | 1;
  winner: Side | null;
  reason: string | null;
  durationS: number | null;
  freezeEndTick: number | null;
  endTick: number;
  plantTick: number | null;
  plantSite: string | null;
  /** player indexes of the planter and the defuser */
  planter: number | null;
  defuser: number | null;
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
  /** the killer was flashed, or in the air, at the kill (kills.attackerblind, attackerinair); null when the source does not record it */
  killerBlind: boolean | null;
  killerInAir: boolean | null;
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
  "rounds", "won", "kills", "deaths", "assists", "flashAssists", "hsKills", "dmg", "dmgTaken", "teamDmg", "kast", "survived",
  // what earned each KAST round, first match in K, A, S, T order: kast = killRounds + kastA + kastS + kastT
  "kastA", "kastS", "kastT",
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
  "posRounds", "deathsPos", "tradeableDeaths", "tradedAttempts", "tradeableTraded", "tradeOpps", "tradeAttempts", "tradeOppsTaken",
  // team spacing, Packer's features (positioning.ts)
  "spacingSamples", "adntRank", "adatRank", "deathTimeSum",
  // utility (utility.ts)
  "smokes", "flashes", "hes", "molotovs", "flashKills", "heDmg", "utilDmgTaken", "utilUnused", "utilDeaths",
  "enemiesFlashed", "enemyBlindSecs", "teamFlashed", "teamBlindSecs", "utilDmg", "fireDmg", "molotovHits",
  // row coverage of the inputs some metrics need (INPUT_COVERAGE)
  "loadoutRounds", "deathsHandKnown", "deathsHandTotal", "ecoEventsKnown", "ecoEvents",
  // grenades bought (purchases table): money, and the rounds where purchases were recorded
  "utilSpent", "purchaseRounds",
  // swing and Rating 3.0 inputs (swing.ts, rating3.ts)
  "swing", "swingRounds", "rws", "rwsRounds", "openingSwing", "clutchSwing", "awpSwing", "flashSwing",
  // eco-adjusted measures over the player-rounds whose every eco value is known (ecoRounds, rating3.ts ecoAdjust)
  "ecoKills", "ecoDeaths", "ecoDmg", "ecoKast", "ecoRounds",
  // Rating 3.0's six inputs over the rounds both swing and the eco adjustment valued (ratedRounds), so all six share one set of rounds
  "ratedRounds", "vEcoKills", "vEcoDeaths", "vEcoDmg", "vEcoKast", "vMultiKillRounds", "vSwing",
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
  /** money left after buying */
  money: number | null;
  spent: number | null;
  /** the primary in hand at freeze end */
  primary: string | null;
  /** spawn point, "x,y" rounded to 16 units (players cannot move before freeze end); null without positions */
  spawn: string | null;
  /** the additive measures; a measure that is 0 is left out, which keeps cached facts small */
  m: Partial<Measures>;
}

/** Per player, round and weapon: what the weapon did. Gun proficiency and accuracy by gun read these. */
export interface WeaponFact {
  ri: number;
  pi: number;
  weapon: string;
  shots: number;
  /** damaging hits on enemies, those hits by body part (HIT_GROUPS order), and their damage */
  hits: number;
  groups: number[];
  dmg: number;
  kills: number;
  hsKills: number;
  deaths: number;
}

/** Body parts in the order of WeaponFact.groups. Hits the game files under "generic" count in hits only. */
export const HIT_GROUPS = ["head", "neck", "chest", "stomach", "left_arm", "right_arm", "left_leg", "right_leg"] as const;

/** One grenade a player threw. Positions are world [x, y]; land is null when the projectile was not tracked. */
export interface GrenadeFact {
  ri: number;
  pi: number;
  /** the grenade class: smokegrenade, flashbang, hegrenade, molotov, incgrenade, decoy */
  weapon: string;
  /** seconds since freeze end */
  t: number | null;
  from: [number, number] | null;
  land: [number, number] | null;
}

/**
 * Where one player spent the match alive on one side (positions.ts): seconds per grid cell and per
 * place name. Kept per side, not per round, because per-round presence made cached facts too large
 * (VALIDATION.md); one round's places come from the tables (positions.ts roundPlaces).
 */
export interface PresenceFact {
  pi: number;
  side: Side;
  /** [cell, seconds, cell, seconds, ...]; cells are positions.ts cellOf */
  cells: number[];
  places: Record<string, number>;
}

/** One clutch: the player became the last of their side alive against `opponents` enemies (rules.ts detectClutches). */
export interface ClutchFact { ri: number; pi: number; opponents: number; won: boolean }

export interface MatchFacts {
  v: number;
  match: MatchInfo;
  players: PlayerInfo[];
  rounds: RoundFact[];
  /** sorted by round, then player */
  pr: PlayerRound[];
  kills: KillFact[];
  weapons: WeaponFact[];
  grenades: GrenadeFact[];
  clutches: ClutchFact[];
  presence: PresenceFact[];
  /** event facts of the families with their own modules; each carries ri and pi */
  aim: AimFact[];
  movement: MoveFact[];
  aggression: AggroFact[];
  information: InfoFact[];
  utilq: UtilQFact[];
}

export const emptyMeasures = (): Measures => Object.fromEntries(MEASURES.map((k) => [k, 0])) as Measures;
