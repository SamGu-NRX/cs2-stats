// Grouping, ordering and arithmetic for the per-match views on #36's worker calls (stats/matchviews.ts):
// the rating's split into its terms, "your match" rows, head to head per pair, zones per side, the
// man-advantage grid and bombsite rows. Every number comes from the worker; this file only orients,
// merges, sorts and adds the engine's own terms back up. Pure, so each has one right answer to test.
import type { Feature } from "../../../stats/rating3";
import type { Bombsites, HeadToHead, SiteOutcomes, Situations, ZoneRow } from "../../../stats/matchviews";
import type { WeaponClass } from "../../../stats/weapons";

// ---------------------------------------------------------------- rating terms

/** Rating 3.0's six inputs in words, keyed by the engine's input name (rating3.ts FEATURES). */
export const TERM_LABEL: Record<Feature, { label: string; tip: string }> = {
  kpr_eco: { label: "Kills", tip: "Eco-adjusted kills, weighted." },
  adr_eco: { label: "Damage", tip: "Eco-adjusted damage, weighted." },
  dpr_eco: { label: "Deaths", tip: "Eco-adjusted deaths, weighted. Always a cost." },
  kast_eco: { label: "KAST", tip: "A kill, assist, survival or traded death, eco-adjusted." },
  mk: { label: "Multi-kills", tip: "Two or more kills in the round." },
  swing: { label: "Swing", tip: "The change in your team's chance to win that you caused." },
};

/** The engine's input order (Meta.rating.inputs) checked against the six this file names; an unknown input throws. */
export function ratingOrder(inputs: readonly string[]): Feature[] {
  return inputs.map((input) => {
    if (!Object.hasOwn(TERM_LABEL, input)) throw new Error(`Rating 3.0 has an input "${input}" the rating breakdown cannot name`);
    return input as Feature;
  });
}

/** One input's share of a rating, in rating points. */
export interface Contribution { input: Feature; value: number }

/** A rating's split (Rating3.terms or RoundRating.terms, the engine's own) in the engine's input order. */
export function contributions(order: readonly Feature[], terms: Record<Feature, number>): Contribution[] {
  return order.map((input) => ({ input, value: terms[input] }));
}

export interface Step { key: string; label: string; value: number; from: number; to: number }

/**
 * A waterfall: the intercept as the first step from 0, then each contribution from where the one
 * before ended. `total` is where the last step ends, which is the rating.
 */
export function ratingSteps(intercept: number, parts: readonly Contribution[]): { steps: Step[]; total: number } {
  const steps: Step[] = [{ key: "base", label: "Base", value: intercept, from: 0, to: intercept }];
  let run = intercept;
  for (const p of parts) {
    steps.push({ key: p.input, label: TERM_LABEL[p.input].label, value: p.value, from: run, to: run + p.value });
    run += p.value;
  }
  return { steps, total: run };
}

/**
 * The value axis of the rating-by-round chart: every rating and reference line inside, 0 included,
 * with 8 % of the span as headroom each way so a dot never sits on the edge.
 */
export function ratingDomain(values: readonly (number | null)[], refs: readonly (number | null)[]): [number, number] {
  const xs = [0, ...values, ...refs].filter((x): x is number => x !== null && Number.isFinite(x));
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const pad = (hi - lo || 1) * 0.08;
  return [lo - pad, hi + pad];
}

/** A signed difference in a value's own format: "+4.8%", "−0.22", and the plain format at zero. */
export function signedIn(fmt: (v: number) => string, d: number): string {
  const s = fmt(Math.abs(d));
  if (fmt(0) === s) return s;
  return `${d > 0 ? "+" : "−"}${s}`;
}

// ---------------------------------------------------------------- your match

/** The metrics "your match" shows, in this order: the scoreboard first, then how the rounds were played. */
export const YOUR_MATCH: { group: string; ids: string[] }[] = [
  { group: "Scoreboard", ids: ["rating3", "kpr", "adr", "kast", "dpr", "swing"] },
  { group: "How you played", ids: ["hs", "openingSuccess", "deathsTradedPct", "tradeKillsPct", "utilDmgPR", "flashAssistsPR"] },
];

/**
 * The change against the reference as a share of it (0.25 for a quarter up), for drawing only; null
 * without both values or with a zero reference, where a share has no meaning.
 */
export function relChange(value: number | null, average: number | null): number | null {
  if (value === null || average === null || average === 0) return null;
  return (value - average) / Math.abs(average);
}

// ---------------------------------------------------------------- head to head

export type PairMeasure = "kills" | "damage" | "openings" | "flashes";

/** One enemy pair seen from `x`: index 0 is what x did to y, index 1 what y did to x. */
export interface Oriented {
  kills: [number, number];
  damage: [number, number];
  openings: [number, number];
  flashes: [{ count: number; secs: number }, { count: number; secs: number }];
  weapons: [Partial<Record<WeaponClass, number>>, Partial<Record<WeaponClass, number>>];
}

/** The pair of x and y from the engine's list, turned so x comes first; null when they are not enemies. */
export function orient(rows: readonly HeadToHead[], x: string, y: string): Oriented | null {
  const h = rows.find((r) => (r.a === x && r.b === y) || (r.a === y && r.b === x));
  if (!h) return null;
  const flip = h.a !== x;
  const o = <T,>(p: [T, T]): [T, T] => (flip ? [p[1], p[0]] : [p[0], p[1]]);
  return { kills: o(h.kills), damage: o(h.damage), openings: o(h.openings), flashes: o(h.flashes), weapons: o(h.weapons) };
}

