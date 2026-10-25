// Trends and correlations across a player's matches: one value per match for any metric, a least-
// squares slope over match order, and Pearson correlations between metrics or with winning.
import type { MatchFacts } from "./facts";
import { METRIC } from "./metrics";
import { rollup, type Filter } from "./rollup";

export interface TrendPoint { match: string; date: string | null; value: number | null; won: boolean | null }

/** The metric per match, in date order (matches without a date keep their input order at the end). */
export function series(facts: MatchFacts[], filter: Filter, metricId: string): TrendPoint[] {
  const m = METRIC[metricId];
  if (!m) throw new Error(`trends: unknown metric "${metricId}"`);
  const ids = new Set(Array.isArray(filter.player) ? filter.player : [filter.player]);
  const sorted = [...facts].sort((a, b) => (a.match.date ?? "9999").localeCompare(b.match.date ?? "9999"));
  return sorted.flatMap((f) => {
    const s = rollup([f], filter);
    if (!s.m.rounds) return [];
    const me = f.players.find((p) => ids.has(p.id));
    const won = me?.team === null || me === undefined ? null : f.match.score[me.team] > f.match.score[1 - me.team];
    return [{ match: f.match.id, date: f.match.date, value: m.value(s), won }];
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
  const pts = series(facts, filter, metricId).filter((p) => p.value !== null && p.won !== null);
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
