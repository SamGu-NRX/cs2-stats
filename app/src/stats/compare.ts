// compare(summary, baselines) -> percentiles. Baselines (tools/baselines.ts writes them) hold, for each
// pool of anonymous pro players and each side, 21 quantiles of every metric. A percentile is read by
// linear interpolation between quantiles.
//
// Pools: "all"; "rifler" and "awper" (design/identity.md: an AWPer has more than 0.20 AWP kills per
// round in the sample); "map:<name>", whose units are player-maps rather than players.
import { ATTRIBUTES, METRICS, type Kind } from "./metrics";
import type { Summary } from "./rollup";

export const QUANTILES = Array.from({ length: 21 }, (_, i) => i * 5);
export const AWPER_MIN_AWP_KPR = 0.2;

export type SideKey = "both" | "CT" | "T";

export interface Baselines {
  version: 1;
  built: string;
  /** what the pools were built from, for the UI's source line */
  source: string;
  /** players (or player-maps) per pool and side */
  n: Record<string, Partial<Record<SideKey, number>>>;
  /** pool -> side -> metric id -> 21 quantiles (QUANTILES), or null when too few units had a value */
  pools: Record<string, Partial<Record<SideKey, Record<string, number[] | null>>>>;
}

/** Share of the pool below v, 0-100, from the stored quantiles. */
export function percentileOf(q: number[], v: number): number {
  if (v <= q[0]) return 0;
  if (v >= q[q.length - 1]) return 100;
  for (let i = 1; i < q.length; i++) {
    if (v > q[i]) continue;
    const span = q[i] - q[i - 1];
    // a run of equal quantiles: the middle of the run
    if (span === 0) { let j = i; while (j < q.length - 1 && q[j + 1] === q[i]) j++; return (QUANTILES[i - 1] + QUANTILES[j]) / 2; }
    return QUANTILES[i - 1] + ((v - q[i - 1]) / span) * (QUANTILES[i] - QUANTILES[i - 1]);
  }
  return 100;
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
    let pct = value === null || q === null ? null : percentileOf(q, value);
    if (pct !== null && m.kind === "performance" && m.lowerIsBetter) pct = 100 - pct;
    out[m.id] = { id: m.id, value, pct, pool };
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
