// Identity (how you play): observable role probabilities per side, evidence rows, and
// "plays like" / "performs like" similarity. design/identity.md keeps style apart from performance.
//
// Packer's labelled pros supply the mapped Entry/Lurker and Anchor/Rotator fit. Trader, Support and
// Aggressor use explicit thresholds over demo-derived features. AWP use is a separate feature because
// Packer's dataset does not include inventories. Validation and the holdout result live in VALIDATION.md.
import type { AttributeScore, Baselines, CompareOptions, SideKey } from "./compare";
import { compare, roleOf } from "./compare";
import type { Measures } from "./facts";
import { METRIC } from "./metrics";
import type { Summary } from "./rollup";
import { ROLE_THRESHOLDS, roleHigh, type RoleMetricId, type RoleThresholds } from "./role-thresholds";
import model from "./roles-params.json";

export const FEATURES = ["tapd", "oap", "podt", "pokt", "adnt", "adat"] as const;
export type Feature = (typeof FEATURES)[number];

interface RoleFit { n: number; mean: number[]; sd: number[] }
export interface CalibrationPoint { x: number; y: number }
export type RoleCalibration = Partial<Record<RoleName, CalibrationPoint[]>>;
export interface RoleModel {
  source: string;
  features: string[];
  sides: Record<"T" | "CT", { n: number; roles: Record<string, RoleFit> }>;
  calibration?: Record<"T" | "CT", RoleCalibration>;
  thresholds?: RoleThresholds;
}
const MODEL = model as unknown as RoleModel;

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
export type RoleName = "Entry" | "Trader" | "Support" | "Lurker" | "Anchor" | "Rotator" | "Aggressor" | "AWPer";
export type RoleCalibrationStatus = "calibrated" | "fit" | "measured";

/** Packer's labels mapped onto observable roles. Half-Lurker is deliberately folded into Lurker. */
export const ROLE_NAME: Record<string, RoleName | null> = {
  Spacetaker: "Entry", Lurker: "Lurker", "Half-Lurker": "Lurker", Anchor: "Anchor", Rotator: "Rotator", Mixed: null, AWPer: "AWPer",
  Entry: "Entry", Trader: "Trader", Support: "Support", Aggressor: "Aggressor",
};

export const mapRoleName = (label: string | undefined): RoleName | null => label ? ROLE_NAME[label] ?? null : null;

export const ROLE_TIPS: Record<RoleName, string> = {
  Entry: "Takes the first fight and creates space for teammates.",
  Trader: "Follows teammates closely and answers their deaths quickly.",
  Support: "Uses utility before contact so teammates can take safer fights.",
  Lurker: "Works apart from the main group and attacks late or elsewhere.",
  Anchor: "Stays at one site and delays the hit until help arrives.",
  Rotator: "Moves between defensive areas when the round changes.",
  Aggressor: "Pushes forward early to find information or the first fight.",
  AWPer: "Carries the AWP often enough to shape the player's identity.",
};

export interface RoleMetric {
  id: string;
  label: string;
  value: number | null;
  unit: "pct" | "secs" | "units" | "perRound" | "count";
  proRange: [number, number] | null;
  threshold: number | null;
  tip: string;
}

export interface RoleBlend {
  side: "T" | "CT";
  /** A single role only when the rounds, probability, and margin gates all pass. */
  primary: RoleName | null;
  /** Primary's distribution share, or null when withheld. Only mapped classes have calibration labels. */
  probability: number | null;
  /** The two leading roles when the single-primary gates do not pass. */
  top2: [RoleName, RoleName] | null;
  /** Why a single primary was withheld, including the under-30-rounds case. */
  reason: string | null;
  /** Role name -> fit share, with no Mixed or Half-lurker labels. Unknown AWP usage is null. */
  distribution: Record<RoleName, number | null> | null;
  /** How each role's distribution share was obtained. */
  calibrationStatus: Partial<Record<RoleName, RoleCalibrationStatus>>;
  /** Kept as an alias for older clients and rolesBySpawn consumers. */
  blend: Record<string, number | null> | null;
  metrics: RoleMetric[];
  /** Plain-language evidence retained for older clients. */
  evidence: string[];
  rounds: number;
  awp: number | null;
  loadoutRounds: number;
  tips: Record<RoleName, string>;
}

