// The career views' rules with one right answer, kept apart from the components so they test alone:
// the period pairs Where you rank compares, the role evidence track's scale and units, and which
// personal bests lead the Records card. The luck score's words are the match Luck tab's
// (views/match/luck/model.ts), so the two never disagree.
import type { RoleMetric } from "../../../stats/identity";
import type { Period } from "../../../worker/protocol";

// ---------------------------------------------------------------- periods

export type PeriodKind = "week" | "month" | "day";
export const PERIOD_LABEL: Record<PeriodKind, string> = { week: "7 days", month: "30 days", day: "Last day" };
export const PERIOD_TIP: Record<PeriodKind, string> = {
  week: "Your last 7 days of play against the 7 days before.",
  month: "Your last 30 days of play against the 30 days before.",
  day: "Your last day played against the day you played before it.",
};

/** YYYY-MM-DD moved by `n` days, through UTC so no clock change shifts it. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface PeriodPair { kind: PeriodKind; current: Period; previous: Period; /** matches in each */ now: number; before: number }

/**
 * The current and previous windows for one kind, anchored on the latest day played (not today, so a
 * break from the game still compares the last two stretches of play): 7 or 30 days ending on that day
 * against the same length before it, or that day against the last day played before it. Null when
 * either window holds no match, so the toggle can disable it rather than compare against nothing.
 */
export function periodPair(days: (string | null)[], kind: PeriodKind): PeriodPair | null {
  const known = [...new Set(days.filter((d): d is string => !!d))].sort();
  if (!known.length) return null;
  const last = known[known.length - 1];
  let current: Period, previous: Period;
  if (kind === "day") {
    const prev = known[known.length - 2];
    if (!prev) return null;
    current = { from: last, to: last };
    previous = { from: prev, to: prev };
  } else {
    const len = kind === "week" ? 7 : 30;
    current = { from: addDays(last, 1 - len), to: last };
    previous = { from: addDays(last, 1 - 2 * len), to: addDays(last, -len) };
  }
  const inside = (p: Period) => days.filter((d) => d && d >= p.from && d <= p.to).length;
  const now = inside(current), before = inside(previous);
  return now && before ? { kind, current, previous, now, before } : null;
}

// ---------------------------------------------------------------- role evidence

const UNIT_M = 0.0254; // one Source unit is one inch

/** A role metric's value with its unit: "31%", "24 s", "12 m", "1.4" (the per-round label carries its unit), "3". */
export function fmtRoleValue(v: number | null, unit: RoleMetric["unit"]): string {
  if (v === null || !Number.isFinite(v)) return "–";
  switch (unit) {
    case "pct": return `${Math.round(v)}%`;
    case "secs": return `${Math.round(v)} s`;
    case "units": return `${Math.round(v * UNIT_M)} m`;
    case "perRound": return v.toFixed(1);
    case "count": return String(Math.round(v));
  }
}

/** The 1, 2, 2.5 or 5 times a power of ten at or above `x`. */
export function niceCeil(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  return ([1, 2, 2.5, 5, 10].find((k) => k * p >= x - 1e-9) ?? 10) * p;
}

/**
 * One evidence row's track: zero to a clean maximum that fits the pro range, the threshold and every
 * side's value with a little room (shares stop at 100), and each of them placed on it in percent.
 */
export function evidenceScale(values: (number | null)[], proRange: [number, number] | null, threshold: number | null, unit: RoleMetric["unit"]) {
  const top = Math.max(...values.filter((v): v is number => v !== null && Number.isFinite(v)), proRange?.[1] ?? 0, threshold ?? 0, 0);
  const max = unit === "pct" ? Math.min(100, niceCeil(top * 1.1)) : niceCeil(top * 1.1);
  const at = (v: number) => Math.max(0, Math.min(100, (100 * v) / max));
  return { max, at, band: proRange ? [at(proRange[0]), at(proRange[1])] as const : null, tick: threshold === null ? null : at(threshold) };
}

/** Evidence rows that both sides measured nothing for (areaChanges in rollups) leave the list; the card names them in one line instead. */
export function splitEvidence(t: RoleMetric[], ct: RoleMetric[]): { rows: { id: string; t: RoleMetric | null; ct: RoleMetric | null }[]; missing: RoleMetric[] } {
  const ids = [...new Set([...t, ...ct].map((m) => m.id))];
  const rows: { id: string; t: RoleMetric | null; ct: RoleMetric | null }[] = [];
  const missing: RoleMetric[] = [];
  for (const id of ids) {
    const a = t.find((m) => m.id === id) ?? null, b = ct.find((m) => m.id === id) ?? null;
    if ((a?.value ?? null) === null && (b?.value ?? null) === null) missing.push((a ?? b)!);
    else rows.push({ id, t: a, ct: b });
  }
  return { rows, missing };
}

// ---------------------------------------------------------------- personal bests

/** The bests the Records card leads with, in this order; every other best is in its full list. */
export const RECORD_LEAD = ["rating3", "kills", "adr", "dmg", "hsKills", "multiKillRounds", "clutchesWon", "openingKills"];

/** Bests split into the card's lead tiles (RECORD_LEAD order, the ones the engine returned) and the rest (by id). */
export function recordsOf<T extends { id: string }>(bests: T[]): { lead: T[]; rest: T[] } {
  const by = new Map(bests.map((b) => [b.id, b]));
  const lead = RECORD_LEAD.flatMap((id) => (by.has(id) ? [by.get(id)!] : []));
  const rest = bests.filter((b) => !RECORD_LEAD.includes(b.id)).sort((a, b) => a.id.localeCompare(b.id));
  return { lead, rest };
}
