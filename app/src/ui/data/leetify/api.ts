// Leetify's public CS API replies (https://api-public-docs.cs-prod.leetify.com/), read strictly: a field
// of the wrong type fails the whole reply with its path, so a changed API shows as an error rather than as
// wrong numbers. A field that is absent or null reads as null, since the spec marks many fields nullable
// and a thin profile leaves some out.
//
// Scales are kept exactly as the API sends them (Leetify's guidelines forbid rescaling); present.ts
// formats them the way Leetify's own app shows them. Profile stats are 0 to 100; a match's shares are
// 0 to 1, its Leetify ratings are fractions shown x100, and its reaction_time is seconds.
//
// /v3/profile/matches also returns data_source_match_id, which the spec does not list: for matchmaking
// matches it is the match's share code (join.ts reads it), for FACEIT the FACEIT match id.

export class LeetifyShapeError extends Error {
  constructor(path: string, what: string) {
    super(`Leetify's reply has ${path} ${what}`);
    this.name = "LeetifyShapeError";
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, path: string): Obj {
  if (!isObj(v)) throw new LeetifyShapeError(path, `as ${v === null ? "null" : Array.isArray(v) ? "a list" : typeof v}, not an object`);
  return v;
}
function num(o: Obj, key: string, path: string): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new LeetifyShapeError(`${path}.${key}`, `as ${JSON.stringify(v)}, not a number`);
  return v;
}
function str(o: Obj, key: string, path: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new LeetifyShapeError(`${path}.${key}`, `as ${typeof v}, not text`);
  return v;
}
function need<T>(v: T | null, path: string): T {
  if (v === null) throw new LeetifyShapeError(path, "missing");
  return v;
}
function time(o: Obj, key: string, path: string): { iso: string; ms: number } | null {
  const s = str(o, key, path);
  if (s === null) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new LeetifyShapeError(`${path}.${key}`, `as "${s}", not a date`);
  return { iso: s, ms };
}

// ---------------------------------------------------------------- profile

export const PROFILE_RATING_KEYS = ["aim", "positioning", "utility", "clutch", "opening", "ct_leetify", "t_leetify"] as const;
export type ProfileRatingKey = (typeof PROFILE_RATING_KEYS)[number];

export const PROFILE_STAT_KEYS = [
  "accuracy_enemy_spotted", "accuracy_head", "counter_strafing_good_shots_ratio", "ct_opening_aggression_success_rate",
  "ct_opening_duel_success_percentage", "flashbang_hit_foe_avg_duration", "flashbang_hit_foe_per_flashbang",
  "flashbang_hit_friend_per_flashbang", "flashbang_leading_to_kill", "flashbang_thrown", "he_foes_damage_avg", "he_friends_damage_avg",
  "preaim", "reaction_time_ms", "spray_accuracy", "t_opening_aggression_success_rate", "t_opening_duel_success_percentage",
  "traded_deaths_success_percentage", "trade_kill_opportunities_per_round", "trade_kills_success_percentage", "utility_on_death_avg",
] as const;
export type ProfileStatKey = (typeof PROFILE_STAT_KEYS)[number];

export interface LeetifyProfile {
  name: string;
  steam64: string;
  /** the profile on Leetify, for "View on Leetify"; it names the SteamID, so privacy.ts leaves it to LeetifyLink */
  url: string;
  /** the Leetify user id; null for a player without a Leetify account */
  id: string | null;
  privacyMode: string | null;
  /** 0 to 1 */
  winrate: number | null;
  totalMatches: number | null;
  firstMatch: string | null;
  /** ranks.leetify, already on the display scale (+2.12 shows as +2.12) */
  leetifyRating: number | null;
  premier: number | null;
  rating: Record<ProfileRatingKey, number | null>;
  stats: Record<ProfileStatKey, number | null>;
}

export function parseProfile(v: unknown): LeetifyProfile {
  const p = obj(v, "the profile");
  const at = "profile";
  const ranks = p.ranks === undefined || p.ranks === null ? {} : obj(p.ranks, `${at}.ranks`);
  const rating = p.rating === undefined || p.rating === null ? {} : obj(p.rating, `${at}.rating`);
  const stats = p.stats === undefined || p.stats === null ? {} : obj(p.stats, `${at}.stats`);
  const steam64 = need(str(p, "steam64_id", at), `${at}.steam64_id`);
  return {
    name: need(str(p, "name", at), `${at}.name`),
    steam64,
    url: `https://leetify.com/app/profile/${encodeURIComponent(steam64)}`,
    id: str(p, "id", at),
    privacyMode: str(p, "privacy_mode", at),
    winrate: num(p, "winrate", at),
    totalMatches: num(p, "total_matches", at),
    firstMatch: time(p, "first_match_date", at)?.iso ?? null,
    leetifyRating: num(ranks, "leetify", `${at}.ranks`),
    premier: num(ranks, "premier", `${at}.ranks`),
    rating: Object.fromEntries(PROFILE_RATING_KEYS.map((k) => [k, num(rating, k, `${at}.rating`)])) as LeetifyProfile["rating"],
    stats: Object.fromEntries(PROFILE_STAT_KEYS.map((k) => [k, num(stats, k, `${at}.stats`)])) as LeetifyProfile["stats"],
  };
}

// ---------------------------------------------------------------- matches

