// The worker calls whose answers name the file they came from: personal bests, sessions, clutches,
// multi-kill rounds, highlights and clip moments. Each match is visited together with its own file, so two files
// holding one match id (two exports of the same match) keep their own answers rather than both
// pointing at whichever file was seen last.
import { addBests, awardsOf, groupSessions, SESSION_GAP_H, type Best } from "../stats/career";
import type { MatchFacts } from "../stats/facts";
import { rating3Of } from "../stats/rating3";
import { rollup, type Summary } from "../stats/rollup";
import { matchWon } from "../stats/trends";
import { startMs } from "../ui/data/match";
import type { ClutchRow, HighlightRow, MomentRow, MultiKillRow, Query, Session } from "./protocol";
import { addClutchRows, addHighlightRows, addMomentRows, addMultiKillRows, bestMomentRowFirst, newestHighlightFirst } from "./views";

/** Visits each of `files` once with its facts and its file name (the worker's stream). */
export type EachMatch = (files: string[], visit: (f: MatchFacts, file: string) => void) => Promise<void>;

const ids = (player: string | string[]) => new Set(Array.isArray(player) ? player : [player]);

export function matchCalls(each: EachMatch, summary: (q: Query) => Promise<Summary>) {
  return {
    async personalBests(q: Query): Promise<Best[]> {
      const acc: Record<string, Best> = {};
      await each(q.files, (f, file) => addBests(acc, file, rollup([f], q.filter)));
      return Object.values(acc);
    },
    async sessions(q: Query, gapHours = SESSION_GAP_H): Promise<Session[]> {
      const me = ids(q.filter.player);
      const spans = new Map<string, { start: number; end: number }>();
      const rows = new Map<string, { file: string; rating: number | null; kills: number; won: boolean | null }>();
      await each(q.files, (f, file) => {
        // a match the filter keeps none of the player's rounds in (another map, outside the dates, a
        // match without the player) is not part of any session, and does not bridge two of them
        const s = rollup([f], q.filter);
        if (!s.m.rounds) return;
        const start = startMs(f.match);
        spans.set(file, { start, end: start + 1000 * (f.match.durationS ?? 0) });
        rows.set(file, { file, rating: rating3Of(s).value, kills: s.m.kills, won: matchWon(f, me) });
      });
      const groups = groupSessions([...spans].map(([file, x]) => ({ file, ...x })), gapHours);
      return Promise.all(groups.map(async (files) => {
        const s = await summary({ files, filter: q.filter });
        const of = files.map((file) => rows.get(file)!);
        return {
          files, start: Math.min(...files.map((x) => spans.get(x)!.start)), end: Math.max(...files.map((x) => spans.get(x)!.end)),
          wins: of.filter((r) => r.won === true).length, losses: of.filter((r) => r.won === false).length, ties: of.filter((r) => r.won === null).length,
          rounds: s.m.rounds, kills: s.m.kills, deaths: s.m.deaths, rating: rating3Of(s).value, awards: awardsOf(of),
        };
      }));
    },
    async clutches(q: Query): Promise<ClutchRow[]> {
      const out: ClutchRow[] = [];
      await each(q.files, (f, file) => addClutchRows(out, file, f, q.filter));
      return out;
    },
    async multiKills(q: Query): Promise<MultiKillRow[]> {
      const out: MultiKillRow[] = [];
      await each(q.files, (f, file) => addMultiKillRows(out, file, f, q.filter));
      return out;
    },
    async highlights(q: Query): Promise<HighlightRow[]> {
      const out: HighlightRow[] = [];
      await each(q.files, (f, file) => addHighlightRows(out, file, f, q.filter));
      return out.sort(newestHighlightFirst);
    },
    async moments(q: Query): Promise<MomentRow[]> {
      const out: MomentRow[] = [];
      await each(q.files, (f, file) => addMomentRows(out, file, f, q.filter));
      return out.sort(bestMomentRowFirst);
    },
  };
}
