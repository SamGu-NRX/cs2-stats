// Filters for the form chart.

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
