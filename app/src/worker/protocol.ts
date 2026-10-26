// The UI thread and the stats worker speak only in these plain types. Every number with a definition
// (metric values, percentiles, attribute scores, ratings, role blends, similarity, economy views) is
// computed in the worker; the UI formats and lays them out. Imports here are types only, so the UI
// thread never loads the engine.
import type { FileEntry } from "../host/host";
import type { AimAgg } from "../stats/aim";
import type { AttributeScore, CompareOptions, Percentile, SideKey } from "../stats/compare";
import type { EconomyView } from "../stats/economy";
import type { GrenadeFact, MatchFacts, Measure, Measures } from "../stats/facts";
import type { GunProficiency } from "../stats/guns";
import type { OverallRole, RoleBlend, RoleSignal, StylePoint } from "../stats/identity";
import type { Kind, Status, Unit } from "../stats/metrics";
import type { Presence } from "../stats/positions";
import type { Rating3 } from "../stats/rating3";
import type { Best, careerRatings, FocusArea, MetricDelta, SessionAwards } from "../stats/career";
import type { BuyClass, BuyTier } from "../stats/economy";
import type { VsOpponents } from "../stats/opponents";
import type { Filter, Summary } from "../stats/rollup";
import type { SwingSources } from "../stats/swing";
import type { MatchEntry } from "../ui/data/match";

/** Which matches a question covers (the map and time filters, resolved to files) and whose rounds. */
export interface Query { files: string[]; filter: Filter }

/** Every metric's value over one summary, by metric id (METRIC[id].value). */
export type Values = Record<string, number | null>;

/**
 * A rollup with its metric values, the event count behind each metric that declares one (Metric.sample:
 * AWP duels, saved rounds, duels), round swing by source (swing.ts swingSources), and the visibility
 * coverage meter (aim.ts visibilityCoverage).
 */
export type Rolled = Summary & { v: Values; n: Record<string, number>; swingSources: SwingSources | null; coverage: number | null };

/** A summary cut down to what a table row needs: the measures and the metric values. */
export interface BuySplits { own: Partial<Record<BuyClass, Rolled>>; opp: Partial<Record<BuyClass, Rolled>> }

/** One round where a player got two or more enemy kills; `won` is null when the round has no result. */
export interface MultiKillRow { file: string; round: number; side: "T" | "CT"; player: string; kills: number; won: boolean | null }

/**
 * One clutch, with the player (steamid) and their enemy kills after the clutch started. The engine
 * always sets both; they are optional so the UI's own fixtures, which predate them, still compile.
 */
export interface ClutchRow { file: string; round: number; side: "T" | "CT"; player?: string; opponents: number; won: boolean; kills?: number }

export interface Line {
  m: Measures;
  v: Values;
  /** the eco-adjusted scoreboard (rating3.ts inputs over valued rounds): eK and eD totals, eADR, eKAST; null under the coverage gate. A(f) and D(t) are m.flashAssists and m.tradedDeaths. */
  eco: { ek: number; ed: number; eadr: number; ekast: number } | null;
  /** Rating 3.0 under the coverage rule (ui/data/engine.ts ratedMatch); null below it */
  rating: number | null;
}

/** Per side, as rating3BySide returns it; values are null under the coverage rule. */
export type SideRatings = Record<"both" | "CT" | "T", Rating3>;

/** A metric's description without its value function. */
export interface MetricMeta {
  id: string;
  label: string;
  hltv?: string;
  kind: Kind;
  group: string;
  unit: Unit;
  status: Status;
  def: string;
  /** the tooltip: one sentence of 12 words or fewer, in a player's words (Metric.tip) */
  tip: string;
  lowerIsBetter?: boolean;
  /** what the metric's events are called, and the count a percentile needs (Metric.sample) */
  sample?: { unit: string; min?: number };
  /** a share's numerator and denominator measures (metrics.ts Metric.of) */
  of?: [Measure, Measure];
}

/** Engine descriptions the UI shows, sent once at start. */
export interface Meta {
  metrics: MetricMeta[];
  attributes: { id: string; label: string; kind: Kind; metrics: string[] }[];
  /** Rating 3.0's label, params.json status, and its linear terms (rating3.ts RATING3_TERMS) for breakdowns */
  rating: { label: string; status: string; intercept: number; terms: { name: string; input: string; coefficient: number }[]; weights: string };
  /** the round win-probability source facts are derived with (model-params.ts), for Settings */
  winProb: { kind: "hltv" | "cs2rb"; label: string };
  /** the six style attributes "plays like" compares (identity.ts STYLE) */
  style: string[];
  /** the role card's signals and the style compass's threshold lines (identity.ts ROLE_SIGNALS) */
  signals: readonly RoleSignal[];
  /** AWP kills per round above which a player is an AWPer (compare.ts AWPER_MIN_AWP_KPR) */
  awperKpr: number;
  deriveVersion: number;
}

/** What public/baselines.json says about itself; null fields while it failed to load. */
export interface BaselineInfo { source: string; built: string; n: Record<string, Partial<Record<SideKey, number>>> }

