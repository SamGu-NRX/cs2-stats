// The UI thread and the stats worker speak only in these plain types. Every number with a definition
// (metric values, percentiles, attribute scores, ratings, role blends, similarity, economy views) is
// computed in the worker; the UI formats and lays them out. Imports here are types only, so the UI
// thread never loads the engine.
import type { FileEntry } from "../host/host";
import type { AimAgg } from "../stats/aim";
import type { AttributeScore, CompareOptions, Percentile, SideKey } from "../stats/compare";
import type { PoolKind } from "./pool-names";
import type { EconomyView } from "../stats/economy";
import type { GrenadeFact, MatchFacts, Measure, Measures } from "../stats/facts";
import type { GunProficiency } from "../stats/guns";
import type { HighlightKind } from "../stats/highlights";
import type { Moment } from "../stats/moments";
import type { FlashTool } from "../stats/flashes";
import type { OverallRole, RoleBlend, RoleSignal, StylePoint } from "../stats/identity";
import type { Kind, Status, Unit } from "../stats/metrics";
import type { Presence } from "../stats/positions";
import type { Rating3 } from "../stats/rating3";
import type { Best, careerRatings, FocusArea, MetricDelta, SessionAwards } from "../stats/career";
import type { Bombsites, HeadToHead, OpeningDetail, RoundRating, Situations, YourMatchRow, ZoneRow } from "../stats/matchviews";
import type { BuyClass, BuyTier } from "../stats/economy";
import type { VsOpponents } from "../stats/opponents";
import type { WinCorrelation } from "../stats/trends";
import type { Filter, Summary } from "../stats/rollup";
import type { SwingSources } from "../stats/swing";
import type { MatchEntry } from "../ui/data/match";

/**
 * The cache error when a newer build upgraded the IndexedDB cache and this one cannot open it (idb.ts).
 * Shown as is on Home and in the scan status (sources.ts scanErrorText).
 */
export const CACHE_TOO_NEW = "This app's cache was written by a newer CS2 Stats. Install the latest version; your matches are safe on disk.";

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
export interface ClutchRow {
  file: string; round: number; side: "T" | "CT"; player?: string; opponents: number; won: boolean; kills?: number;
  /** lost but alive at the round's end; seconds since freeze end at the start; the clock then (ClutchFact) */
  saved: boolean; t: number | null; afterPlant: boolean; left: number | null;
}

/** One of the player's kills in a highlight, with what the killfeed draws for it. */
export interface HighlightKill {
  weapon: string; headshot: boolean; wallbang: boolean; smoke: boolean; noscope: boolean;
  /** the killer was flashed, or in the air; null when the source does not record it */
  blind: boolean | null; inAir: boolean | null;
}

/**
 * A round worth going back to: three or more enemy kills, or a clutch won. `kills` counts the
 * player's enemy kills in the round and `feed` lists them in order; `clutch` is the won clutch, with
 * the enemies left when it began and the kills made in it. `start` is the match's start (ms since the
 * epoch, 0 when unknown), which orders the list newest first.
 */
export interface HighlightRow {
  file: string; round: number; side: "T" | "CT"; player: string; start: number;
  /** never empty */
  kinds: HighlightKind[];
  kills: number;
  clutch: { opponents: number; kills: number } | null;
  won: boolean | null;
  feed: HighlightKill[];
}

/**
 * One moment worth a POV clip (stats/moments.ts) in the match `file`. `id` names its clip files
 * (clips/ids.ts clipId); `matchRank` is its place among the same match's moments, 1 the best; `start`
 * is the match's start (ms since the epoch, 0 when unknown).
 */
export type MomentRow = Omit<Moment, "ri" | "pi"> & { id: string; file: string; map: string; start: number; matchRank: number };

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
  /** Rating 3.0's label, params.json status, and the order breakdowns list its inputs in (rating3.ts FEATURES) */
  rating: { label: string; status: string; inputs: string[]; weights: string };
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

/**
 * What the pro pool in use says about itself: the shipped public/baselines.json, or the packs folder's
 * baselines.local.json (worker/baselines-pool.ts), with why a local file was passed over.
 */
export interface BaselineInfo {
  source: string;
  built: string;
  n: Record<string, Partial<Record<SideKey, number>>>;
  /** the pool's model fingerprint (model-params.ts modelFingerprint) */
  model: string;
  pool: PoolKind;
  localError: string | null;
}

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

/** "Your match": every metric in this match against the player's recent matches (matchviews.ts yourMatch). */
export interface YourMatchResult { recent: string[]; rows: YourMatchRow[] }

/** Rating by round: each round's rating and terms, the match's rating, and the average the rounds are compared with. */
export interface RatingBreakdown { rows: RoundRating[]; match: Rating3; average: number | null }