const pct = (x: number) => `${Math.round(x)}%`;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const share = (n: number, d: number) => d > 0 ? n / d : null;

const softmax = (scores: Record<string, number>): Record<string, number> => {
  const max = Math.max(...Object.values(scores));
  const weights = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.exp((v - max) * 4)]));
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / total]));
};

// Product acceptance gates, not fitted accuracy thresholds.
export const ROLE_MIN_ROUNDS = 30;
export const ROLE_MIN_PROBABILITY = 0.60;
export const ROLE_MIN_MARGIN = 0.15;

function calibrationStatus(side: "T" | "CT"): Partial<Record<RoleName, RoleCalibrationStatus>> {
  return side === "T"
    ? { Entry: "calibrated", Trader: "fit", Support: "fit", Lurker: "calibrated", AWPer: "measured" }
    : { Anchor: "calibrated", Rotator: "calibrated", Aggressor: "fit", Support: "fit", AWPer: "measured" };
}

function sitePresence(s: Summary): number | null {
  const places = Object.values(s.presence).flatMap((p) => Object.entries(p.places));
  const total = places.reduce((n, [, seconds]) => n + seconds, 0);
  if (!total) return null;
  const site = places.filter(([place]) => /bombsite|site\s*[ab]/i.test(place)).reduce((n, [, seconds]) => n + seconds, 0);
  return site / total;
}

function roleMetrics(s: Summary, awp: number | null, thresholds: RoleThresholds = ROLE_THRESHOLDS): RoleMetric[] {
  const m = s.m;
  const openingAttempts = share(m.openingKills + m.openingDeaths, m.rounds);
  const tradeKills = share(m.tradeKills, m.kills);
  const tradeAssistShare = share(m.tradeKills + m.assists, m.kills + m.assists);
  const utilityPR = share(m.smokes + m.flashes + m.hes + m.molotovs, m.rounds);
  const teamDistance = share(m.nearestDistSum, m.spacingSamples);
  const firstContactTime = share(s.aggression.contactSecs, s.aggression.contactRounds);
  const pushDepth = share(s.aggression.pushSum, s.aggression.pushRounds);
  const site = sitePresence(s);
  const pctValue = (value: number | null) => value === null ? null : value * 100;
  return [
    ["openingAttempts", "Opening attempts", pctValue(openingAttempts), "pct", "How often you take part in the round's first fight."],
    ["tradeKills", "Trade kills", pctValue(tradeKills), "pct", "Share of your kills that answer a teammate's death."],
    ["tradeAssistShare", "Trade and assist share", pctValue(tradeAssistShare), "pct", "Share of your fragging that plays off teammates."],
    ["utilityPR", "Utility per round", utilityPR, "perRound", "Grenades thrown each round; event order is unavailable in rollups."],
    ["teamDistance", "Nearest teammate distance", teamDistance, "units", "Average distance from your nearest teammate during setup."],
    ["firstContactTime", "First contact time", firstContactTime, "secs", "Seconds into the round before your first contact."],
    ["pushDepth", "Early push depth", pctValue(pushDepth), "pct", "Furthest progress toward the enemy before first kill or death."],
    ["sitePresence", "Site presence", pctValue(site), "pct", "Share of recorded alive time spent at a bombsite."],
    ["areaChanges", "Area changes", null, "count", "Rotations need per-round area sequences, unavailable in rollup summaries."],
    ["awpShare", "AWP rounds", awp === null ? null : awp * 100, "pct", "Share of recorded loadout rounds carrying an AWP."],
  ].map(([id, label, value, _unit, tip]) => {
    const provenance = thresholds[id as RoleMetricId];
    return { id: id as string, label: label as string, value: value as number | null, unit: provenance.unit, proRange: provenance?.proRange ?? null, threshold: provenance?.threshold ?? null, tip: tip as string };
  });
}

/** Metric values used to fit fold-local rule ranges. */
export function roleMetricRows(s: Summary, thresholds: RoleThresholds = ROLE_THRESHOLDS): RoleMetric[] {
  const awp = s.m.loadoutRounds ? s.m.roundsWithAwp / s.m.loadoutRounds : null;
  return roleMetrics(s, awp, thresholds);
}

