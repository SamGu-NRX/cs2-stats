// Does a utility metric, summed per team-round, predict the round win beyond the economy?
//   pnpm utility-outcomes
// Logistic regression of the round win on one dummy per own-buy x opponent-buy cell (cells with 20+
// team-rounds), a CT dummy and the z-scored metric; standard errors clustered by map. Model B adds the
// team's grenades thrown, model C also both teams' seconds alive. Prints the odds ratio per SD with a
// 95% interval, and pairs of metrics correlated at |r| >= 0.6 per team-round. The four metrics pruned
// from the engine (utilDmg, enemiesFlashed, enemyBlindSecs, teamFlashed) are recomputed from the tables
// with their old definitions, so the reason for pruning them stays reproducible.
import { derive, hitDamage } from "../src/stats/derive";
import { isUtility } from "../src/stats/weapons";
import { loadDir, proMapDirs } from "./node-read";

type Row = Record<string, number | string | boolean | null>;
const SUM = ["flashKills", "flashAssists", "heDmg", "utilDmgTaken", "utilUnused", "smokes", "flashes", "hes", "molotovs", "aliveSecs"] as const;
const rows: Row[] = [];
let mi = 0;
for (const dir of proMapDirs()) {
  const t = await loadDir(dir, ["grenade_throws", "smokes", "engagements", "engagement_ticks"]);
  const f = derive(t);
  const vis = f.match.visibility === "ok";
  const team = new Map<string, Row>();
  const key = (ri: number, tm: number) => `${ri}:${tm}`;
  for (const r of f.pr) {
    let x = team.get(key(r.ri, r.team));
    if (!x) team.set(key(r.ri, r.team), (x = { map: mi, ri: r.ri, team: r.team, side: r.side, own: r.ownBuy, opp: r.oppBuy, won: r.won, sights: vis ? 0 : null, utilDmg: 0, enemiesFlashed: 0, enemyBlindSecs: 0, teamFlashed: 0, ...Object.fromEntries(SUM.map((k) => [k, 0])) }));
    for (const k of SUM) (x[k] as number) += r.m[k] ?? 0;
  }
  const teamOf = new Map(f.pr.map((r) => [`${r.ri}:${r.pi}`, r.team]));
  for (const q of f.utilq) { const x = team.get(key(q.ri, teamOf.get(`${q.ri}:${q.pi}`)!)); if (x && x.sights !== null) (x.sights as number) += q.sights; }
  // the pruned metrics, with the definitions they had in the engine
  const pi = new Map(f.players.map((p, i) => [p.id, i]));
  const ri = new Map(f.rounds.map((r) => [r.number, r.ri]));
  const add = (round: number, steamid: string | null, k: string, v: number) => {
    const r = ri.get(round), p = steamid === null ? undefined : pi.get(steamid);
    if (r === undefined || p === undefined) return;
    const x = team.get(key(r, teamOf.get(`${r}:${p}`) ?? -1));
    if (x) (x[k] as number) += v;
  };
  const d = t.damages;
  for (let i = 0; i < d.n; i++) if (d.attacker_steamid[i] !== null && !d.is_self[i] && !d.is_team_damage[i] && isUtility(d.weapon[i] ?? "")) add(d.round[i], d.attacker_steamid[i], "utilDmg", hitDamage(t, i));
  const b = t.blinds;
  for (let i = 0; i < b.n; i++) {
    if (b.duration[i] <= 1.1 || b.is_self[i]) continue;
    if (b.is_team_flash[i]) add(b.round[i], b.attacker_steamid[i], "teamFlashed", 1);
    else { add(b.round[i], b.attacker_steamid[i], "enemiesFlashed", 1); add(b.round[i], b.attacker_steamid[i], "enemyBlindSecs", b.duration[i]); }
  }
  rows.push(...team.values());
  mi++;
}
const all = rows.filter((r) => r.won !== null && r.own && r.opp);
const byKey = new Map(all.map((r) => [`${r.map}:${r.ri}:${r.team}`, r]));
for (const r of all) r.oppAlive = (byKey.get(`${r.map}:${r.ri}:${1 - (r.team as number)}`)?.aliveSecs as number) ?? 0;

const COUNTS = ["smokes", "flashes", "hes", "molotovs"];
const METRICS: [string, string][] = [
  ["flashKillsPR", "flashKills"], ["assistsPerFlash", "flashAssists"], ["dmgPerHe", "heDmg"], ["grenadeDmgTaken", "utilDmgTaken"],
  ["utilUnused", "utilUnused"], ["smokesPR", "smokes"], ["flashesPR", "flashes"], ["hesPR", "hes"], ["molotovsPR", "molotovs"],
  ["smokeSights", "sights"], ["utilDmgPR (pruned)", "utilDmg"], ["enemiesPerFlash (pruned)", "enemiesFlashed"],
  ["blindPerFlash (pruned)", "enemyBlindSecs"], ["teamFlashPR (pruned)", "teamFlashed"],
];

