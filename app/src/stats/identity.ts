// Identity (how you play): role blend per side with plain-language evidence, a support tendency, and
// "plays like" / "performs like" similarity. design/identity.md is binding: style stays apart from
// performance, and "plays like" uses only the six style attributes, per side.
//
// Roles come from Jamie Packer's labelled pros (CS2 Playstyle & Roles Dataset 2024, CC BY 4.0; labels
// adapted from Harry Richards' Positions Database). tools/fit-roles.ts fits, per side, a Gaussian naive
// Bayes over his six features; roles-params.json holds the fit and its leave-one-out accuracy is in
// VALIDATION.md. The blend is the posterior over roles. AWP use decides the AWPer share, because
// Packer's features do not carry it. Support has no labelled source, so it is a separate tendency.
import type { AttributeScore, Baselines, CompareOptions, SideKey } from "./compare";
import { compare } from "./compare";
import type { Measures } from "./facts";
import type { Summary } from "./rollup";
import model from "./roles-params.json";

export const FEATURES = ["tapd", "oap", "podt", "pokt", "adnt", "adat"] as const;
export type Feature = (typeof FEATURES)[number];

interface RoleFit { n: number; mean: number[]; sd: number[] }
export interface RoleModel {
  source: string;
  features: string[];
  sides: Record<"T" | "CT", { n: number; roles: Record<string, RoleFit> }>;
}
const MODEL = model as RoleModel;

/** Packer's features from summed measures; null when a denominator is zero. */
export function packerFeatures(m: Measures): Record<Feature, number> | null {
  if (!m.deaths || !m.rounds || !m.kills || !m.spacingSamples) return null;
  return {
    tapd: m.deathTimeSum / m.deaths, oap: (100 * (m.openingKills + m.openingDeaths)) / m.rounds,
    podt: (100 * m.tradedDeaths) / m.deaths, pokt: (100 * m.tradeKills) / m.kills,
    adnt: m.adntRank / m.spacingSamples, adat: m.adatRank / m.spacingSamples,
  };
}

/** Posterior over one side's roles (equal priors), Gaussian naive Bayes. */
export function roleProbabilities(fit: RoleModel["sides"]["T"], x: Record<Feature, number>): Record<string, number> {
  const logp = Object.entries(fit.roles).map(([role, r]) => {
    let lp = 0;
    FEATURES.forEach((f, j) => {
      const sd = Math.max(r.sd[j], 1e-6);
      lp += -Math.log(sd) - 0.5 * ((x[f] - r.mean[j]) / sd) ** 2;
    });
    return [role, lp] as const;
  });
  const max = Math.max(...logp.map(([, v]) => v));
  const w = logp.map(([role, v]) => [role, Math.exp(v - max)] as const);
  const sum = w.reduce((s, [, v]) => s + v, 0);
  return Object.fromEntries(w.map(([role, v]) => [role, v / sum]));
}

/** Packer's role names in this app's words. */
export const ROLE_NAME: Record<string, string> = {
  Spacetaker: "Entry", Lurker: "Lurker", "Half-Lurker": "Half-lurker", Anchor: "Anchor", Rotator: "Rotator", Mixed: "Mixed", AWPer: "AWPer",
};

export interface RoleBlend {
  side: "T" | "CT";
  /** role name -> share, summing to 1; null when the summary lacks the inputs (positions, deaths, kills) */
  blend: Record<string, number> | null;
  /** plain-language reasons, one per signal */
  evidence: string[];
  rounds: number;
}

const pct = (x: number) => `${Math.round(x)}%`;

/** A role blend for one side's summary (rollup with sides: [side]); any other filter narrows it further. */
export function roleBlend(s: Summary, side: "T" | "CT"): RoleBlend {
  const m = s.m;
  const x = packerFeatures(m);
  const awp = m.rounds ? m.roundsWithAwp / m.rounds : 0;
  const evidence: string[] = [];
  if (m.rounds) evidence.push(`Carried an AWP in ${pct(100 * awp)} of ${side} rounds.`);
  if (!x) return { side, blend: null, evidence, rounds: m.rounds };
  evidence.push(
    `In the opening duel in ${pct(x.oap)} of rounds.`,
    `Died ${Math.round(x.tapd)} s into the round on average.`,
    `${pct(x.podt)} of deaths were traded; ${pct(x.pokt)} of kills were trades.`,
    `Distance to the nearest teammate ranks ${x.adnt.toFixed(2)} in the team (0.2 = closest, 1.0 = farthest), to the team's centre ${x.adat.toFixed(2)}.`,
  );
  const post = roleProbabilities(MODEL.sides[side], x);
  const blend: Record<string, number> = { AWPer: awp };
  for (const [role, p] of Object.entries(post)) blend[ROLE_NAME[role] ?? role] = p * (1 - awp);
  return { side, blend, evidence, rounds: m.rounds };
}

/** Support tendency 0-100: mean percentile of utility thrown and trading against the comparison pool. */
export const SUPPORT_METRICS = ["flashesPR", "smokesPR", "tradeKillsPct", "assistedKillsPct"] as const;
export function supportTendency(s: Summary, b: Baselines, opt: CompareOptions = {}): { score: number | null; evidence: string[] } {
  const p = compare(s, b, opt);
  const have = SUPPORT_METRICS.map((id) => p[id]).filter((x) => x.pct !== null);
  return {
    score: have.length ? have.reduce((t, x) => t + x.pct!, 0) / have.length : null,
    evidence: have.map((x) => `${x.id}: higher than ${Math.round(x.pct!)}% of the pool.`),
  };
}

// ---- similarity ---------------------------------------------------------------------------------

/** A named player's 0-100 scores per side: style attributes, and the rating inputs' percentiles. */
export interface PackPlayer {
  name: string;
  sides: Partial<Record<SideKey, { style?: Record<string, number | null>; performance?: Record<string, number | null> }>>;
}

/** The six style attributes HLTV's "plays like" uses (identity.md: Firepower excluded). */
export const STYLE = ["entrying", "trading", "opening", "closing", "sniping", "utility"] as const;
/** Rating 3.0's inputs, the basis of "performs like". */
export const PERFORMANCE = ["kpr", "adr", "dpr", "kast", "mk", "swing"] as const;

/** 100 minus the mean absolute difference over the scores both have; null with none in common. */
export function similarity(a: Record<string, number | null>, b: Record<string, number | null>, keys: readonly string[]): number | null {
  const d = keys.filter((k) => a[k] != null && b[k] != null).map((k) => Math.abs(a[k]! - b[k]!));
  return d.length ? 100 - d.reduce((s, x) => s + x, 0) / d.length : null;
}

export const styleScores = (attrs: AttributeScore[]) => Object.fromEntries(attrs.filter((a) => a.kind === "identity").map((a) => [a.id, a.score]));
export const performanceScores = (s: Summary, b: Baselines, opt: CompareOptions = {}) => {
  const p = compare(s, b, opt);
  return Object.fromEntries(PERFORMANCE.map((id) => [id, p[id].pct]));
};

/** Pack players ranked by similarity on one side; "style" is plays like, "performance" performs like. */
export function mostSimilar(mine: Record<string, number | null>, pack: PackPlayer[], side: SideKey, by: "style" | "performance", top = 5) {
  const keys = by === "style" ? STYLE : PERFORMANCE;
  return pack
    .map((p) => ({ name: p.name, similarity: p.sides[side]?.[by] ? similarity(mine, p.sides[side]![by]!, keys) : null }))
    .filter((x): x is { name: string; similarity: number } => x.similarity !== null)
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, top);
}
