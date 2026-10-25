// The human's profile across matches, built from cached MatchSummary records only (no match file
// is decoded). Every number is a sum of counters, so 1,000 matches cost one pass of additions.
import { emptyAim, mergeAim, type AimAgg } from "./aim";
import { scoreAttributes, type Attributes } from "./attributes";
import { addCounters, emptyCounters, type Counters } from "./counters";
import type { MatchSummary } from "./derive";
import { rating2 } from "./rating";
import { rating3, type Rating3 } from "./rating3";

export interface FormPoint { file: string; startUtc: string; map: string; rating: number; rating3: number | null; result: "W" | "L" | "T"; score: { us: number; them: number } }

export interface ProfileView {
  name: string;
  matches: number;
  wins: number;
  losses: number;
  total: Counters;
  rating: number;
  /** Rating 3.0 (approx.) over every round with the kill log */
  rating3: Rating3;
  attributes: Attributes;
  maps: { map: string; matches: number; wins: number; c: Counters; rating: number }[];
  /** last 20 matches, oldest first */
  form: FormPoint[];
  aim: AimAgg | null;
  aimMatches: number;
  /** maps with position data, for the "where you play" picker */
  posMaps: string[];
}

export interface ProfileFilter { map?: string | null; lastN?: number | null }

export function buildProfile(all: Omit<MatchSummary, "pos">[], filter: ProfileFilter = {}): ProfileView | null {
  let list = [...all].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  if (filter.map) list = list.filter((s) => s.map === filter.map);
  if (filter.lastN) list = list.slice(-filter.lastN);
  if (!list.length) return null;

  const total = emptyCounters();
  const careers = new Map<string, Counters>();
  const maps = new Map<string, { matches: number; wins: number; c: Counters }>();
  let aim: AimAgg | null = null;
  let aimMatches = 0;
  let wins = 0;
  let losses = 0;
  const posMaps = new Set<string>();
  for (const s of list) {
    addCounters(total, s.human.c);
    if (s.result === "W") wins++;
    if (s.result === "L") losses++;
    const mp = maps.get(s.map) ?? { matches: 0, wins: 0, c: emptyCounters() };
    mp.matches++;
    if (s.result === "W") mp.wins++;
    addCounters(mp.c, s.human.c);
    maps.set(s.map, mp);
    for (const b of s.bots) {
      let c = careers.get(b.key);
      if (!c) careers.set(b.key, (c = emptyCounters()));
      addCounters(c, b.c);
    }
    if (s.aim) {
      aim = mergeAim(aim ?? emptyAim(), s.aim); // reads s.aim, writes only the accumulator
      aimMatches++;
    }
    if (s.hasPos) posMaps.add(s.map);
  }
  const last = list[list.length - 1];
  return {
    name: last.human.name,
    matches: list.length, wins, losses, total, rating: rating2(total), rating3: rating3(total.r3),
    attributes: scoreAttributes(total, [...careers.values()]),
    maps: [...maps].map(([map, x]) => ({ map, ...x, rating: rating2(x.c) })).sort((a, b) => b.matches - a.matches),
    form: list.slice(-20).map((s) => ({ file: s.file, startUtc: s.startUtc, map: s.map, rating: s.human.rating, rating3: s.human.rating3 ?? null, result: s.result, score: s.score })),
    aim, aimMatches, posMaps: [...posMaps],
  };
}
