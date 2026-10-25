// rollup(facts[], filter) -> Summary: sums one player's facts over the matches and rounds a filter
// keeps. Every measure is additive, so any slice (side, buy class, map, period, opponent) is the same
// sum over fewer rows, and every ratio is computed from the totals.
import type { BuyClass } from "./economy";
import { emptyMeasures, MEASURES, type MatchFacts, type Measures, type PlayerRound } from "./facts";
import type { Side } from "./tables";

export interface Filter {
  /** steamid(s) of the player; required */
  player: string | string[];
  sides?: Side[];
  /** the player's team's buy class */
  ownBuy?: BuyClass[];
  /** the opponents' buy class */
  oppBuy?: BuyClass[];
  maps?: string[];
  /** inclusive YYYY-MM-DD bounds */
  from?: string;
  to?: string;
  /** opponent team names */
  opponents?: string[];
}

export interface Summary extends Measures {
  matches: number;
}

/** The player-round rows a filter keeps in one match, for families that sum their own facts. */
export function keptRounds(f: MatchFacts, filter: Filter): PlayerRound[] {
  const ids = new Set(Array.isArray(filter.player) ? filter.player : [filter.player]);
  if (filter.maps && !filter.maps.includes(f.match.map)) return [];
  if (filter.from && (!f.match.date || f.match.date < filter.from)) return [];
  if (filter.to && (!f.match.date || f.match.date > filter.to)) return [];
  return f.pr.filter((r) => {
    if (!ids.has(f.players[r.pi].id)) return false;
    if (filter.sides && !filter.sides.includes(r.side)) return false;
    if (filter.ownBuy && (!r.ownBuy || !filter.ownBuy.includes(r.ownBuy))) return false;
    if (filter.oppBuy && (!r.oppBuy || !filter.oppBuy.includes(r.oppBuy))) return false;
    if (filter.opponents && !filter.opponents.includes(f.match.teams[1 - r.team])) return false;
    return true;
  });
}

export function rollup(facts: MatchFacts[], filter: Filter): Summary {
  const s: Summary = { ...emptyMeasures(), matches: 0 };
  for (const f of facts) {
    const rows = keptRounds(f, filter);
    if (rows.length) s.matches++;
    for (const r of rows) for (const k of MEASURES) s[k] += r[k];
  }
  return s;
}
