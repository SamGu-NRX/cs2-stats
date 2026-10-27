// Trends and correlations across a player's matches: one value per match for any metric, a least-
// squares slope over match order, and Pearson correlations between metrics or with winning.
import type { MatchFacts } from "./facts";
import { METRIC } from "./metrics";
import { rollup, type Filter } from "./rollup";

export interface TrendPoint { match: string; date: string | null; value: number | null; won: boolean | null }

/**
 * Whether the player's team won the match: null for a tie, an unfinished match (MatchInfo.complete
 * false) or a player without a team, which a correlation with winning leaves out.
 */
export function matchWon(f: MatchFacts, ids: Set<string>): boolean | null {
  const me = f.players.find((p) => ids.has(p.id));
  if (!f.match.complete || !me || me.team === null) return null;
  const [us, them] = [f.match.score[me.team], f.match.score[1 - me.team]];
  return us === them ? null : us > them;
}

/**
 * One match's value of each metric under a filter; null when the filter keeps none of its rounds (no
 * value, as opposed to a metric whose value is null over rounds it does keep). The worker's
 * winCorrelation and matchValues calls read matches through this one rule.
 */
export function matchValues(f: MatchFacts, filter: Filter, metricIds: string[]): Record<string, number | null> | null {
  const ms = metricIds.map((id) => {
    const m = METRIC[id];
    if (!m) throw new Error(`trends: unknown metric "${id}"`);
    return m;
  });
  const s = rollup([f], filter);
  return s.m.rounds ? Object.fromEntries(ms.map((m) => [m.id, m.value(s)])) : null;
}

/** The metric per match, in date order (matches without a date keep their input order at the end). */
export function series(facts: MatchFacts[], filter: Filter, metricId: string): TrendPoint[] {
  const ids = new Set(Array.isArray(filter.player) ? filter.player : [filter.player]);
  const sorted = [...facts].sort((a, b) => (a.match.date ?? "9999").localeCompare(b.match.date ?? "9999"));
  return sorted.flatMap((f) => {
    const v = matchValues(f, filter, [metricId]);
    return v ? [{ match: f.match.id, date: f.match.date, value: v[metricId], won: matchWon(f, ids) }] : [];
  });
}

/** Least-squares slope per match and Pearson r against match order; null with fewer than 3 values. */
export function trend(points: TrendPoint[]): { slope: number; r: number; n: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  points.forEach((p, i) => { if (p.value !== null) { xs.push(i); ys.push(p.value); } });
  if (xs.length < 3) return null;
  return { slope: slope(xs, ys), r: pearson(xs, ys), n: xs.length };
}

/** Pearson r between two metrics over the matches where both have a value; null with fewer than 3. */
export function correlation(facts: MatchFacts[], filter: Filter, a: string, b: string): { r: number; n: number } | null {
  const sa = series(facts, filter, a);
  const sb = series(facts, filter, b);
  const pairs = sa.map((p, i) => [p.value, sb[i].value]).filter((x): x is [number, number] => x[0] !== null && x[1] !== null);
  return pairs.length < 3 ? null : { r: pearson(pairs.map((x) => x[0]), pairs.map((x) => x[1])), n: pairs.length };
}

/** Pearson r between a metric and winning the match (point-biserial); null with fewer than 3 decided matches. */
export function winCorrelation(facts: MatchFacts[], filter: Filter, metricId: string): { r: number; n: number } | null {
  return winCorrelationOf(series(facts, filter, metricId));
}

/** The same from per-match points, for a caller that streams matches. */
export function winCorrelationOf(points: { value: number | null; won: boolean | null }[]): { r: number; n: number } | null {
  const pts = points.filter((p) => p.value !== null && p.won !== null);
  return pts.length < 3 ? null : { r: pearson(pts.map((p) => p.value!), pts.map((p) => (p.won ? 1 : 0))), n: pts.length };
}

function slope(x: number[], y: number[]): number {
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let num = 0, den = 0;
  x.forEach((v, i) => { num += (v - mx) * (y[i] - my); den += (v - mx) ** 2; });
  return den ? num / den : 0;
}

export function pearson(x: number[], y: number[]): number {
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let num = 0, dx = 0, dy = 0;
  x.forEach((v, i) => { num += (v - mx) * (y[i] - my); dx += (v - mx) ** 2; dy += (y[i] - my) ** 2; });
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}
