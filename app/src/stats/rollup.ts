// rollup(facts[], filter) -> Summary: sums one player's facts over the matches and rounds a filter
// keeps. Every measure is additive, so any slice (side, buy class, map, period, opponent, weapon) is
// the same sum over fewer rows, and every ratio is computed from the totals.
import { emptyAggro, foldAggro, type AggroAgg } from "./aggression";
import { emptyAim, foldAim, type AimAgg } from "./aim";
import type { BuyClass } from "./economy";
import { emptyInfo, foldInfo, type InfoAgg } from "./information";
import { emptyMove, foldMove, type MoveAgg } from "./movement";
import { emptyUtilQ, foldUtilQ, type UtilQAgg } from "./utilq";
import { emptyMeasures, HIT_GROUPS, MEASURES, type GrenadeFact, type MatchFacts, type Measures, type PlayerRound, type WeaponFact } from "./facts";
import { foldPresence, type Presence } from "./positions";
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
  /** round numbers (RoundFact.number); for one match, such as a round drawer */
  rounds?: number[];
}

/** A weapon's sums; rounds counts the rounds it was used in (a shot, hit or kill). */
export type WeaponTotals = Omit<WeaponFact, "ri" | "pi" | "weapon"> & { rounds: number };

export interface Summary {
  /** matches with at least one kept round */
  matches: number;
  /** over the kept matches: the rounds the facts cover and the rounds played (Rating 3.0's coverage gate) */
  covered: { nRounds: number; roundsPlayed: number };
  /** the distinct model fingerprints the kept matches were derived with */
  models: string[];
  m: Measures;
  /** m split by the side each kept round was played on: Rating 3.0 rates each side over its own rounds (rating3.ts rating3Of) */
  sides: Record<Side, Measures>;
  /** by weapon class name */
  weapons: Record<string, WeaponTotals>;
  aim: AimAgg;
  movement: MoveAgg;
  aggression: AggroAgg;
  information: InfoAgg;
  utilq: UtilQAgg;
  /**
   * by map name: where the player spent their time alive. Presence is kept per player and side, so it
   * honours the player, side and match filters only; under a round-level filter (ownBuy, oppBuy,
   * spawns, weapons, rounds) it stays empty rather than show the whole match.
   */
  presence: Record<string, Presence>;
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
    if (filter.rounds && !filter.rounds.includes(f.rounds[r.ri].number)) return false;
    return true;
  });
}

export const emptySummary = (): Summary => ({
  matches: 0, covered: { nRounds: 0, roundsPlayed: 0 }, models: [], m: emptyMeasures(), sides: { CT: emptyMeasures(), T: emptyMeasures() }, weapons: {}, aim: emptyAim(), movement: emptyMove(), aggression: emptyAggro(), information: emptyInfo(), utilq: emptyUtilQ(), presence: {},
});

/** Event facts whose weapon the filter rejects are dropped; facts without a weapon field always pass. */
const weaponOk = (filter: Filter, f: object) => !filter.weapons || !("weapon" in f) || (f.weapon !== null && filter.weapons.includes(f.weapon as string));

export function rollup(facts: Iterable<MatchFacts>, filter: Filter): Summary {
  const s = emptySummary();
  for (const f of facts) addMatch(s, f, filter);
  return s;
}

/** Adds one match's kept rows to s: rollup one match at a time, so a caller need not hold every match's facts. */
export function addMatch(s: Summary, f: MatchFacts, filter: Filter): void {
  const rows = keptRounds(f, filter);
  if (!rows.length) return;
  s.matches++;
  s.covered.nRounds += f.match.nRounds;
  s.covered.roundsPlayed += f.match.roundsPlayed;
  if (!s.models.includes(f.match.model)) s.models.push(f.match.model);
  const kept = new Set(rows.map((r) => r.ri * 1024 + r.pi));
  for (const r of rows) {
    const side = s.sides[r.side];
    for (const k of MEASURES) { const v = r.m[k] ?? 0; s.m[k] += v; side[k] += v; }
  }
  const roundsWith = new Map<string, Set<number>>();
  for (const w of f.weapons) {
    if (!kept.has(w.ri * 1024 + w.pi) || (filter.weapons && !filter.weapons.includes(w.weapon))) continue;
    const y = (s.weapons[w.weapon] ??= { rounds: 0, shots: 0, hits: 0, groups: HIT_GROUPS.map(() => 0), dmg: 0, kills: 0, hsKills: 0, deaths: 0 });
    w.groups.forEach((n, g) => { y.groups[g] += n; });
    y.shots += w.shots; y.hits += w.hits; y.dmg += w.dmg; y.kills += w.kills; y.hsKills += w.hsKills; y.deaths += w.deaths;
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
  if (!(filter.ownBuy || filter.oppBuy || filter.spawns || filter.weapons || filter.rounds)) {
    const ids = new Set(Array.isArray(filter.player) ? filter.player : [filter.player]);
    for (const x of f.presence) {
      if (ids.has(f.players[x.pi].id) && (!filter.sides || filter.sides.includes(x.side))) foldPresence((s.presence[f.match.map] ??= { cells: {}, places: {} }), x);
    }
  }
}

/** The grenades a filter keeps, with their match's map: the landing map's points. */
export function grenadesOf(facts: MatchFacts[], filter: Filter): { map: string; g: GrenadeFact }[] {
  const out: { map: string; g: GrenadeFact }[] = [];
  for (const f of facts) {
    const kept = new Set(keptRounds(f, filter).map((r) => r.ri * 1024 + r.pi));
    for (const g of f.grenades) if (kept.has(g.ri * 1024 + g.pi) && weaponOk(filter, g)) out.push({ map: f.match.map, g });
  }
  return out;
}
