// Good-versus-bad colour, used wherever the sign of a number is a judgement: swing, rating, verdict
// bars, inspector cells. One diverging scale, restrained: a neutral middle and a muted green and red
// at the ends, so a small positive swing reads as "slightly good" rather than as an alarm.
//
// Score t runs from −1 (bad) to +1 (good). Callers map their metric onto t with a cap (`toScore`).

type RGB = [number, number, number];

// Text colours from the shell spec (design/shell-and-motion.md): --poor-text #F67F74, --ink #E6E2DC
// as the neutral, --good-text #2DBA2A. Both ends pass 4.5:1 on --bg1 (#242220): 6.4:1 and 6.1:1.
const POOR_TEXT: RGB = [246, 127, 116];
const NEUTRAL_TEXT: RGB = [230, 226, 220];
const GOOD_TEXT: RGB = [45, 186, 42];
// Fill colours for tints and bars: --good #11960E and --poor #E83128, the HLTV card's own.
const GOOD_FILL: RGB = [17, 150, 14];
const POOR_FILL: RGB = [232, 49, 40];

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mix = (a: RGB, b: RGB, f: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * f)) as RGB;
const css = ([r, g, b]: RGB) => `rgb(${r} ${g} ${b})`;

/**
 * Maps a value onto −1..1. `mid` is the neutral point and `span` the distance from it that reads as
 * fully good or bad; past that the score is capped. Lower-is-better metrics pass `lowerIsBetter`.
 */
export function toScore(v: number, mid: number, span: number, lowerIsBetter = false): number {
  if (!Number.isFinite(v) || span <= 0) return 0;
  const t = clamp((v - mid) / span, -1, 1);
  return lowerIsBetter ? -t : t;
}

/**
 * Text colour for a score. Values inside the dead zone stay neutral; beyond it the colour eases
 * toward the end so that only clear differences carry strong colour.
 */
export function scoreText(t: number, deadZone = 0.08): string {
  const a = Math.abs(clamp(t, -1, 1));
  if (a <= deadZone) return css(NEUTRAL_TEXT);
  const f = Math.min(1, (a - deadZone) / (1 - deadZone));
  // ease-out so mid-sized differences are already legible
  const e = 1 - (1 - f) * (1 - f);
  return css(mix(NEUTRAL_TEXT, t > 0 ? GOOD_TEXT : POOR_TEXT, e));
}

/** Background tint for a score: transparent at 0, at most `maxAlpha` at ±1. */
export function scoreTint(t: number, maxAlpha = 0.42): string {
  const c = clamp(t, -1, 1);
  if (c === 0) return "transparent";
  const [r, g, b] = c > 0 ? GOOD_FILL : POOR_FILL;
  const alpha = Math.round((0.06 + (maxAlpha - 0.06) * Math.abs(c)) * 1000) / 1000;
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

/** Solid fill for bars: verdict segments, diverging bars. */
export const scoreFill = (t: number) => (t >= 0 ? css(GOOD_FILL) : css(POOR_FILL));

// Per-metric neutral points and spans. The neutral points are HLTV-style averages (rating 1.00,
// swing 0); the spans are chosen by hand so that a clearly strong game saturates. There is no
// calibration study behind them.
export const SCALES = {
  rating: { mid: 1.0, span: 0.35 },
  /** match-level swing per round, as a fraction */
  swing: { mid: 0, span: 0.04 },
  /** one player's swing in one round, as a fraction */
  roundSwing: { mid: 0, span: 0.25 },
  diff: { mid: 0, span: 8 },
} as const;

export const ratingScore = (r: number) => toScore(r, SCALES.rating.mid, SCALES.rating.span);
export const swingScore = (s: number) => toScore(s, SCALES.swing.mid, SCALES.swing.span);
export const roundSwingScore = (s: number) => toScore(s, SCALES.roundSwing.mid, SCALES.roundSwing.span);
export const diffScore = (d: number) => toScore(d, SCALES.diff.mid, SCALES.diff.span);

/** Text colour for a rating that may be missing (no colour then). */
export const ratingText = (r: number | null | undefined) => (r === null || r === undefined ? undefined : scoreText(ratingScore(r)));