/** The two numbers a matrix cell shows for a measure; flashes count blinds. */
export function measureOf(o: Oriented, m: PairMeasure): [number, number] {
  return m === "flashes" ? [o.flashes[0].count, o.flashes[1].count] : o[m];
}

/**
 * The opponent `me` fought most: most kills both ways, then most damage both ways, then the first in
 * `opponents`' order. Null without opponents.
 */
export function mostFought(rows: readonly HeadToHead[], me: string, opponents: readonly string[]): string | null {
  let best: string | null = null;
  let key: [number, number] = [-1, -1];
  for (const id of opponents) {
    const o = orient(rows, me, id);
    if (!o) continue;
    const k: [number, number] = [o.kills[0] + o.kills[1], o.damage[0] + o.damage[1]];
    if (k[0] > key[0] || (k[0] === key[0] && k[1] > key[1])) { best = id; key = k; }
  }
  return best;
}

/** Weapon classes in the order the pair detail lists them. */
export const CLASS_ORDER: WeaponClass[] = ["rifle", "sniper", "smg", "heavy", "pistol", "grenade", "knife", "other"];

/** A side's kills by weapon class, most first (ties in CLASS_ORDER), classes without kills left out. */
export function weaponsByKills(w: Partial<Record<WeaponClass, number>>): [WeaponClass, number][] {
  return CLASS_ORDER.flatMap((c): [WeaponClass, number][] => (w[c] ? [[c, w[c]!]] : [])).sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------- zones

export interface Zone {
  zone: string;
  kills: number;
  deaths: number;
  /** the same per side, for the row's split */
  bySide: Partial<Record<"T" | "CT", { kills: number; deaths: number }>>;
  killsAt: [number, number][];
  deathsAt: [number, number][];
}

/**
 * The engine's zone rows (one per zone and side) for one side, or both sides merged per zone; sorted
 * by kills plus deaths, then kills, then the zone's name.
 */
export function zonesFor(rows: readonly ZoneRow[], side: "both" | "t" | "ct"): Zone[] {
  const out = new Map<string, Zone>();
  for (const r of rows) {
    if (side !== "both" && r.side !== side.toUpperCase()) continue;
    let z = out.get(r.zone);
    if (!z) out.set(r.zone, (z = { zone: r.zone, kills: 0, deaths: 0, bySide: {}, killsAt: [], deathsAt: [] }));
    z.kills += r.kills;
    z.deaths += r.deaths;
    const s = (z.bySide[r.side] ??= { kills: 0, deaths: 0 });
    s.kills += r.kills;
    s.deaths += r.deaths;
    z.killsAt.push(...r.killsAt);
    z.deathsAt.push(...r.deathsAt);
  }
  return [...out.values()].sort((a, b) => b.kills + b.deaths - (a.kills + a.deaths) || b.kills - a.kills || a.zone.localeCompare(b.zone));
}

// ---------------------------------------------------------------- situations

export interface SituationCell { us: number; them: number; rounds: number; won: number }

/**
 * The man-advantage states as a grid: rows are your side's players alive, columns the enemy's, both
 * from the largest count down to 1; null where the side never passed through that state. The size is
 * the largest count in any state, so a 2v2 match draws a 2 by 2 grid. A key that is not "NvM" throws.
 */
export function situationGrid(s: Situations): { size: number; cells: (SituationCell | null)[][] } {
  const parsed = Object.entries(s).map(([k, v]) => {
    const m = /^(\d+)v(\d+)$/.exec(k);
    if (!m) throw new Error(`situations: "${k}" is not a state like 5v4`);
    return { us: +m[1], them: +m[2], ...v };
  });
  const size = Math.max(0, ...parsed.flatMap((p) => [p.us, p.them]));
  const cells = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => {
    const us = size - r, them = size - c;
    return parsed.find((p) => p.us === us && p.them === them) ?? null;
  }));
  return { size, cells };
}

// ---------------------------------------------------------------- bombsites

export type SiteKey = keyof SiteOutcomes;

/** A site's four outcomes in the order the card lists them: T's two, then CT's two. */
export const SITE_ROWS: { key: SiteKey; side: "T" | "CT"; label: string; tip: string }[] = [
  { key: "take", side: "T", label: "Take", tip: "T rounds your side entered the site before a plant, and those planted there." },
  { key: "postPlant", side: "T", label: "Post-plant", tip: "T rounds your side planted here, and those it won." },
  { key: "hold", side: "CT", label: "Hold", tip: "CT rounds an enemy entered the site before a plant, and those won without a plant there." },
  { key: "retake", side: "CT", label: "Retake", tip: "CT rounds the bomb was planted here, and those your side won." },
];

/** The sites in letter order. */
export const sitesOf = (b: Bombsites) => Object.keys(b.sites).sort().map((letter) => ({ letter, o: b.sites[letter] }));

/** One line on why take and hold are missing or partial; null when every round could be read. */
export function takeHoldGap(t: Bombsites["takeHold"]): string | null {
  if (t.known === t.rounds) return null;
  const list = t.missing.length ? t.missing.join(", ").replace(/, ([^,]*)$/, " and $1") : "the inputs";
  if (t.known === 0) return `Take and hold could not be read: this file has no ${list}.`;
  return `Take and hold read ${t.known} of ${t.rounds} rounds; the rest lack ${list}.`;
}
