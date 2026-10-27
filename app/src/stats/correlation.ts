// What a view needs to show a correlation with winning honestly, kept apart from trends.ts so the
// UI can import it without the rollup: the sample a view requires, the band chance correlations fall
// in, and the won and lost means a point-biserial r compares.

/**
 * Decided matches a correlation with winning needs before a view shows it. winCorrelationOf answers
 * from 3, where r swings by chance from -1 to 1. Ours, no fit: at 10 the band of chance correlations
 * (noiseBand) is still ±0.63, so this only keeps the emptiest samples off the screen.
 */
export const WIN_CORRELATION_MIN = 10;

/**
 * The |r| that n uncorrelated pairs exceed by chance 5% of the time, two-sided, from Fisher's z
 * transform: tanh(1.96 / sqrt(n - 3)). An r inside ±band is indistinguishable from no relation at that
 * sample size. Null under 4 pairs, where the transform has no spread.
 */
export function noiseBand(n: number): number | null {
  return n < 4 ? null : Math.tanh(1.959964 / Math.sqrt(n - 3));
}

/** The metric's mean per match over the won and the lost matches (the two groups a point-biserial r compares); null for an empty group. */
export function winLossMeans(points: { value: number | null; won: boolean | null }[]): { won: number | null; lost: number | null } {
  const mean = (won: boolean) => {
    const xs = points.filter((p) => p.won === won && p.value !== null).map((p) => p.value!);
    return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  };
  return { won: mean(true), lost: mean(false) };
}
