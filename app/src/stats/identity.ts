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
  /** share of the rounds with a recorded freeze-end loadout that had an AWP; null when no round has one */
  awp: number | null;
  /** rounds with a recorded freeze-end loadout (the AWP share's denominator), of `rounds` */
  loadoutRounds: number;
}

const pct = (x: number) => `${Math.round(x)}%`;

/**
 * A role blend for one side's summary (rollup with sides: [side]); any other filter narrows it further.
 * The AWP share counts only rounds whose freeze-end loadout was recorded (plugin files record none);
 * the evidence says how many when some are missing, and with none the blend has no AWPer share.
 */
export function roleBlend(s: Summary, side: "T" | "CT"): RoleBlend {
  const m = s.m;
  const x = packerFeatures(m);
  const awp = m.loadoutRounds ? m.roundsWithAwp / m.loadoutRounds : null;
  const evidence: string[] = [];
  if (awp !== null) {
    evidence.push(m.loadoutRounds < m.rounds
      ? `Carried an AWP in ${pct(100 * awp)} of the ${m.loadoutRounds} ${side} rounds with a recorded loadout (of ${m.rounds}).`
      : `Carried an AWP in ${pct(100 * awp)} of ${side} rounds.`);
  } else if (m.rounds) evidence.push(`No freeze-end loadout recorded in ${side} rounds, so the AWP share is unknown.`);
  const out = { side, evidence, rounds: m.rounds, awp, loadoutRounds: m.loadoutRounds };
  if (!x) return { ...out, blend: null };
  evidence.push(
    `In the opening duel in ${pct(x.oap)} of rounds.`,
    `Died ${Math.round(x.tapd)} s into the round on average.`,
    `${pct(x.podt)} of deaths were traded; ${pct(x.pokt)} of kills were trades.`,
  );
  const post = roleProbabilities(MODEL.sides[side], x);
  const blend: Record<string, number> = awp === null ? {} : { AWPer: awp };
  for (const [role, p] of Object.entries(post)) blend[ROLE_NAME[role] ?? role] = p * (1 - (awp ?? 0));
  return { ...out, blend };
}

/** One role blend over all rounds, from the two sides' blends. */
export interface OverallRole {
  /** role name -> share, summing to 1; null when neither side has a blend */
  blend: Record<string, number> | null;
  /** rounds per side behind it; a side without a blend adds no weight */
  rounds: Record<"T" | "CT", number>;
}

/**
 * The role over all rounds: each side's blend weighted by its rounds. The model is fitted per side and
 * the sides' roles differ (Entry and Lurker on T, Anchor and Rotator on CT), so a role's overall share
 * is its share of the side it belongs to times that side's share of the rounds.
 */
export function overallRole(t: RoleBlend, ct: RoleBlend): OverallRole {
  const sides = [t, ct].filter((b) => b.blend && b.rounds > 0);
  const total = sides.reduce((a, b) => a + b.rounds, 0);
  const rounds = { T: t.rounds, CT: ct.rounds };
  if (!total) return { blend: null, rounds };
  const blend: Record<string, number> = {};
  for (const b of sides) for (const [role, share] of Object.entries(b.blend!)) blend[role] = (blend[role] ?? 0) + (share * b.rounds) / total;
  return { blend, rounds };
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

/**
 * Profile shape similarity, as a percentage: the cosine of the two profiles' deviations from the pool
 * middle (score minus 50) over the keys both have (design/identity.md). The user's scores rank against
 * one population and a pro's against another, so only shape compares: 100 is the same shape, 0 unrelated,
 * -100 the opposite. Null with no key in common, or when either profile sits exactly at the middle.
 */
export function similarity(a: Record<string, number | null>, b: Record<string, number | null>, keys: readonly string[]): number | null {
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    if (a[k] == null || b[k] == null) continue;
    const x = a[k]! - 50, y = b[k]! - 50;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? (100 * dot) / Math.sqrt(na * nb) : null;
}

/** One player's 0-100 scores on T and on CT. */
export type SideProfile = Partial<Record<"T" | "CT", Record<string, number | null>>>;

const SIDES = ["T", "CT"] as const;
const flat = (p: SideProfile) => Object.fromEntries(SIDES.flatMap((side) => Object.entries(p[side] ?? {}).map(([k, v]) => [`${side}:${k}`, v])));

export const styleScores = (attrs: AttributeScore[]) => Object.fromEntries(attrs.filter((a) => a.kind === "identity").map((a) => [a.id, a.score]));
export const performanceScores = (s: Summary, b: Baselines, opt: CompareOptions = {}) => {
  const p = compare(s, b, opt);
  return Object.fromEntries(PERFORMANCE.map((id) => [id, p[id].pct]));
};

/**
 * Pack players ranked by similarity over both sides' scores: twelve numbers for "style" (plays like:
 * six style attributes on T and on CT), and the rating inputs on T and on CT for "performance" (performs like).
 */
export function mostSimilar(mine: SideProfile, pack: PackPlayer[], by: "style" | "performance", top = 5) {
  const keys = SIDES.flatMap((side) => (by === "style" ? STYLE : PERFORMANCE).map((k) => `${side}:${k}`));
  const me = flat(mine);
  return pack
    .map((p) => ({ name: p.name, similarity: similarity(me, flat({ T: p.sides.T?.[by], CT: p.sides.CT?.[by] }), keys) }))
    .filter((x): x is { name: string; similarity: number } => x.similarity !== null)
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, top);
}
