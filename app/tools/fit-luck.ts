// Fits luck.ts HIT_AREA_SCALE and CALIBRATION on the pro maps and checks them:
//   pnpm fit-luck
// The scale shrinks or grows the target box so that, over the even-numbered maps, the summed geometric
// hit chances of the shots at a visible enemy equal their hits (bisection; the chance grows with the
// scale). The calibration is then a one-feature logistic regression of hit on the geometric chance's
// log-odds over the same maps (xduel.ts fitXDuel, no ridge). The odd-numbered maps check both: hits
// against expected hits overall, and per band of predicted chance. Prints numbers only; it writes nothing.
import { contextOf } from "../src/stats/derive";
import { calibrated, CALIBRATION, CHANCE_FLOOR, hitChance, HIT_AREA_SCALE, projectBox, shotChances, type ShotChance } from "../src/stats/luck";
import { fitXDuel } from "../src/stats/xduel";
import { proMaps } from "./node-read";

/** Shots the bisection sums over: every n-th fitting shot, which keeps each step a few seconds. */
const FIT_EVERY = 5;

const fit: ShotChance[] = [], check: ShotChance[] = [];
let maps = 0;
for await (const { t } of proMaps()) {
  const found = shotChances(contextOf(t));
  const shots = found ? found.shots.filter((x) => found.covered.has(x.ri)) : [];
  (maps % 2 === 0 ? fit : check).push(...shots);
  maps++;
  if (maps % 50 === 0) console.error(`${maps} maps`);
}
const chance = (x: ShotChance, k: number) => { const box = projectBox(x.g, k); return box ? hitChance(x.inaccuracy, x.spread, box) : 0; };
const sum = (xs: ShotChance[], k: number) => xs.reduce((a, x) => a + chance(x, k), 0);
const hits = (xs: ShotChance[]) => xs.reduce((a, x) => a + x.hit, 0);

const sample = fit.filter((_, i) => i % FIT_EVERY === 0);
const target = hits(sample);
let lo = 0.1, hi = 2;
for (let it = 0; it < 14; it++) {
  const mid = (lo + hi) / 2;
  if (sum(sample, mid) < target) lo = mid; else hi = mid;
}
const k = Math.round(((lo + hi) / 2) * 1000) / 1000;

// the calibration over every fitting shot's geometric chance
const logit = (p: number) => { const q = Math.min(1 - CHANCE_FLOOR, Math.max(CHANCE_FLOOR, p)); return Math.log(q / (1 - q)); };
const fitP = fit.map((x) => chance(x, k));
const lr = fitXDuel(fitP.map((p) => [logit(p)]), fit.map((x) => x.hit), 0);
const cal = { a: Math.round((lr.w[0] - (lr.w[1] * lr.mean[0]) / lr.sd[0]) * 1000) / 1000, b: Math.round((lr.w[1] / lr.sd[0]) * 1000) / 1000 };
const final = (x: ShotChance) => calibrated(chance(x, k), cal);

console.log(`${maps} pro maps: ${fit.length} fitting shots (every ${FIT_EVERY}th used for the scale, ${sample.length}) and ${check.length} checking shots at a visible enemy`);
console.log(`fitted HIT_AREA_SCALE ${k} (shipped ${HIT_AREA_SCALE}); CALIBRATION ${JSON.stringify(cal)} (shipped ${JSON.stringify(CALIBRATION)})`);
for (const [label, xs] of [["fitting maps", fit], ["checking maps", check]] as const) {
  const e = xs.reduce((a, x) => a + final(x), 0), h = hits(xs);
  console.log(`${label}: hits ${h}, expected ${e.toFixed(1)}, hits / expected ${(h / e).toFixed(3)}`);
}
for (const [label, p] of [["geometric", (x: ShotChance) => chance(x, k)], ["calibrated", final]] as const) {
  console.log(`checking maps by ${label} chance: band | shots | mean chance | hit rate`);
  const bands = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0001];
  const scored = check.map((x) => [p(x), x.hit] as const);
  for (let b = 0; b + 1 < bands.length; b++) {
    const xs = scored.filter(([q]) => q >= bands[b] && q < bands[b + 1]);
    if (!xs.length) continue;
    const mp = xs.reduce((a, [q]) => a + q, 0) / xs.length, hr = xs.reduce((a, [, h]) => a + h, 0) / xs.length;
    console.log(`${bands[b].toFixed(2)}-${Math.min(1, bands[b + 1]).toFixed(2)} | ${xs.length} | ${mp.toFixed(3)} | ${hr.toFixed(3)}`);
  }
}
