// The pro library as Matches' Pro view finds games in it. Every filter reads a field the published
// tables carry: the two team names (match.teams), the players' names, the map and the date. The
// tables carry no event name, so there is no event filter.
import { startMs, type MatchEntry } from "./match";
import { mapName } from "../lib/format";

export interface ProFilter {
  /** words that must each appear in a team name, a player's name or the map */
  q: string;
  /** a team name, exactly as the file has it */
  team: string | null;
  /** a player's name or part of one, in any case */
  player: string | null;
  /** a map, as match.map ("de_inferno") */
  map: string | null;
}

/** Each pro demo's words for the search box, lowercased once: teams, players and the map. */
const words = new WeakMap<MatchEntry, string>();
/** The players who played a round: a coach or spectator in the file is not one of the match's players. */
const playersOf = (e: MatchEntry) => e.players.filter((p) => e.played.includes(p.id));
const wordsOf = (e: MatchEntry) => {
  let w = words.get(e);
  if (w === undefined) {
    w = [...e.match.teams, ...playersOf(e).map((p) => p.name), mapName(e.match.map), e.match.map].join(" ").toLowerCase();
    words.set(e, w);
  }
  return w;
};

/** The pro demos a filter keeps, newest first. */
export function filterPro(list: MatchEntry[], f: ProFilter): MatchEntry[] {
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const player = f.player?.toLowerCase() ?? null;
  return list.filter((e) => (!f.team || e.match.teams.includes(f.team))
    && (!player || playersOf(e).some((p) => p.name.toLowerCase().includes(player)))
    && (!f.map || e.match.map === f.map)
    && (!terms.length || terms.every((t) => wordsOf(e).includes(t))))
    .sort((a, b) => startMs(b.match) - startMs(a.match) || b.file.localeCompare(a.file));
}

/**
 * The filters' choices over the whole library, each with how many maps it has: teams and players by
 * name, maps by count. `teamsOf` gives the team names a match may offer (none for a match whose names
 * are hidden, privacy.ts teamNames).
 */
export function proChoices(list: MatchEntry[], teamsOf: (e: MatchEntry) => readonly string[] = (e) => e.match.teams): { teams: [string, number][]; players: [string, number][]; maps: [string, number][] } {
  const teams = new Map<string, number>(), players = new Map<string, number>(), maps = new Map<string, number>();
  const add = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const e of list) {
    for (const t of new Set(teamsOf(e))) add(teams, t);
    for (const p of new Set(playersOf(e).map((x) => x.name))) add(players, p);
    add(maps, e.match.map);
  }
  const byName = (m: Map<string, number>) => [...m].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }));
  return { teams: byName(teams), players: byName(players), maps: [...maps].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}