export interface Api {
  /** Starts the engine: `winprobPack` is the bytes of packs/winprob-hltv.json, null when it is not installed. */
  /** winprobPack: the packs folder's winprob-hltv.json; localBaselines: its baselines.local.json; null when absent */
  meta(winprobPack: ArrayBuffer | null, localBaselines: ArrayBuffer | null): Meta;
  baselines(): BaselineInfo;
  /**
   * The match list for the listed files. `matches` is null when it is the list the previous sync
   * returned (the same files with the same entries), so a rescan that finds nothing new, one per window
   * focus, sends nothing back and the views keep what they show.
   */
  /** `oneAtATime`: the derive workers could not start in this runtime, so files are derived one at a time (derive-pool.ts) */
  sync(entries: FileEntry[]): { matches: MatchEntry[] | null; errors: { file: string; message: string }[]; oneAtATime: boolean };
  /** `viewer`: the steamid the per-player parts are for; null for the recording player, or none on a pro demo */
  match(file: string, viewer: string | null): MatchBundle;
  /** every round of the match, in round row order */
  rounds(file: string): RoundBundle[];
  /** seconds the recording player spent alive per place name, by round number (positions.ts roundPlaces) */
  places(file: string, viewer: string | null): Record<number, Record<string, number>>;
  rollup(qs: Query[]): Rolled[];
  /** where the query's players stood alive, by map: a rollup's `presence` alone (rollup.ts addPresence) */
  presence(q: Query): Summary["presence"];
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
  trends(series: (number | null)[][]): ({ slope: number; r: number | null; n: number } | null)[];
  /** the query split by the player's own and the opponents' buy class (pistol, eco, half, full): aggression by economy and round type, pistol and eco splits */
  buySplits(q: Query): BuySplits;
  /** the query split by the team's finer buy tier (pistol, eco, semi-eco, force, full; economy.ts buyTier), tiers with rounds only */
  buyTiers(q: Query): Partial<Record<BuyTier, Rolled>>;
  /** each metric for the player against the opponents of the same matches (stats/opponents.ts) */
  opponents(q: Query): VsOpponents[];
  /** Pearson r of each metric per match with winning it, or why there is none (stats/trends.ts winCorrelationOf) */
  winCorrelation(q: Query, metricIds: string[]): Record<string, WinCorrelation>;
  /** one metric's value in each of the query's matches, by file; null where the filter keeps no round of it (stats/trends.ts matchValues) */
  matchValues(q: Query, metricId: string): Record<string, number | null>;
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
  /** each round's Rating 3.0, split by input, with its swing sources and its gap to the reference's rating (the match's own when reference is null) */
  ratingBreakdown(file: string, player: string, reference: Query | null): RatingBreakdown;
  /** every pair of enemies in the match: kills, damage, weapon classes, flashes and openings each way */
  headToHead(file: string): HeadToHead[];
  /** the player's kills and deaths per map zone and side, with the map's zone list */
  mapZones(file: string, player: string): { zones: string[]; rows: ZoneRow[] };
  /** every metric in this match against the player's `n` most recent earlier matches */
  yourMatch(file: string, player: string, n: number): YourMatchResult;
  /** the match's opening kills round by round, and the player's best opening weapon and conversion */
  openingDuels(file: string, player: string): OpeningDetail;
  /** man-advantage situations ("5v4") over the query's rounds: rounds that reached each, and rounds won */
  situations(q: Query): Situations;
  /** take, hold, retake and post-plant attempts and successes per bombsite, over the player's rounds */
  bombsites(file: string, player: string): Bombsites;
  /** every clutch of the player in the query's matches, by round */
  clutches(q: Query): ClutchRow[];
  /** every round of the player's with two or more kills in the query's matches (the rows its filter keeps) */
  multiKills(q: Query): MultiKillRow[];
  /** the player's 3K-or-better rounds and won clutches in the query's matches (the rows its filter keeps), newest first */
  highlights(q: Query): HighlightRow[];
  /** the player's moments for POV clips in the query's matches (the rows its filter keeps), best first across them */
  moments(q: Query): MomentRow[];
  /** the player's flashbangs in the match: where each detonated, whom it blinded and for how long, and the kills it led to */
  flashes(file: string, player: string): FlashTool;
}

export type Method = keyof Api;
export type Result<K extends Method> = ReturnType<Api[K]>;

export interface Call { id: number; method: Method; args: unknown[] }

export type ToWorker =
  | { batch: Call[] }
  | { rid: number; bytes?: ArrayBuffer; error?: string }
  /** the derive workers the page started for request `spawned` (derive-spawn.ts), a port to each */
  | { spawned: number; ports: MessagePort[] }
  /** derive worker `i` of request `deriverFailed` failed to load or crashed */
  | { deriverFailed: number; i: number; why: string };

export type FromWorker =
  | { id: number; result?: unknown; error?: string }
  | { rid: number; need: string }
  | { progress: { done: number; total: number } }
  /** asks the page for `n` derive workers (derive-spawn.ts); `despawn` ends request `spawn`'s */
  | { spawn: number; n: number }
  | { despawn: number };