function isotonic(points: { x: number; y: number }[], value: number): number {
  if (!points.length) return value;
  if (value <= points[0].x) return points[0].y;
  for (let i = 1; i < points.length; i++) if (value <= points[i].x) {
    const a = points[i - 1], b = points[i];
    const t = b.x === a.x ? 1 : (value - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  }
  return points[points.length - 1].y;
}

function calibrated(distribution: Record<RoleName, number | null>, calibration: RoleCalibration | undefined, fixedAwper: number | null): Record<RoleName, number | null> {
  if (!calibration) return distribution;
  const adjusted = Object.fromEntries(Object.entries(distribution).filter(([role, value]) => role !== "AWPer" && value !== null).map(([role, value]) => [role, isotonic(calibration[role as RoleName] ?? [], value as number)])) as Record<RoleName, number>;
  const total = Object.values(adjusted).reduce((a, b) => a + b, 0);
  if (!total) return distribution;
  return { ...Object.fromEntries(Object.entries(adjusted).map(([role, value]) => [role, (value / total) * (1 - (fixedAwper ?? 0))])), AWPer: fixedAwper } as Record<RoleName, number | null>;
}

export function roleDecision(distribution: Record<RoleName, number | null> | null, rounds: number): { primary: RoleName | null; probability: number | null; top2: [RoleName, RoleName] | null; reason: string | null } {
  if (!distribution) return { primary: null, probability: null, top2: null, reason: "No role evidence is available." };
  const top = Object.entries(distribution).filter((entry): entry is [RoleName, number] => entry[1] !== null).sort((a, b) => b[1] - a[1]);
  if (!top.length) return { primary: null, probability: null, top2: null, reason: "No role evidence is available." };
  const first = top[0], second = top[1];
  const top2 = second ? [first[0], second[0]] as [RoleName, RoleName] : null;
  if (rounds < ROLE_MIN_ROUNDS) return { primary: null, probability: null, top2: null, reason: `Need at least ${ROLE_MIN_ROUNDS} side rounds for a single role.` };
  const margin = second ? first[1] - second[1] : first[1];
  if (first[1] >= ROLE_MIN_PROBABILITY && margin >= ROLE_MIN_MARGIN) return { primary: first[0], probability: first[1], top2: null, reason: null };
  return { primary: null, probability: null, top2, reason: `Top role needs ${ROLE_MIN_PROBABILITY.toFixed(2)} probability and ${ROLE_MIN_MARGIN.toFixed(2)} margin.` };
}

function mappedPacker(x: Record<Feature, number>, side: "T" | "CT", fitModel: RoleModel): Partial<Record<RoleName, number>> {
  const raw = roleProbabilities(fitModel.sides[side], x);
  const out: Partial<Record<RoleName, number>> = {};
  for (const [role, probability] of Object.entries(raw)) {
    const mapped = mapRoleName(role);
    if (mapped) out[mapped] = (out[mapped] ?? 0) + probability;
  }
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  return total ? Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / total])) as Partial<Record<RoleName, number>> : {};
}

/**
 * A role blend for one side. Packer supplies the labelled Entry/Lurker and Anchor/Rotator signal;
 * Trader, Support and Aggressor use explicit thresholds over demo-derived features.
 */