/** One match's facts without the family event facts (aim, movement and so on), which only rollups read. */
export type MatchCore = Pick<MatchFacts, "v" | "match" | "players" | "rounds" | "pr" | "kills" | "totalsRounds">;

/** Everything the match views read. Lines are indexed by player index (pi). */
export interface MatchBundle {
  core: MatchCore;
  lines: Record<"both" | "t" | "ct", Line[]>;
  /** each team's five players rolled up together over the match */
  teams: Record<"us" | "them", Line>;
  /** economyOf from the recording player's team */
  economy: EconomyView;
  /** per round row (ri): your team's swing summed, a fraction; null when the round is not valued */
  teamSwing: (number | null)[];
  /** per round row (ri): your metric values in that round alone */
  yourRounds: Values[];
  /** grenadesOf over every player of the match */
  grenades: GrenadeFact[];
  /** where the recording player spent their time alive over the match */
  presence: Presence | null;
}

/** One player's numbers in one round (rollup with a round filter); headHits are gun hits on the head. */
export interface RoundLine { m: Measures; v: Values; aim: Pick<AimAgg, "shots" | "hits" | "first" | "firstHits">; headHits: number }

export interface RoundBundle { number: number; players: (RoundLine | null)[] }

/** A player's role: the blend on each side, and over all rounds. */
export interface Roles { T: RoleBlend; CT: RoleBlend; all: OverallRole }

/** Performance percentiles against the pros (public/baselines.json); identity metrics are left out. */
export interface CompareResult {
  p: Record<string, Percentile>;
  /** the player's role pool (compare.ts roleOf) and the pool's size on that side */
  role: "awper" | "rifler";
  n: number;
}

/** The performance attributes (Firepower) against the pros; the style attributes come from `style`. */
export interface AttributesResult { scores: AttributeScore[]; role: "awper" | "rifler"; n: number }

/**
 * The bots in the user's matches that the user's style ranks against (design/identity.md): their
 * careers (compare.ts careerBaselines), or while fewer than `minPool` careers qualify, the bots'
 * single matches (worker/ranking.ts botPopulation).
 */
export interface Careers {
  /** what one sample in the pool is: a bot career, or one bot in one match */
  unit: "careers" | "matches";
  /** the pool the samples come from: the role asked for, or "all" when the AWPer pool had too few (ranking.ts botPopulation); careersFor always sets it */
  pool?: string;
  /** bot matches in the query's matches (one per bot per match) */
  botMatches: number;
  /** careers with `minRounds` or more rounds in the query's matches */
  qualified: number;
  /** BOT_CAREERS_MIN: career scores are provisional below it (match-pool scores always are) */
  needed: number;
  /** CAREER_MIN_ROUNDS */
  minRounds: number;
  provisional: boolean;
  /** MIN_UNITS: a pool smaller than this has no quantiles, so every score in it is null; careers below it fall back to matches */
  minPool: number;
}

/** The user's style against the bot careers: the six style attributes and every identity metric's percentile. */
export interface AttributeBlock { firepower: AttributeScore | null; style: StyleResult; proPool: number }

export interface StyleResult {
  scores: AttributeScore[];
  /** Firepower against the same bot pool as the style scores (the attribute block's `firepower` is against the pros) */
  firepower: AttributeScore | null;
  p: Record<string, Percentile>;
  role: "awper" | "rifler";
  /** samples (careers or bot matches, per `careers.unit`) in the pool the scores read, on the asked side */
  n: number;
  careers: Careers;
}

export interface PlaysLikeResult {
  ranked: { slug: string; similarity: number }[];
  /** the population the user's twelve style scores ranked against */
  careers: Careers;
}

/** A pro in the pack, as the pack file holds it (scores in ATTRIBUTE_ORDER). */
export interface PackPro { slug: string; both: (number | null)[]; ct: (number | null)[]; t: (number | null)[] }

/**
 * One spawn a player started rounds from: its key ("x,y", PlayerRound.spawn), map, the map's place name
 * there (raw, "TSpawn"; null when the sample has none), and where it sits in the side's spawn area
 * facing the enemy spawn ("front left", "centre"; positions.ts spawnPosition; null without a facing).
 */
export interface SpawnRow { spawn: string; map: string; side: "T" | "CT"; place: string | null; position: string | null; rounds: number }

/**
 * The style compass: you and the bots the style ranks against in the "all" pool on both sides (bot
 * careers with CAREER_MIN_ROUNDS or more rounds, else single bot matches; `careers.unit` says which),
 * each at opening attempts and trade/assist share.
 */
export interface CompassResult { you: StylePoint | null; bots: StylePoint[]; careers: Careers }

export interface PositionsResult {
  /** world [x, y] of the players' enemy kills (where the killer stood) and of their deaths */
  kills: [number, number][];
  deaths: [number, number][];
  /** seconds alive per cell and per place, over the kept rounds on the query's one map */
  presence: Presence | null;
}

/** A date range, inclusive YYYY-MM-DD bounds, as Filter.from and to read them. */
export interface Period { from: string; to: string }

/** Aim Rating, Utility Rating and the utility sub-ratings, 0-100 (career.ts careerRatings). */
export type CareerRatings = ReturnType<typeof careerRatings>;

