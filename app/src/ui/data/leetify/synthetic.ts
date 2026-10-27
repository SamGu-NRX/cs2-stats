// Synthetic Leetify replies in the public API's documented shapes (ProfileResponse and
// MatchDetailsResponse, https://api-public-docs.cs-prod.leetify.com/), with made-up numbers. Tests build
// their fixtures from these, and `vite dev` with ?leetify=synthetic serves them through a stand-in bridge
// for screenshots; every view that shows them says they are synthetic. No real player's data is in here.
import type { LeetifyBridge, LeetifyPayload, LeetifyPlayer, LeetifyStatus } from "../../../host/leetify";
import { encodeShareCode } from "./sharecode";

/** The bundled samples' recording player (scripts/steamid-allowlist.txt: the synthetic replacement id). */
export const SYNTHETIC_STEAM64 = "76561197961265729";

export function syntheticProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    privacy_mode: "public",
    winrate: 0.5312,
    total_matches: 214,
    first_match_date: "2025-03-02T18:20:00.000Z",
    name: "Synthetic player",
    bans: [],
    steam64_id: SYNTHETIC_STEAM64,
    id: "5e7a1c00-0000-4000-8000-00000000c0de",
    ranks: { leetify: 1.84, premier: 14250, faceit: null, faceit_elo: null, wingman: null, renown: null, competitive: [{ map_name: "de_dust2", rank: 12 }] },
    rating: { aim: 62.4, positioning: 54.1, utility: 47.9, clutch: 0.0312, opening: -0.0087, ct_leetify: 0.0221, t_leetify: 0.0147 },
    stats: {
      accuracy_enemy_spotted: 31.82, accuracy_head: 21.4, counter_strafing_good_shots_ratio: 74.2, ct_opening_aggression_success_rate: 38.5,
      ct_opening_duel_success_percentage: 47.1, flashbang_hit_foe_avg_duration: 2.71, flashbang_hit_foe_per_flashbang: 0.62,
      flashbang_hit_friend_per_flashbang: 0.31, flashbang_leading_to_kill: 9.8, flashbang_thrown: 11.2, he_foes_damage_avg: 8.9,
      he_friends_damage_avg: 0.7, preaim: 10.86, reaction_time_ms: 612.4, spray_accuracy: 33.5, t_opening_aggression_success_rate: 44.2,
      t_opening_duel_success_percentage: 51.3, traded_deaths_success_percentage: 48.6, trade_kill_opportunities_per_round: 0.29,
      trade_kills_success_percentage: 41.7, utility_on_death_avg: 168.2,
    },
    recent_matches: [],
    recent_teammates: [],
    ...over,
  };
}

export interface SyntheticMatch {
  id: string;
  finished: string;
  map: string;
  source?: string;
  /** a share code, or another source's id; null for none */
  sourceId?: string | null;
  won: number;
  lost: number;
  kills: number;
  deaths: number;
  rating: number;
  steam64?: string;
  name?: string;
}

/** One match row as /v3/profile/matches returns it, with the player's numbers filled around the given ones. */
export function syntheticMatch(s: SyntheticMatch): Record<string, unknown> {
  const rounds = s.won + s.lost;
  return {
    id: s.id,
    finished_at: s.finished,
    data_source: s.source ?? "matchmaking",
    data_source_match_id: s.sourceId === undefined ? null : s.sourceId,
    map_name: s.map,
    has_banned_player: false,
    team_scores: [{ team_number: 2, score: s.lost }, { team_number: 3, score: s.won }],
    stats: [{
      steam64_id: s.steam64 ?? SYNTHETIC_STEAM64, name: s.name ?? "Synthetic player", mvps: 2, preaim: 11.4, reaction_time: 0.598,
      accuracy: 0.214, accuracy_enemy_spotted: 0.322, accuracy_head: 0.196, shots_fired_enemy_spotted: 188, shots_fired: 402,
      shots_hit_enemy_spotted: 61, shots_hit_friend: 1, shots_hit_friend_head: 0, shots_hit_foe: 86, shots_hit_foe_head: 17,
      utility_on_death_avg: 175, he_foes_damage_avg: 11.5, he_friends_damage_avg: 0, he_thrown: 4, molotov_thrown: 3, smoke_thrown: 5,
      counter_strafing_shots_all: 120, counter_strafing_shots_bad: 31, counter_strafing_shots_good: 89, counter_strafing_shots_good_ratio: 0.7417,
      flashbang_hit_foe: 6, flashbang_leading_to_kill: 2, flashbang_hit_foe_avg_duration: 2.84, flashbang_hit_friend: 2, flashbang_thrown: 9,
      flash_assist: 1, score: 2 * s.kills + 8, initial_team_number: 3, spray_accuracy: 0.341, total_kills: s.kills, total_deaths: s.deaths,
      kd_ratio: s.deaths ? Math.round((s.kills / s.deaths) * 100) / 100 : s.kills, rounds_survived: rounds - s.deaths,
      rounds_survived_percentage: rounds ? (rounds - s.deaths) / rounds : 0, dpr: 61.8 + 2 * (s.kills - s.deaths), total_assists: 5,
      total_damage: Math.round((61.8 + 2 * (s.kills - s.deaths)) * rounds), leetify_rating: s.rating, ct_leetify_rating: s.rating + 0.011,
      t_leetify_rating: s.rating - 0.009, multi1k: 6, multi2k: 3, multi3k: 1, multi4k: 0, multi5k: 0, rounds_count: rounds, rounds_won: s.won,
      rounds_lost: s.lost, total_hs_kills: Math.round(s.kills * 0.35), trade_kill_opportunities: 7, trade_kill_attempts: 4, trade_kills_succeed: 2,
      trade_kill_attempts_percentage: 0.5714, trade_kills_success_percentage: 0.5, trade_kill_opportunities_per_round: 7 / rounds,
      traded_death_opportunities: 8, traded_death_attempts: 5, traded_deaths_succeed: 3, traded_death_attempts_percentage: 0.625,
      traded_deaths_success_percentage: 0.6, traded_deaths_opportunities_per_round: 8 / rounds,
    }],
  };
}