export function roleBlend(s: Summary, side: "T" | "CT", fitModel: RoleModel = MODEL): RoleBlend {
  const m = s.m;
  const statuses = calibrationStatus(side);
  const x = packerFeatures(m);
  const awp = m.loadoutRounds ? m.roundsWithAwp / m.loadoutRounds : null;
  const thresholds = fitModel.thresholds ?? ROLE_THRESHOLDS;
  const metrics = roleMetrics(s, awp, thresholds);
  const value = (id: string) => metrics.find((metric) => metric.id === id)?.value ?? null;
  const evidence: string[] = awp === null
    ? (m.rounds ? [`No freeze-end loadout recorded in ${side} rounds, so the AWP share is unknown.`] : [])
    : [m.loadoutRounds < m.rounds ? `Carried an AWP in ${pct(100 * awp)} of the ${m.loadoutRounds} ${side} rounds with a recorded loadout (of ${m.rounds}).` : `Carried an AWP in ${pct(100 * awp)} of ${side} rounds.`];
  if (!m.rounds || !x) return { side, primary: null, probability: null, top2: null, reason: m.rounds < ROLE_MIN_ROUNDS ? `Need at least ${ROLE_MIN_ROUNDS} side rounds for a role.` : "No role evidence is available.", distribution: null, calibrationStatus: statuses, blend: null, metrics, evidence, rounds: m.rounds, awp, loadoutRounds: m.loadoutRounds, tips: ROLE_TIPS };

  const opening = value("openingAttempts"), trades = value("tradeKills"), tradeAssist = value("tradeAssistShare");
  const utility = value("utilityPR"), distance = value("teamDistance"), contact = value("firstContactTime");
  const push = value("pushDepth"), site = value("sitePresence");
  const high = (v: number | null, id: RoleMetricId) => roleHigh(id, v, thresholds);
  const low = (v: number | null, id: RoleMetricId) => 1 - roleHigh(id, v, thresholds);
  const rules: Record<RoleName, number> = side === "T" ? {
    Entry: (high(opening, "openingAttempts") + high(push, "pushDepth") + low(contact, "firstContactTime")) / 3,
    Trader: (high(trades, "tradeKills") + high(tradeAssist, "tradeAssistShare") + low(opening, "openingAttempts")) / 3,
    Support: (high(utility, "utilityPR") + high(tradeAssist, "tradeAssistShare") + low(opening, "openingAttempts")) / 3,
    Lurker: (high(distance, "teamDistance") + high(contact, "firstContactTime") + low(push, "pushDepth")) / 3,
    AWPer: 0,
    Anchor: 0, Rotator: 0, Aggressor: 0,
  } : {
    Anchor: (high(site, "sitePresence") + low(push, "pushDepth") + high(contact, "firstContactTime")) / 3,
    Rotator: (low(site, "sitePresence") + high(distance, "teamDistance") + high(tradeAssist, "tradeAssistShare")) / 3,
    Aggressor: (high(opening, "openingAttempts") + high(push, "pushDepth") + low(contact, "firstContactTime")) / 3,
    Support: (high(utility, "utilityPR") + high(tradeAssist, "tradeAssistShare") + low(opening, "openingAttempts")) / 3,
    AWPer: 0,
    Entry: 0, Trader: 0, Lurker: 0,
  };
  const packed = mappedPacker(x, side, fitModel);
  for (const role of Object.keys(rules) as RoleName[]) if (role !== "AWPer" && packed[role] !== undefined) rules[role] = 0.55 * packed[role]! + 0.45 * rules[role];
  const sideRoles: RoleName[] = side === "T" ? ["Entry", "Trader", "Support", "Lurker"] : ["Anchor", "Rotator", "Aggressor", "Support"];
  const active = Object.fromEntries(sideRoles.map((role) => [role, rules[role]]));
  const nonAwper = softmax(active) as Record<RoleName, number>;
  const awpProbability = awp === null ? null : clamp01(awp);
  const distribution = {
    ...Object.fromEntries(Object.entries(nonAwper).map(([role, share]) => [role, share * (1 - (awpProbability ?? 0))])),
    AWPer: awpProbability,
  } as Record<RoleName, number | null>;
  const calibratedDistribution = calibrated(distribution, fitModel.calibration?.[side], awpProbability);
  const decision = roleDecision(calibratedDistribution, m.rounds);
  evidence.push(`In the opening duel in ${pct(value("openingAttempts")!)} of rounds.`, `${pct(value("tradeAssistShare")!)} of fragging came from trades or assists.`);
  return { side, ...decision, distribution: calibratedDistribution, calibrationStatus: statuses, blend: calibratedDistribution, metrics, evidence, rounds: m.rounds, awp, loadoutRounds: m.loadoutRounds, tips: ROLE_TIPS };
}

/** One overall role distribution weighted by the number of rounds on each side. */
export interface OverallRole {
  primary: RoleName | null;
  probability: number | null;
  top2: [RoleName, RoleName] | null;
  reason: string | null;
  distribution: Record<string, number | null> | null;
  calibrationStatus: Partial<Record<RoleName, RoleCalibrationStatus>>;
  blend: Record<string, number | null> | null;
  rounds: Record<"T" | "CT", number>;
}

