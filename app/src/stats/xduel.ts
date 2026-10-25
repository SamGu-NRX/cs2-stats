// Expected duel: the chance the player wins a duel given its context at first sight, from a logistic
// model over the research's nine features, fitted on the pro maps by `pnpm metric-evidence --fit`.
// The research fitted the same model (analysis.json xduel: AUC 0.69); ours scores 0.68 (xduel-params.json).
import type { Metric } from "./metrics";
import params from "./xduel-params.json";

/**
 * The model's inputs, measured at a sighting's onset (aim.ts SightFact.xf): placement (deg), horizontal
 * distance, your speed and his, your health and his (each from the latest 4 Hz position sample no older
 * than aim.ts HEALTH_MAX_AGE_S), your side's living players minus his, seconds since freeze end, and the
 * pitch part of the aim error (deg, absolute).
 */
export const XDUEL_FEATURES = ["placement", "distance", "speed", "enemySpeed", "health", "enemyHealth", "aliveDiff", "roundTime", "verticalAbs"] as const;

export interface XDuelParams {
  features: string[];
  /** per feature: the mean and standard deviation the inputs are scaled by */
  mean: number[];
  sd: number[];
  /** intercept, then one weight per scaled feature */
  w: number[];
  /** duels fitted on, and the grouped five-fold cross-validated AUC and Brier score */
  n: number;
  auc: number;
  brier: number;
  source: string;
}

/** The research's ridge penalty on the scaled weights (analyze.py fit_logistic). */
export const XDUEL_RIDGE = 1e-3;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** P(win) for one duel's features (XDUEL_FEATURES order). */
export function xduelP(x: number[], p: XDuelParams): number {
  let z = p.w[0];
  for (let j = 0; j < x.length; j++) z += (p.w[j + 1] * (x[j] - p.mean[j])) / p.sd[j];
  return sigmoid(z);
}

/** Throws unless the parameters were fitted on XDUEL_FEATURES in that order. */
export function checkXDuel(p: XDuelParams): XDuelParams {
  if (p.features.join() !== XDUEL_FEATURES.join()) throw new Error(`xduel parameters are for [${p.features}], the engine measures [${XDUEL_FEATURES}]`);
  return p;
}

/** The shipped fit. */
export const XDUEL = checkXDuel(params);

/**
 * Fits the model: features scaled to mean 0 and standard deviation 1 (a constant feature keeps sd 1),
 * then Newton's method on the mean log loss plus `ridge` times the squared weights, intercept free.
 */
export function fitXDuel(xs: number[][], ys: (0 | 1)[], ridge = XDUEL_RIDGE): Pick<XDuelParams, "mean" | "sd" | "w"> {
  const n = xs.length, k = xs[0].length;
  const mean = Array.from({ length: k }, (_, j) => xs.reduce((a, x) => a + x[j], 0) / n);
  const sd = mean.map((m, j) => { const s = Math.sqrt(xs.reduce((a, x) => a + (x[j] - m) ** 2, 0) / n); return s < 1e-8 ? 1 : s; });
  const z = xs.map((x) => [1, ...x.map((v, j) => (v - mean[j]) / sd[j])]);
  const w = new Array(k + 1).fill(0);
  for (let it = 0; it < 50; it++) {
    const g = new Array(k + 1).fill(0);
    const H = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const p = sigmoid(z[i].reduce((a, v, j) => a + v * w[j], 0));
      const r = p - ys[i], q = p * (1 - p);
      for (let a = 0; a <= k; a++) {
        g[a] += (r * z[i][a]) / n;
        for (let b = 0; b <= k; b++) H[a][b] += (q * z[i][a] * z[i][b]) / n;
      }
    }
    for (let a = 1; a <= k; a++) { g[a] += 2 * ridge * w[a]; H[a][a] += 2 * ridge; }
    const step = solve(H, g);
    for (let a = 0; a <= k; a++) w[a] -= step[a];
    if (Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  return { mean, sd, w };
}

/** Solves A x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) throw new Error("fitXDuel: the features are collinear");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Area under the ROC curve of scores against 0/1 labels, ties counting half. */
export function auc(scores: number[], ys: (0 | 1)[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSum = 0, pos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let t = i; t <= j; t++) if (ys[idx[t]] === 1) { rankSum += rank; pos++; }
    i = j + 1;
  }
  const neg = ys.length - pos;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// ---- metrics

/**
 * Settled duels the two metrics need before they show a value; the coordinator's bar is a reliability of
 * 0.4. On the pro maps (pnpm metric-evidence) the expected chance's alternate-duel split-half reliability
 * is 0.47 at 80 duels and stays above 0.4 at every larger size measured (0.51 at 160, 0.74 at 320); it
 * dips to 0.39 at 40. Duels over expected never reaches 0.4 in the data (0.33 at 320 duels, 81 players),
 * so its gate is the Spearman-Brown projection of that figure to 0.4: 442 duels.
 */
export const EXPECTED_DUEL_MIN = 80;
export const OVER_EXPECTED_MIN = 442;

const tooFew = (min: number) => (s: { aim: { xN: number } }) => (s.aim.xN < min ? `${s.aim.xN} of the ${min} settled duels it needs` : null);

export const DUEL_METRICS: Metric[] = [
  { id: "expectedDuel", label: "Expected duel win", kind: "identity", group: "duels", unit: "pct", status: "approx", needs: ["sight"],
    def: "Your average chance of winning your duels, given their context.",
    value: (s) => (s.aim.xN >= EXPECTED_DUEL_MIN ? (100 * s.aim.xExp) / s.aim.xN : null), why: tooFew(EXPECTED_DUEL_MIN),
    sample: { n: (s) => s.aim.xN, unit: "settled duels", min: EXPECTED_DUEL_MIN } },
  { id: "duelsOverExpected", label: "Duels won over expected", kind: "performance", group: "duels", unit: "pct", status: "approx", needs: ["sight"],
    def: "Duels you won beyond what their context predicted, in percentage points.",
    value: (s) => (s.aim.xN >= OVER_EXPECTED_MIN ? (100 * (s.aim.xWins - s.aim.xExp)) / s.aim.xN : null), why: tooFew(OVER_EXPECTED_MIN),
    sample: { n: (s) => s.aim.xN, unit: "settled duels", min: OVER_EXPECTED_MIN } },
];
