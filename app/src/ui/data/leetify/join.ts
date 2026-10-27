// Which Leetify match is which local match. Two rules, in order:
// 1. Match id. A matchmaking match's share code (data_source_match_id) holds Valve's match id, and a Valve
//    match's file path holds the same id (sharecode.ts). Exact, so it wins.
// 2. Time, map and score, for a match the first rule left: the local match ended (its start plus its
//    duration) within END_SLACK_MS of Leetify's finished_at, on the same map, with the same rounds won and
//    lost. Only one-to-one pairs join; a Leetify match with two candidates, or a local match two Leetify
//    matches point at, stays apart, since a wrong join would put one match's numbers beside another's.
// A local match needs a clock time (MatchInfo.startedAt) for rule 2: a date alone could be any match that
// day. Pro demos never join; they are not the user's matches.
import type { MatchEntry } from "../match";
import { startMs } from "../match";
import { isOwn } from "../engine";
import type { LeetifyMatch } from "./api";
import { decodeShareCode, valveMatchId } from "./sharecode";

/**
 * How far apart the local end and Leetify's finished_at may be. Leetify's finished_at for the matches
 * seen is the server's end time and our end is start plus the rounds' duration, which leaves out the
 * warmup and the final scoreboard. 10 minutes is a guess that covers that gap; there is no measured spread
 * behind it. Two matches on one map with one score ending inside it would claim each other's partner, and
 * the one-to-one rule leaves all of them apart.
 */
export const END_SLACK_MS = 10 * 60 * 1000;
/** Without a recorded duration, the local start must fall this long before Leetify's end at most (a long overtime match). */
const LONGEST_MATCH_MS = 3 * 60 * 60 * 1000;

export type JoinRule = "match-id" | "time";

export interface Joined {
  /** local file to its Leetify match */
  byFile: Map<string, { match: LeetifyMatch; rule: JoinRule }>;
  /** Leetify matches with no local match: the rows Matches lists from Leetify alone */
  only: LeetifyMatch[];
}

const sameScore = (l: LeetifyMatch, e: MatchEntry) => l.score !== null && l.score.us === e.score.us && l.score.them === e.score.them;
const sameMap = (l: LeetifyMatch, e: MatchEntry) => l.map.toLowerCase() === e.match.map.toLowerCase();

/** Whether a local match's timing fits a Leetify match's end. */
function fitsTime(l: LeetifyMatch, e: MatchEntry): boolean {
  if (!e.match.startedAt) return false;
  const start = startMs(e.match);
  if (e.match.durationS !== null) return Math.abs(start + e.match.durationS * 1000 - l.finishedMs) <= END_SLACK_MS;
  return start <= l.finishedMs && l.finishedMs - start <= LONGEST_MATCH_MS;
}

export function joinMatches(leetify: LeetifyMatch[], entries: MatchEntry[]): Joined {
  const byFile: Joined["byFile"] = new Map();
  const joined = new Set<string>();
  const own = entries.filter(isOwn);

  // 1. match id
  const byValveId = new Map<bigint, MatchEntry>();
  for (const e of own) {
    const id = valveMatchId(e.file);
    if (id !== null) byValveId.set(id, e);
  }
  const left: LeetifyMatch[] = [];
  for (const l of leetify) {
    const code = l.dataSourceMatchId ? decodeShareCode(l.dataSourceMatchId) : null;
    const e = code ? byValveId.get(code.matchId) : undefined;
    if (e && !byFile.has(e.file)) {
      byFile.set(e.file, { match: l, rule: "match-id" });
      joined.add(l.id);
    } else left.push(l);
  }

  // 2. time, map and score, one-to-one
  const free = own.filter((e) => !byFile.has(e.file));
  const candidates = new Map(left.map((l) => [l.id, free.filter((e) => sameMap(l, e) && sameScore(l, e) && fitsTime(l, e))]));
  const claims = new Map<string, number>();
  for (const list of candidates.values()) for (const e of list) claims.set(e.file, (claims.get(e.file) ?? 0) + 1);
  for (const l of left) {
    const list = candidates.get(l.id)!;
    if (list.length === 1 && claims.get(list[0].file) === 1) {
      byFile.set(list[0].file, { match: l, rule: "time" });
      joined.add(l.id);
    }
  }
  return { byFile, only: leetify.filter((l) => !joined.has(l.id)) };
}
