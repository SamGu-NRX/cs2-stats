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

/** Files that were the first match of their local calendar day. */
export function firstOfDay(list: { file: string; startUtc: string }[]): Set<string> {
  const firstByDay = new Map<string, { file: string; t: number }>();
  for (const m of list) {
    const d = new Date(m.startUtc);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const t = d.getTime();
    const cur = firstByDay.get(day);
    if (!cur || t < cur.t) firstByDay.set(day, { file: m.file, t });
  }
  return new Set([...firstByDay.values()].map((x) => x.file));
}
