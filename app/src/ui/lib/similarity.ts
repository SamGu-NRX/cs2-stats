// Similar players. The user's attribute scores are ranked against bots and a pro's against pros,
// so absolute values are not comparable; what can be compared is the shape of the profile. The
// match is the Pearson correlation of the seven scores, shown as 50 + 50·r: 100 % is the same
// shape, 50 % unrelated, 0 % the opposite.

export function correlation(a: readonly (number | null)[], b: readonly (number | null)[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export const similarityPct = (r: number) => Math.round(50 + 50 * r);

export interface Ranked<T> { item: T; r: number; pct: number }

/** Items ranked by shape similarity to `you`, best first; items without enough scores are dropped. */
export function rankSimilar<T>(you: readonly (number | null)[], items: readonly T[], scores: (t: T) => readonly (number | null)[]): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const r = correlation(you, scores(item));
    if (r !== null) out.push({ item, r, pct: similarityPct(r) });
  }
  return out.sort((x, y) => y.r - x.r);
}

