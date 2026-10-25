// compare(summary, baselines) -> percentiles. Baselines (tools/baselines.ts writes them) hold, for each
// pool of anonymous pro players and each side, 21 quantiles of every metric. A percentile is read by
// linear interpolation between quantiles.
//
// Pools: "all"; "rifler" and "awper" (design/identity.md: an AWPer has more than 0.20 AWP kills per
// round in the sample); "map:<name>", whose units are player-maps rather than players.
import { INPUT_COVERAGE } from "./facts";
import { ATTRIBUTES, METRICS, type Kind, type Metric } from "./metrics";
import type { Summary } from "./rollup";

export const QUANTILES = Array.from({ length: 21 }, (_, i) => i * 5);
export const AWPER_MIN_AWP_KPR = 0.2;

export type SideKey = "both" | "CT" | "T";

export interface Baselines {
  version: 1;
  built: string;
  /** what the pools were built from, for the UI's source line */
  source: string;
  /**
   * model-params.ts modelFingerprint of the facts the pools were built from ("mixed" when they differ).
   * A model-dependent metric is compared only with baselines of the same model.
   */
  model?: string;
  /** players (or player-maps) per pool and side */
  n: Record<string, Partial<Record<SideKey, number>>>;
  /** pool -> side -> metric id -> 21 quantiles (QUANTILES), or null when too few units had a value */
  pools: Record<string, Partial<Record<SideKey, Record<string, number[] | null>>>>;
}

/** Share of the pool below v, 0-100, from the stored quantiles. */
export function percentileOf(q: number[], v: number): number {
  // A value equal to one or more quantiles (common when many pros share a value, such as 0) sits in
  // the middle of that run.
  const first = q.indexOf(v);
  if (first >= 0) return (QUANTILES[first] + QUANTILES[q.lastIndexOf(v)]) / 2;
  if (v < q[0]) return 0;
  if (v > q[q.length - 1]) return 100;
  const i = q.findIndex((x) => x > v);
  return QUANTILES[i - 1] + ((v - q[i - 1]) / (q[i] - q[i - 1])) * (QUANTILES[i] - QUANTILES[i - 1]);
}

export const roleOf = (s: Summary): "awper" | "rifler" => (s.m.rounds > 0 && s.m.awpKills / s.m.rounds > AWPER_MIN_AWP_KPR ? "awper" : "rifler");

export interface CompareOptions {
  /** "role" (default): the player's role pool; "all": everyone */
  pool?: "role" | "all";
  side?: SideKey;
  /** compare with player-maps on this map instead */
  map?: string;
}

export interface Percentile {
  id: string;
  value: number | null;
  /** 0-100; for performance metrics with lowerIsBetter, flipped so higher is always better */
  pct: number | null;
  pool: string;
  /** why there is no percentile (an input the matches lack, another model, too small a sample), whether or not there is a value; null otherwise */
  reason: string | null;
  /** the count of the events the value rests on (Metric.sample), for the metrics that declare one; null otherwise */
  n: number | null;
}

/**
 * Why summary s cannot be compared with baselines b on metric m; null when it can. An input counts
 * only when it is known on every row the metric uses; otherwise the reason says how many were known,
 * which is also the coverage note for the value computed over the known rows. A metric with its own
 * rule for having no value (Metric.why) gives that rule's reason first.
 */
export function notComparable(m: Metric, s: Summary, b: Baselines): string | null {
  const gap = m.why?.(s) ?? null;
  if (gap) return `No value: ${gap}`;
  for (const need of m.needs ?? []) {
    if (need === "model") {
      if (b.model === undefined || s.models.some((x) => x !== b.model)) return "Not compared: the pro pool was built with another rating or win-probability model";
      continue;
    }
    const [known, total, what, unit] = INPUT_COVERAGE[need];
    if (s.m[known] < s.m[total]) return `Not compared: ${what} known for ${s.m[known]} of ${s.m[total]} ${unit}`;
  }
  if (m.sample?.min !== undefined) {
    const n = m.sample.n(s);
    if (n < m.sample.min) return `Not compared: ${n} ${m.sample.unit}; a percentile needs ${m.sample.min}`;
  }
  return null;
}

function poolName(s: Summary, opt: CompareOptions, metricGroup?: string): string {
  if (opt.map) return `map:${opt.map}`;
  // Sniping is always compared with everyone (HLTV keeps no role variant for it).
  if (opt.pool === "all" || metricGroup === "sniping") return "all";
  return roleOf(s);
}

