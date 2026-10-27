// Filters for the form chart: Home's Form and Profile's Form share them (formWindow), and the shared
// control (views/shared.tsx FormToggles) sets them.
import { matchDayKey } from "./format";

/** A match's day for the first-of-day filter (firstOfDay). */
export const formDay = (e: { file: string; match: { date: string | null; startedAt: string | null } }) => ({ file: e.file, date: matchDayKey(e.match) });

/** What the form chart leaves out. */
export interface FormFilter { noOutliers: boolean; noFirst: boolean }

/** Matches a form chart shows. */
export const FORM_WINDOW = 10;

/**
 * The form chart's matches, oldest first: the last FORM_WINDOW of a newest-first list, less the first
 * match of each day (firstOfDay over the whole list) when noFirst, then less the ratings outside
 * Tukey's fences (insideFences, over the rated matches left) when noOutliers. A match without a rating
 * is never an outlier. `hidden` is how many of the window the filters left out.
 */
export function formWindow<T>(newestFirst: T[], rating: (x: T) => number | null, dayOf: (x: T) => { file: string; date: string | null }, f: FormFilter): { shown: T[]; hidden: number } {
  const window = newestFirst.slice(0, FORM_WINDOW).reverse();
  const firsts = f.noFirst ? firstOfDay(newestFirst.map(dayOf)) : new Set<string>();
  const pool = window.filter((x) => !firsts.has(dayOf(x).file));
  let shown = pool;
  if (f.noOutliers) {
    const rated = pool.flatMap((x) => { const r = rating(x); return r === null ? [] : [{ x, r }]; });
    const keep = insideFences(rated.map((y) => y.r));
    const out = new Set(rated.filter((_, i) => !keep.has(i)).map((y) => y.x));
    shown = pool.filter((x) => !out.has(x));
  }
  return { shown, hidden: window.length - shown.length };
}

/**
 * Indexes of values inside Tukey's fences (1.5 × the interquartile range beyond the quartiles).
 * With fewer than four values nothing is called an outlier.
 */
export function insideFences(values: number[]): Set<number> {
  const keep = new Set(values.map((_, i) => i));
  if (values.length < 4) return keep;
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const x = (s.length - 1) * p;
    const lo = Math.floor(x);
    return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (x - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const k = 1.5 * (q3 - q1);
  values.forEach((v, i) => { if (v < q1 - k || v > q3 + k) keep.delete(i); });
  return keep;
}

/**
 * Files that were the first match of their day, from a newest-first list. Match facts carry the
 * day but no start time, so the order within a day is the list's (data/match.ts byNewest).
 */
export function firstOfDay(newestFirst: { file: string; date: string | null }[]): Set<string> {
  const first = new Map<string, string>();
  for (const m of newestFirst) if (m.date) first.set(m.date, m.file);
  return new Set(first.values());
}
