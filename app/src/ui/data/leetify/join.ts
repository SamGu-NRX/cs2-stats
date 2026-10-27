// Which Leetify match is which local match: only by Valve match id. A matchmaking match's share code
// (data_source_match_id) holds Valve's match id, and a Valve match's file path holds the same id
// (sharecode.ts), so a pair is either the same match or not. There is no fallback on time, map and score:
// a guess can attach the wrong match, which would put one match's numbers beside another's. A Leetify
// match with no demo here stays a Leetify-only row in Matches.
//
// Only a demo recorded by the Leetify profile's own player (MatchInfo.pov equal to the profile's SteamID)
// joins, so another account's recording never sits beside these numbers. Pro demos never join.
import type { MatchEntry } from "../match";
import { isOwn } from "../engine";
import type { LeetifyMatch } from "./api";
import { decodeShareCode, valveMatchId } from "./sharecode";

export type JoinRule = "match-id";

export interface Joined {
  /** local file to its Leetify match */
  byFile: Map<string, { match: LeetifyMatch; rule: JoinRule }>;
  /** Leetify matches with no local match: the rows Matches lists from Leetify alone */
  only: LeetifyMatch[];
}

/**
 * Joins `leetify`, the match history of the Leetify player whose SteamID64 is `steam64`, to the local
 * matches that player recorded. `steam64` is the profile's real id, read before privacy.ts masks it.
 */
export function joinMatches(leetify: LeetifyMatch[], entries: MatchEntry[], steam64: string): Joined {
  const byFile: Joined["byFile"] = new Map();
  const joined = new Set<string>();
  const byValveId = new Map<bigint, MatchEntry>();
  for (const e of entries) {
    if (!isOwn(e) || e.match.pov !== steam64) continue;
    const id = valveMatchId(e.file);
    if (id !== null) byValveId.set(id, e);
  }
  for (const l of leetify) {
    const id = l.dataSourceMatchId ? decodeShareCode(l.dataSourceMatchId)?.matchId ?? null : null;
    const e = id !== null ? byValveId.get(id) : undefined;
    if (e && !byFile.has(e.file)) {
      byFile.set(e.file, { match: l, rule: "match-id" });
      joined.add(l.id);
    }
  }
  return { byFile, only: leetify.filter((l) => !joined.has(l.id)) };
}