export function overallRole(t: RoleBlend, ct: RoleBlend): OverallRole {
  const sides = [t, ct].filter((b) => b.distribution && b.rounds > 0);
  const rounds = { T: t.rounds, CT: ct.rounds };
  const total = sides.reduce((a, b) => a + b.rounds, 0);
  if (!total) return { primary: null, probability: null, top2: null, reason: "No role evidence is available.", distribution: null, calibrationStatus: {}, blend: null, rounds };
  const distribution: Record<RoleName, number | null> = {} as Record<RoleName, number | null>;
  const calibrationStatus: Partial<Record<RoleName, RoleCalibrationStatus>> = {};
  const awpKnown = sides.every((b) => b.distribution!.AWPer !== null);
  for (const b of sides) for (const [role, share] of Object.entries(b.distribution!)) {
    if (share === null || role === "AWPer") continue;
    distribution[role as RoleName] = (distribution[role as RoleName] ?? 0) + (share * b.rounds) / total;
    const status = b.calibrationStatus[role as RoleName];
    if (status && (!calibrationStatus[role as RoleName] || status === "measured" || (status === "calibrated" && calibrationStatus[role as RoleName] === "fit"))) calibrationStatus[role as RoleName] = status;
  }
  distribution.AWPer = awpKnown
    ? sides.reduce((sum, b) => sum + (b.distribution!.AWPer! * b.rounds) / total, 0)
    : null;
  const awpStatus = sides.find((b) => b.calibrationStatus.AWPer)?.calibrationStatus.AWPer;
  if (awpStatus) calibrationStatus.AWPer = awpStatus;
  const decision = roleDecision(distribution, total);
  return { ...decision, distribution, calibrationStatus, blend: distribution, rounds };
}

// ---- role signals and the style compass ---------------------------------------------------------

/**
 * One measured tendency with a hand-set threshold: the role card's signals and the style compass's
 * lines (main's stats/role.ts). `metric` is read over both sides, or over `side` alone. The thresholds
 * remain hand-chosen. role-thresholds.ts records measured reference ranges and the 3D distance check.
 */
export interface RoleSignal { id: "Entry" | "Support" | "Lurker"; metric: string; threshold: number; side: "T" | null }

export const ROLE_SIGNALS: readonly RoleSignal[] = [
  { id: "Entry", metric: "openingAttempts", threshold: ROLE_THRESHOLDS.openingAttempts.threshold!, side: null },
  { id: "Support", metric: "tradeAssistShare", threshold: ROLE_THRESHOLDS.tradeAssistShare.threshold!, side: null },
  { id: "Lurker", metric: "teamDistance", threshold: ROLE_THRESHOLDS.teamDistance.threshold!, side: "T" },
];

const signal = (id: RoleSignal["id"]) => ROLE_SIGNALS.find((x) => x.id === id)!;

/** Where a point sits against the Entry and Support thresholds: the compass's four zones. */
export type StyleZone = "Entry" | "Support" | "Entry and support" | "Rifler";

/** The compass zone of opening attempts and trade/assist share, both in percent. */
export function styleZone(openingAttempts: number, tradeAssistShare: number): StyleZone {
  const entry = openingAttempts >= signal("Entry").threshold;
  const support = tradeAssistShare >= signal("Support").threshold;
  return entry && support ? "Entry and support" : entry ? "Entry" : support ? "Support" : "Rifler";
}

/** A compass point's role in main's wording: "AWPer" for the AWPer pool (compare.ts roleOf), else "Rifler (zone)". */
export const styleLabel = (role: "awper" | "rifler", zone: StyleZone) => (role === "awper" ? "AWPer" : zone === "Rifler" ? "Rifler" : `Rifler (${zone})`);

/** One player on the style compass: x opening attempts, y trade/assist share, both percent. */
export interface StylePoint { name: string; rounds: number; x: number; y: number; label: string }

/** A summary's compass point; null when either axis has no value (no rounds, or no kills and assists). */
export function stylePoint(name: string, s: Summary): StylePoint | null {
  const x = METRIC.openingAttempts.value(s);
  const y = METRIC.tradeAssistShare.value(s);
  if (x === null || y === null) return null;
  return { name, rounds: s.m.rounds, x, y, label: styleLabel(roleOf(s), styleZone(x, y)) };
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
