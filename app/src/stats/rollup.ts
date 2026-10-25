// rollup(facts[], filter) -> Summary: sums one player's facts over the matches and rounds a filter
// keeps. Every measure is additive, so any slice (side, buy class, map, period, opponent, weapon) is
// the same sum over fewer rows, and every ratio is computed from the totals.
import { emptyAggro, foldAggro, type AggroAgg } from "./aggression";
import { emptyAim, foldAim, type AimAgg } from "./aim";
import type { BuyClass } from "./economy";
import { emptyInfo, foldInfo, type InfoAgg } from "./information";
import { emptyMove, foldMove, type MoveAgg } from "./movement";
import { emptyUtilQ, foldUtilQ, type UtilQAgg } from "./utilq";
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
  /** weapon class names; applies to the per-weapon rows and to event facts with a weapon */
  weapons?: string[];
  /** spawn points (PlayerRound.spawn) */
  spawns?: string[];
}

/** A weapon's sums; rounds counts the rounds it was used in (a shot, hit or kill). */
export type WeaponTotals = Omit<WeaponFact, "ri" | "pi" | "weapon"> & { rounds: number };

export interface Summary {
  /** matches with at least one kept round */
  matches: number;
  m: Measures;
  /** by weapon class name */
  weapons: Record<string, WeaponTotals>;
  aim: AimAgg;
  movement: MoveAgg;
  aggression: AggroAgg;
  information: InfoAgg;
  utilq: UtilQAgg;
}

/** The player-round rows a filter keeps in one match, for families that sum their own facts. */
function keptRounds(f: MatchFacts, filter: Filter): PlayerRound[] {
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
    if (filter.spawns && (!r.spawn || !filter.spawns.includes(r.spawn))) return false;
    return true;
  });
}

const emptySummary = (): Summary => ({
  matches: 0, m: emptyMeasures(), weapons: {}, aim: emptyAim(), movement: emptyMove(), aggression: emptyAggro(), information: emptyInfo(), utilq: emptyUtilQ(),
});

/** Event facts whose weapon the filter rejects are dropped; facts without a weapon field always pass. */
const weaponOk = (filter: Filter, f: object) => !filter.weapons || !("weapon" in f) || (f.weapon !== null && filter.weapons.includes(f.weapon as string));

export function rollup(facts: MatchFacts[], filter: Filter): Summary {
  const s = emptySummary();
  for (const f of facts) {
    const rows = keptRounds(f, filter);
    if (!rows.length) continue;
    s.matches++;
    const kept = new Set(rows.map((r) => r.ri * 1024 + r.pi));
    for (const r of rows) for (const k of MEASURES) s.m[k] += r.m[k] ?? 0;
    const roundsWith = new Map<string, Set<number>>();
    for (const w of f.weapons) {
      if (!kept.has(w.ri * 1024 + w.pi) || (filter.weapons && !filter.weapons.includes(w.weapon))) continue;
      const y = (s.weapons[w.weapon] ??= { rounds: 0, shots: 0, hits: 0, headHits: 0, dmg: 0, kills: 0, hsKills: 0, deaths: 0 });
      y.shots += w.shots; y.hits += w.hits; y.headHits += w.headHits; y.dmg += w.dmg; y.kills += w.kills; y.hsKills += w.hsKills; y.deaths += w.deaths;
      if (!w.shots && !w.hits && !w.kills) continue;
      let r = roundsWith.get(w.weapon);
      if (!r) roundsWith.set(w.weapon, (r = new Set()));
      r.add(w.ri);
    }
    for (const [w, r] of roundsWith) s.weapons[w].rounds += r.size;
    const keep = <F extends { ri: number; pi: number }>(xs: F[], fold: (x: F) => void) => {
      for (const x of xs) if (kept.has(x.ri * 1024 + x.pi) && weaponOk(filter, x)) fold(x);
    };
    keep(f.aim, (x) => foldAim(s.aim, x));
    keep(f.movement, (x) => foldMove(s.movement, x));
    keep(f.aggression, (x) => foldAggro(s.aggression, x));
    keep(f.information, (x) => foldInfo(s.information, x));
    keep(f.utilq, (x) => foldUtilQ(s.utilq, x));
  }
  return s;
}