/** Every numeric per-player field of a match the public spec lists (PlayerStats). */
export const MATCH_STAT_KEYS = [
  "mvps", "preaim", "reaction_time", "accuracy", "accuracy_enemy_spotted", "accuracy_head", "shots_fired_enemy_spotted", "shots_fired",
  "shots_hit_enemy_spotted", "shots_hit_friend", "shots_hit_friend_head", "shots_hit_foe", "shots_hit_foe_head", "utility_on_death_avg",
  "he_foes_damage_avg", "he_friends_damage_avg", "he_thrown", "molotov_thrown", "smoke_thrown", "counter_strafing_shots_all",
  "counter_strafing_shots_bad", "counter_strafing_shots_good", "counter_strafing_shots_good_ratio", "flashbang_hit_foe",
  "flashbang_leading_to_kill", "flashbang_hit_foe_avg_duration", "flashbang_hit_friend", "flashbang_thrown", "flash_assist", "score",
  "initial_team_number", "spray_accuracy", "total_kills", "total_deaths", "kd_ratio", "rounds_survived", "rounds_survived_percentage",
  "dpr", "total_assists", "total_damage", "leetify_rating", "ct_leetify_rating", "t_leetify_rating", "multi1k", "multi2k", "multi3k",
  "multi4k", "multi5k", "rounds_count", "rounds_won", "rounds_lost", "total_hs_kills", "trade_kill_opportunities", "trade_kill_attempts",
  "trade_kills_succeed", "trade_kill_attempts_percentage", "trade_kills_success_percentage", "trade_kill_opportunities_per_round",
  "traded_death_opportunities", "traded_death_attempts", "traded_deaths_succeed", "traded_death_attempts_percentage",
  "traded_deaths_success_percentage", "traded_deaths_opportunities_per_round",
] as const;
export type MatchStatKey = (typeof MATCH_STAT_KEYS)[number];

export interface LeetifyPlayerStats extends Record<MatchStatKey, number | null> {
  name: string;
  steam64: string;
}

export interface LeetifyMatch {
  /** Leetify's game id (a UUID) */
  id: string;
  finishedAt: string;
  finishedMs: number;
  /** "matchmaking", "faceit", "renown" and so on */
  dataSource: string;
  /** the source's own match id: a share code for matchmaking (see the top of this file) */
  dataSourceMatchId: string | null;
  map: string;
  hasBannedPlayer: boolean;
  /** the connected player's row */
  me: LeetifyPlayerStats;
  /** rounds the player's team won and lost; null when the row lacks them */
  score: { us: number; them: number } | null;
}

function parsePlayer(v: unknown, path: string): LeetifyPlayerStats {
  const o = obj(v, path);
  const stats = Object.fromEntries(MATCH_STAT_KEYS.map((k) => [k, num(o, k, path)])) as Record<MatchStatKey, number | null>;
  return { ...stats, name: need(str(o, "name", path), `${path}.name`), steam64: need(str(o, "steam64_id", path), `${path}.steam64_id`) };
}

/**
 * The match history as LeetifyMatch rows for the player `steam64`. A match without a row for that player
 * is left out and counted in `skipped`, since nothing in it is the player's.
 */
export function parseMatches(v: unknown, steam64: string): { matches: LeetifyMatch[]; skipped: number } {
  if (!Array.isArray(v)) throw new LeetifyShapeError("the match history", "not a list");
  const matches: LeetifyMatch[] = [];
  let skipped = 0;
  v.forEach((raw, i) => {
    const at = `matches[${i}]`;
    const m = obj(raw, at);
    if (!Array.isArray(m.stats)) throw new LeetifyShapeError(`${at}.stats`, "not a list");
    const rows = m.stats.map((s, j) => parsePlayer(s, `${at}.stats[${j}]`));
    const me = rows.find((r) => r.steam64 === steam64);
    if (!me) { skipped++; return; }
    const finished = need(time(m, "finished_at", at), `${at}.finished_at`);
    const won = me.rounds_won, lost = me.rounds_lost;
    matches.push({
      id: need(str(m, "id", at), `${at}.id`),
      finishedAt: finished.iso,
      finishedMs: finished.ms,
      dataSource: need(str(m, "data_source", at), `${at}.data_source`),
      dataSourceMatchId: str(m, "data_source_match_id", at),
      map: need(str(m, "map_name", at), `${at}.map_name`),
      hasBannedPlayer: m.has_banned_player === true,
      me,
      score: won === null || lost === null ? null : { us: won, them: lost },
    });
  });
  matches.sort((a, b) => b.finishedMs - a.finishedMs);
  return { matches, skipped };
}

/** One read of the host's copy. */
export interface LeetifyData {
  profile: LeetifyProfile;
  matches: LeetifyMatch[];
  /** history rows without the player in them */
  skipped: number;
  fetchedAt: number;
}

export function parsePayload(p: { profile: unknown; matches: unknown; fetchedAt: number }): LeetifyData {
  const profile = parseProfile(p.profile);
  const { matches, skipped } = parseMatches(p.matches, profile.steam64);
  return { profile, matches, skipped, fetchedAt: p.fetchedAt };
}

// ---------------------------------------------------------------- links

/** Leetify's pages for "View on Leetify" (Leetify's developer guidelines, section 3.1). */
export const LEETIFY_HOME = "https://leetify.com/";
export const LEETIFY_DEVELOPER = "https://leetify.com/app/developer";
export const matchUrl = (m: Pick<LeetifyMatch, "id">) => `https://leetify.com/app/match-details/${encodeURIComponent(m.id)}/overview`;
