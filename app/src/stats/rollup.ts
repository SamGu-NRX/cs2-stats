// rollup(facts[], filter) -> Summary: sums one player's facts over the matches and rounds a filter
// keeps. Every measure is additive, so any slice (side, buy class, map, period, opponent, weapon) is
// the same sum over fewer rows, and every ratio is computed from the totals.
import type { BuyClass } from "./economy";
import { emptyMeasures, MEASURES, type MatchFacts, type Measures, type PlayerRound, type WeaponFact } from "./facts";
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
  /** weapon class names; applies to the per-weapon rows only */
  weapons?: string[];
}

export type WeaponTotals = Omit<WeaponFact, "ri" | "pi" | "weapon"> & { rounds: number };

export interface Summary {
  /** matches with at least one kept round */
  matches: number;
  m: Measures;
  /** by weapon class name */
  weapons: Record<string, WeaponTotals>;
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

export const emptySummary = (): Summary => ({ matches: 0, m: emptyMeasures(), weapons: {} });

/** a += b, in place. */
export function addSummary(a: Summary, b: Summary): Summary {
  a.matches += b.matches;
  for (const k of MEASURES) a.m[k] += b.m[k];
  for (const [w, x] of Object.entries(b.weapons)) {
    const y = (a.weapons[w] ??= { rounds: 0, shots: 0, hits: 0, headHits: 0, dmg: 0, kills: 0, hsKills: 0, deaths: 0 });
    for (const k of Object.keys(x) as (keyof WeaponTotals)[]) y[k] += x[k];
  }
  return a;
}

export function rollup(facts: MatchFacts[], filter: Filter): Summary {
  const s = emptySummary();
  for (const f of facts) {
    const rows = keptRounds(f, filter);
    if (!rows.length) continue;
    s.matches++;
    const kept = new Set(rows.map((r) => r.ri * 1024 + r.pi));
    for (const r of rows) for (const k of MEASURES) s.m[k] += r.m[k];
    const roundsWith = new Map<string, Set<number>>();
    for (const w of f.weapons) {
      if (!kept.has(w.ri * 1024 + w.pi) || (filter.weapons && !filter.weapons.includes(w.weapon))) continue;
      const y = (s.weapons[w.weapon] ??= { rounds: 0, shots: 0, hits: 0, headHits: 0, dmg: 0, kills: 0, hsKills: 0, deaths: 0 });
      y.shots += w.shots; y.hits += w.hits; y.headHits += w.headHits; y.dmg += w.dmg; y.kills += w.kills; y.hsKills += w.hsKills; y.deaths += w.deaths;
      let r = roundsWith.get(w.weapon);
      if (!r) roundsWith.set(w.weapon, (r = new Set()));
      r.add(w.ri);
    }
    for (const [w, r] of roundsWith) s.weapons[w].rounds += r.size;
  }
  return s;
}