/** One play session: its matches in order, when it ran, its record and totals, and its awards. */
export interface Session {
  files: string[];
  /** start of the first match and end of the last, ms since the epoch */
  start: number;
  end: number;
  wins: number;
  losses: number;
  ties: number;
  rounds: number;
  kills: number;
  deaths: number;
  /** Rating 3.0 over the session's rounds; null under the rating's gate */
  rating: number | null;
  awards: SessionAwards;
}

export interface Api {
  /** Starts the engine: `winprobPack` is the bytes of packs/winprob-hltv.json, null when it is not installed. */
  meta(winprobPack: ArrayBuffer | null): Meta;
  baselines(): BaselineInfo;
  sync(entries: FileEntry[]): { matches: MatchEntry[]; errors: { file: string; message: string }[] };
  match(file: string): MatchBundle;
  /** every round of the match, in round row order */
  rounds(file: string): RoundBundle[];
  /** seconds the recording player spent alive per place name, by round number (positions.ts roundPlaces) */
  places(file: string): Record<number, Record<string, number>>;
  rollup(qs: Query[]): Rolled[];
  ratings(qs: Query[]): SideRatings[];
  guns(q: Query): GunProficiency[];
  positions(q: Query): PositionsResult;
  /** performance metrics against the pros */
  compare(q: Query, opt: CompareOptions): CompareResult;
  /** performance attributes against the pros */
  attributes(q: Query, opt: CompareOptions): AttributesResult;
  /** the user's style attributes and identity metrics against the bot careers in the query's matches */
  style(q: Query, opt: CompareOptions): StyleResult;
  /** HLTV's attribute block in one call: Firepower against the pros and the six style attributes against the bots, each with its four metrics' values, percentiles and reasons, for one side and pool */
  attributeBlock(q: Query, opt: CompareOptions): AttributeBlock;
  /** the role blend on T and on CT (the query's side filter is replaced), and over all rounds (identity.ts overallRole) */
  roles(q: Query): Roles;
  /** roles() per map in the query's matches, most rounds first */
  rolesByMap(q: Query): ({ map: string } & Roles)[];
  /** pros ranked by style similarity over T and CT (identity.ts mostSimilar), the user's side scored against the bot careers */
  playsLike(q: Query, pros: PackPro[]): PlaysLikeResult;
  /** you and the bots of your style population on the style compass, over both sides of the query's matches */
  compass(q: Query): CompassResult;
  /** least-squares trend of each series over match order (trends.ts trend) */
  trends(series: (number | null)[][]): ({ slope: number; r: number; n: number } | null)[];
  /** the query split by the player's own and the opponents' buy class (pistol, eco, half, full): aggression by economy and round type, pistol and eco splits */
  buySplits(q: Query): BuySplits;
  /** the query split by the team's finer buy tier (pistol, eco, semi-eco, force, full; economy.ts buyTier), tiers with rounds only */
  buyTiers(q: Query): Partial<Record<BuyTier, Rolled>>;
  /** each metric for the player against the opponents of the same matches (stats/opponents.ts) */
  opponents(q: Query): VsOpponents[];
  /** Pearson r of each metric per match with winning it (stats/trends.ts winCorrelationOf) */
  winCorrelation(q: Query, metricIds: string[]): Record<string, { r: number; n: number } | null>;
  /** the role blend per side and per spawn the player used (the spawns filter), each spawn with its map, place name and position (SpawnRow) */
  rolesBySpawn(q: Query): Record<"T" | "CT", (SpawnRow & { blend: RoleBlend })[]>;
  /** Aim Rating, Utility Rating and its quantity and quality sub-ratings, 0-100, as weighted pro percentiles */
  careerRatings(q: Query, opt: CompareOptions): CareerRatings;
  /** the five performance metrics with the highest pro percentile */
  topStats(q: Query, opt: CompareOptions): Percentile[];
  /** the weakest skills under the pros' 50th percentile, ranked by the gap, each with a tip */
  focusAreas(q: Query, opt: CompareOptions): FocusArea[];
  /** every metric over the current period against the previous one */
  periodCompare(q: Query, current: Period, previous: Period): MetricDelta[];
  /** the best single-match value of every count and performance metric, with the match it came from */
  personalBests(q: Query): Best[];
  /** the query's matches with rounds its filter keeps, grouped into sessions split by a gap of `gapHours` (3 by default) between one match's end and the next one's start */
  sessions(q: Query, gapHours?: number): Session[];
  /** every clutch of the player in the query's matches, by round */
  clutches(q: Query): ClutchRow[];
  /** every round of the player's with two or more kills in the query's matches (the rows its filter keeps) */
  multiKills(q: Query): MultiKillRow[];
}

export type Method = keyof Api;
export type Result<K extends Method> = ReturnType<Api[K]>;

export interface Call { id: number; method: Method; args: unknown[] }

export type ToWorker =
  | { batch: Call[] }
  | { rid: number; bytes?: ArrayBuffer; error?: string };

export type FromWorker =
  | { id: number; result?: unknown; error?: string }
  | { rid: number; need: string }
  | { progress: { done: number; total: number } };