function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
    [M[i], M[p]] = [M[p], M[i]];
    for (let j = i + 1; j < n; j++) { const f = M[j][i] / M[i][i]; for (let k = i; k <= n; k++) M[j][k] -= f * M[i][k]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]; x[i] = s / M[i][i]; }
  return x;
}
const inverse = (A: number[][]) => {
  const cols = A.map((_, j) => solve(A, A.map((__, i) => +(i === j))));
  return A.map((_, i) => cols.map((c) => c[i]));
};
/** Logistic regression by Newton steps; sandwich standard errors clustered by `g`. */
function logit(X: number[][], y: number[], g: number[]) {
  const k = X[0].length;
  let b = new Array(k).fill(0);
  let H: number[][] = [];
  for (let it = 0; it < 30; it++) {
    H = Array.from({ length: k }, () => new Array(k).fill(0));
    const grad = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) {
      const p = 1 / (1 + Math.exp(-X[i].reduce((s, v, j) => s + v * b[j], 0))), w = p * (1 - p);
      for (let j = 0; j < k; j++) { grad[j] += X[i][j] * (y[i] - p); for (let l = 0; l < k; l++) H[j][l] += w * X[i][j] * X[i][l]; }
    }
    for (let j = 0; j < k; j++) H[j][j] += 1e-6;
    const step = solve(H, grad);
    b = b.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const Hi = inverse(H);
  const S = new Map<number, number[]>();
  for (let i = 0; i < X.length; i++) {
    const p = 1 / (1 + Math.exp(-X[i].reduce((s, v, j) => s + v * b[j], 0)));
    let s = S.get(g[i]);
    if (!s) S.set(g[i], (s = new Array(k).fill(0)));
    for (let j = 0; j < k; j++) s[j] += X[i][j] * (y[i] - p);
  }
  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  for (const s of S.values()) for (let j = 0; j < k; j++) for (let l = 0; l < k; l++) meat[j][l] += s[j] * s[l];
  const mul = (A: number[][], B: number[][]) => A.map((r) => B[0].map((_, l) => r.reduce((a, v, m) => a + v * B[m][l], 0)));
  const V = mul(mul(Hi, meat), Hi);
  const G = S.size;
  return { b, se: V.map((r, j) => Math.sqrt((r[j] * G) / (G - 1))) };
}
const z = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1; return xs.map((x) => (x - m) / sd); };
function fit(rs: Row[], feats: number[][]) {
  const cell = (r: Row) => `${r.own}|${r.opp}`;
  const cnt = new Map<string, number>();
  for (const r of rs) cnt.set(cell(r), (cnt.get(cell(r)) ?? 0) + 1);
  const cells = [...cnt].filter(([, n]) => n >= 20).map(([c]) => c).sort();
  const keep = rs.map((r) => cells.includes(cell(r)));
  const R = rs.filter((_, i) => keep[i]);
  const F = feats.map((f) => z(f.filter((_, i) => keep[i])));
  const X = R.map((r, i) => [...cells.map((c) => +(cell(r) === c)), +(r.side === "CT"), ...F.map((f) => f[i])]);
  const res = logit(X, R.map((r) => +(r.won as boolean)), R.map((r) => r.map as number));
  const j = cells.length + 1;
  return { n: R.length, b: res.b[j], se: res.se[j] };
}
const fmt = (o: { b: number; se: number }) => `${Math.exp(o.b).toFixed(2)} [${Math.exp(o.b - 1.96 * o.se).toFixed(2)}, ${Math.exp(o.b + 1.96 * o.se).toFixed(2)}]`;
const col = (rs: Row[], k: string) => rs.map((r) => r[k] as number);

console.log(`${all.length} team-rounds on ${mi} maps`);
console.log("metric".padEnd(26), "n".padStart(6), " buy+side".padEnd(20), " + thrown".padEnd(20), " + alive");
for (const [id, k] of METRICS) {
  const rs = all.filter((r) => r[k] !== null);
  const ctrl = COUNTS.filter((c) => c !== k);
  const a = fit(rs, [col(rs, k)]);
  const b = fit(rs, [col(rs, k), ...ctrl.map((c) => col(rs, c))]);
  const c = fit(rs, [col(rs, k), ...ctrl.map((cc) => col(rs, cc)), col(rs, "aliveSecs"), col(rs, "oppAlive")]);
  console.log(id.padEnd(26), String(a.n).padStart(6), " " + fmt(a).padEnd(19), " " + fmt(b).padEnd(19), " " + fmt(c));
}
console.log("\nteam-round pairs with |r| >= 0.6");
for (let i = 0; i < METRICS.length; i++) for (let j = i + 1; j < METRICS.length; j++) {
  const rs = all.filter((r) => r[METRICS[i][1]] !== null && r[METRICS[j][1]] !== null);
  const x = z(col(rs, METRICS[i][1])), y = z(col(rs, METRICS[j][1]));
  const r = x.reduce((a, v, n) => a + v * y[n], 0) / x.length;
  if (Math.abs(r) >= 0.6) console.log(`  ${METRICS[i][0]} ~ ${METRICS[j][0]}: ${r.toFixed(2)}`);
}