export function compare(s: Summary, b: Baselines, opt: CompareOptions = {}): Record<string, Percentile> {
  const side = opt.side ?? "both";
  const out: Record<string, Percentile> = {};
  for (const m of METRICS) {
    const pool = poolName(s, opt, m.group);
    const q = b.pools[pool]?.[side]?.[m.id] ?? null;
    const value = m.value(s);
    // the reason holds with or without a value: a metric whose input is missing may have no value at all
    const reason = notComparable(m, s, b);
    let pct = value === null || q === null || reason ? null : percentileOf(q, value);
    if (pct !== null && m.kind === "performance" && m.lowerIsBetter) pct = 100 - pct;
    out[m.id] = { id: m.id, value, pct, pool, reason, n: m.sample?.n(s) ?? null };
  }
  return out;
}

export interface AttributeScore {
  id: string;
  label: string;
  kind: Kind;
  /** mean of the metrics' percentiles, 0-100; null when none has one */
  score: number | null;
  metrics: Percentile[];
}

/** HLTV-style attribute scores: each the mean percentile of its metrics in the comparison pool. */
export function attributes(s: Summary, b: Baselines, opt: CompareOptions = {}): AttributeScore[] {
  const p = compare(s, b, opt);
  return ATTRIBUTES.map((a) => {
    const metrics = a.metrics.map((id) => p[id]);
    const have = metrics.filter((x) => x.pct !== null);
    return { id: a.id, label: a.label, kind: a.kind, score: have.length ? have.reduce((t, x) => t + x.pct!, 0) / have.length : null, metrics };
  });
}

// ---- building pools ------------------------------------------------------------------------------

/** Units with a value a metric needs in a pool before its quantiles are written. Ours, no fit. */
export const MIN_UNITS = 8;

/** One player (or player-map) on one side, and the pools it belongs to. */
export interface PoolUnit { pools: string[]; side: SideKey; s: Summary }

const round4 = (x: number) => Number(x.toPrecision(4));

function quantiles(xs: number[]): number[] {
  const v = [...xs].sort((a, b) => a - b);
  return QUANTILES.map((q) => {
    const pos = (q / 100) * (v.length - 1);
    const lo = Math.floor(pos);
    return round4(v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo));
  });
}

/** The one model fingerprint of the units' facts, or "mixed". */
export const modelOf = (units: PoolUnit[]) => {
  const ms = new Set(units.flatMap((u) => u.s.models));
  return ms.size === 1 ? [...ms][0] : "mixed";
};

/** Quantiles of every metric per pool and side; a metric with fewer than MIN_UNITS values in a pool is null there. */
export function buildPools(units: PoolUnit[]): Pick<Baselines, "n" | "pools"> {
  const vals = units.map((u) => ({ ...u, v: Object.fromEntries(METRICS.map((m) => [m.id, m.value(u.s)])) }));
  const out: Pick<Baselines, "n" | "pools"> = { n: {}, pools: {} };
  for (const pool of new Set(units.flatMap((u) => u.pools))) {
    out.pools[pool] = {};
    out.n[pool] = {};
    for (const side of ["both", "CT", "T"] as const) {
      const us = vals.filter((u) => u.side === side && u.pools.includes(pool));
      if (!us.length) continue;
      out.n[pool][side] = us.length;
      out.pools[pool][side] = Object.fromEntries(METRICS.map((m) => {
        const xs = us.map((u) => u.v[m.id]).filter((x): x is number => x !== null && Number.isFinite(x));
        return [m.id, xs.length >= MIN_UNITS ? quantiles(xs) : null];
      }));
    }
  }
  return out;
}

/**
 * The user's own population (design/identity.md): style is ranked against bot careers, not pros.
 * Careers with fewer than CAREER_MIN_ROUNDS rounds are left out of the pools, per side half of it;
 * until BOT_CAREERS_MIN careers qualify, the scores are provisional. Both thresholds are the project
 * plan's; no data run picked them.
 */
export const BOT_CAREERS_MIN = 15;
export const CAREER_MIN_ROUNDS = 150;

/** Baselines from bot careers, each rolled up over the user's matches on both sides and per side. */
export function careerBaselines(careers: Record<SideKey, Summary>[], built: string): { baselines: Baselines; provisional: boolean; careers: number } {
  const units: PoolUnit[] = [];
  let qualified = 0;
  for (const c of careers) {
    if (c.both.m.rounds < CAREER_MIN_ROUNDS) continue;
    qualified++;
    const pools = ["all", roleOf(c.both)];
    for (const side of ["both", "CT", "T"] as const) {
      if (c[side].m.rounds >= (side === "both" ? CAREER_MIN_ROUNDS : CAREER_MIN_ROUNDS / 2)) units.push({ pools, side, s: c[side] });
    }
  }
  const baselines: Baselines = { version: 1, built, source: `${qualified} bot careers with ${CAREER_MIN_ROUNDS}+ rounds`, model: modelOf(units), ...buildPools(units) };
  return { baselines, provisional: qualified < BOT_CAREERS_MIN, careers: qualified };
}