const uuid = (n: number) => `5e7a1c00-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A share code for a made-up Valve match id. */
export const syntheticCode = (n: number) => encodeShareCode({ matchId: 3_900_000_000_000_000_000n + BigInt(n), reservationId: 3_900_000_000_000_500_000n + BigInt(n), tvPort: 27000 + n });

/**
 * The stand-in history: matches on several maps and sources. The bundled samples are no Valve demos, so
 * none of these joins one (join.ts joins by Valve match id only); all list as Leetify-only rows, as they
 * would for a Leetify user without demos here. The first shares the Dust II sample's map, score and end
 * time, which join.test.ts uses to check that a close fit alone does not join.
 */
export const SYNTHETIC_MATCHES: SyntheticMatch[] = [
  { id: uuid(1), finished: "2026-10-25T00:41:10.000Z", map: "de_dust2", sourceId: syntheticCode(1), won: 13, lost: 8, kills: 15, deaths: 14, rating: 0.0412 },
  { id: uuid(2), finished: "2026-10-23T20:12:00.000Z", map: "de_mirage", sourceId: syntheticCode(2), won: 9, lost: 13, kills: 17, deaths: 19, rating: -0.0231 },
  { id: uuid(3), finished: "2026-10-23T19:20:00.000Z", map: "de_inferno", sourceId: syntheticCode(3), won: 13, lost: 11, kills: 22, deaths: 18, rating: 0.0587 },
  { id: uuid(4), finished: "2026-10-21T21:47:00.000Z", map: "de_ancient", sourceId: syntheticCode(4), won: 13, lost: 6, kills: 19, deaths: 11, rating: 0.0934 },
  { id: uuid(5), finished: "2026-10-19T18:05:00.000Z", map: "de_nuke", source: "faceit", sourceId: "1-5e7a1c00-0000-4000-8000-000000000005", won: 10, lost: 13, kills: 14, deaths: 20, rating: -0.0518 },
  { id: uuid(6), finished: "2026-10-18T22:30:00.000Z", map: "de_anubis", sourceId: syntheticCode(6), won: 13, lost: 10, kills: 18, deaths: 16, rating: 0.0105 },
];

export function syntheticPayload(fetchedAt: number, matches: SyntheticMatch[] = SYNTHETIC_MATCHES): LeetifyPayload {
  return { player: { kind: "steam", id: SYNTHETIC_STEAM64 }, fetchedAt, profile: syntheticProfile(), matches: matches.map(syntheticMatch) };
}

/** The dev stand-in bridge: in memory, no requests, synthetic data. A key is accepted and dropped. `connected` false starts at the connect form. */
export function syntheticBridge(connected = true): LeetifyBridge {
  let player: LeetifyPlayer | null = connected ? { kind: "steam", id: SYNTHETIC_STEAM64 } : null;
  // whether a key was "saved": the key itself is dropped
  let hasKey = false;
  const fetchedAt = Date.now();
  const status = (): LeetifyStatus => ({ player, hasKey, keyStore: true, keyError: null, cooldownS: null, synthetic: true });
  return {
    status: async () => status(),
    saveKey: async () => { hasKey = true; },
    clearKey: async () => { hasKey = false; },
    connect: async () => (player = { kind: "steam", id: SYNTHETIC_STEAM64 }),
    disconnect: async () => { player = null; },
    load: async () => (player ? syntheticPayload(fetchedAt) : null),
    discard: async () => {},
    // the dev build has no host to fetch the badge, so the views show the text attribution
    badge: async () => null,
  };
}
