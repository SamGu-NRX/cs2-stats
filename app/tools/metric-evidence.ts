// Reliability and overlap evidence for the metrics-v2 metrics, measured on the engine's own
// definitions over the pro maps, the way the research measured its versions
// (cs2-stats-data/research/individual/analyze.py, research/team/analyze.py):
//   pnpm metric-evidence [--fit] [--out <path>]
//
// - Map split-half reliability: each player's per-map values (player-maps with MAP_MIN_ROUNDS+ rounds),
//   players with 4+ maps, the mean of the first half of their maps against the last half, Spearman's r,
//   then Spearman-Brown 2r / (1 + r).
// - Overlap: the largest |Spearman r| between the metric and the research's existing stats per
//   player-map (KPR, ADR, HS%, accuracy, swing, Rating 3.0, AWP share of kills).
// - Sample gates: for the sample-gated metrics, event-level split-half reliability at 10, 20, 40, ...
//   events (alternate events of a player's first n), and the smallest n reaching the 0.4 bar.
// - With --fit, writes src/stats/xduel-params.json (the expected-duel model, with its grouped five-fold
//   cross-validated AUC) and src/stats/aggression-scale.json (the pros' mean and spread of each
//   aggression part, over players with MIN_ROUNDS+ rounds). Both hold no names or ids.
// The report (no names or ids either) goes to <data>/derived/metric-evidence-v2.json by default.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aggroParts, AGGRO_PARTS, scoreOf, type AggroScale } from "../src/stats/aggro-scale";
import { XDUEL_FEATURES, type SightFact } from "../src/stats/aim";
import { derive } from "../src/stats/derive";
import type { MatchFacts } from "../src/stats/facts";
import { METRIC } from "../src/stats/metrics";
import { addMatch, emptySummary, rollup, type Summary } from "../src/stats/rollup";
import { auc, fitXDuel, xduelP, type XDuelParams } from "../src/stats/xduel";
import { DATA_DIR, MAP_MIN_ROUNDS, MIN_ROUNDS, mapLabel, proMaps, WINPROB } from "./node-read";

const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const FIT = process.argv.includes("--fit");
const OUT = path.resolve(arg("--out", path.join(DATA_DIR, "derived", "metric-evidence-v2.json")));
/** The coordinator's bar for usable reliability, and for overlap with existing stats. */
const RELIABLE = 0.4, OVERLAP = 0.5;
const BINS = [10, 20, 40, 80, 160, 320, 640];

// ---------------------------------------------------------------- statistics

function ranks(xs: number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    for (let t = i; t <= j; t++) r[idx[t]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 5) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}
/** Spearman's r over the pairs where both are known. */
function spearman(pairs: [number | null, number | null][]): number | null {
  const ok = pairs.filter((p): p is [number, number] => p[0] !== null && p[1] !== null && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return pearson(ranks(ok.map((p) => p[0])), ranks(ok.map((p) => p[1])));
}
const sb = (r: number | null) => (r === null || r <= -1 ? null : (2 * r) / (1 + r));
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const round3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

// ---------------------------------------------------------------- the candidates

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const registry = (id: string) => (s: Summary) => METRIC[id].value(s);

/** Candidates read straight from a player-map's summary, with the research key each is checked against. */
const DIRECT: Record<string, { value: (s: Summary) => number | null; research?: string }> = {
  shotSpeed: { value: registry("shotSpeed"), research: "analysis.json shot_speed" },
  timeToShot: { value: registry("timeToShot"), research: "analysis.json time_to_shot" },
  movingSpray: { value: registry("movingSpray"), research: "analysis.json moving_spray" },
  crosshairPlacement: { value: registry("crosshairPlacement"), research: "analysis.json preaim (median placement)" },
  preAim: { value: registry("preAim") },
  stopBuffer: { value: registry("stopBuffer"), research: "analysis.json stop_buffer" },
  shotError: { value: registry("shotError"), research: "analysis.json shot_error" },
  peekTravel: { value: registry("peekTravel"), research: "analysis.json peek_travel" },
  duelExposure: { value: registry("duelExposure"), research: "analysis.json exposure" },
  firedFirst: { value: registry("firedFirst"), research: "analysis.json fired_first" },
  engageDistance: { value: registry("engageDistance"), research: "analysis.json distance" },
  buyDeviation: { value: registry("buyDeviation"), research: "candidate_summary.json buy_deviation" },
  saveConversion: { value: (s) => per(s.m.saveCarrySum, s.m.saveCarryKnown), research: "candidate_summary.json save_conversion_proxy" },
  ecoFights: { value: (s) => pct(s.aggression.lowFights, s.aggression.lowVis) },
  ecoKills: { value: (s) => per(s.aggression.lowKills, s.aggression.lowPlayed) },
};

/** The research's existing stats, per player-map, for the overlap check. */
const EXISTING: Record<string, (s: Summary) => number | null> = {
  kpr: registry("kpr"), adr: registry("adr"), hs: registry("hs"), accuracy: registry("accuracy"),
  swing: registry("swing"), rating: registry("rating3"), awp_share: (s) => per(s.m.awpKills, s.m.kills),
};

// ---------------------------------------------------------------- the pass

/** One player-map: only the numbers the evidence needs, so the pass holds no summaries per map. */
interface MapPlayer {
  pid: string; map: number;
  v: Record<string, number | null>; existing: Record<string, number | null>; parts: (number | null)[]; entry: number | null;
  duels: { x: number[]; won: 0 | 1 }[];
}
const mapPlayers: MapPlayer[] = [];
const careers = new Map<string, Summary>();
/** per player, in match order: saved rounds' carried equipment, and settled duels with their features */
const saves = new Map<string, number[]>();
const duels = new Map<string, { x: number[]; won: 0 | 1; group: string }[]>();
const listOf = <T>(m: Map<string, T[]>, k: string) => m.get(k) ?? m.set(k, []).get(k)!;

let maps = 0;
for await (const { dir, t } of proMaps()) {
  const f: MatchFacts = derive(t, WINPROB);
  const group = mapLabel(dir).split("/")[0];
  for (const p of f.players) {
    if (p.bot) continue;
    const s = rollup([f], { player: p.id });
    const own = (f.aim.filter((a) => a.k === "sight" && f.players[a.pi].id === p.id && a.xf !== null && a.duelWon !== null) as SightFact[])
      .map((a) => ({ x: a.xf!, won: (a.duelWon ? 1 : 0) as 0 | 1 }));
    listOf(duels, p.id).push(...own.map((d) => ({ ...d, group })));
    for (const r of f.pr) if (f.players[r.pi].id === p.id && r.m.saveCarryKnown) listOf(saves, p.id).push(r.m.saveCarrySum ?? 0);
    addMatch(careers.get(p.id) ?? careers.set(p.id, emptySummary()).get(p.id)!, f, { player: p.id });
    if (s.m.rounds < MAP_MIN_ROUNDS) continue;
    mapPlayers.push({
      pid: p.id, map: maps, duels: own, parts: aggroParts(s), entry: METRIC.entryAttempts.value(s),
      v: Object.fromEntries(Object.entries(DIRECT).map(([id, c]) => [id, c.value(s)])),
      existing: Object.fromEntries(Object.entries(EXISTING).map(([k, g]) => [k, g(s)])),
    });
  }
  maps++;
  if (maps % 25 === 0) console.error(`${maps} maps, ${mapPlayers.length} player-maps, heap ${(process.memoryUsage().heapUsed / 2 ** 20).toFixed(0)} MB`);
}
console.error(`${maps} maps, ${mapPlayers.length} player-maps`);

// ---------------------------------------------------------------- the expected-duel model

const allDuels = [...duels.values()].flat();
const groups = [...new Set(allDuels.map((d) => d.group))];
const folds = 5;
const cv = new Array<number>(allDuels.length);
for (let k = 0; k < folds; k++) {
  // the research's split: groups in order, cut into five runs (numpy array_split)
  const lo = Math.floor((k * groups.length) / folds), hi = Math.floor(((k + 1) * groups.length) / folds);
  const held = new Set(groups.slice(lo, hi));
  const train = allDuels.filter((d) => !held.has(d.group));
  const fit = fitXDuel(train.map((d) => d.x), train.map((d) => d.won));
  allDuels.forEach((d, i) => { if (held.has(d.group)) cv[i] = xduelP(d.x, { ...fit, features: [...XDUEL_FEATURES] } as XDuelParams); });
}
const ys = allDuels.map((d) => d.won);
const xparams: XDuelParams = {
  features: [...XDUEL_FEATURES], ...fitXDuel(allDuels.map((d) => d.x), ys), n: allDuels.length,
  auc: round3(auc(cv, ys))!, brier: round3(mean(cv.map((p, i) => (p - ys[i]) ** 2)))!,
  source: `${maps} pro maps, ${allDuels.length} duels settled within 3 s of first sight; AUC and Brier from five-fold cross-validation grouped by match`,
};

// ---------------------------------------------------------------- the aggression scale

const pros = [...careers.values()].filter((s) => s.m.rounds >= MIN_ROUNDS).map(aggroParts).filter((v) => v.every((x) => x !== null)) as number[][];
const scale: AggroScale = {
  parts: [...AGGRO_PARTS],
  mean: AGGRO_PARTS.map((_, j) => mean(pros.map((v) => v[j]))),
  sd: AGGRO_PARTS.map((_, j) => { const m = mean(pros.map((v) => v[j])); return Math.sqrt(mean(pros.map((v) => (v[j] - m) ** 2))); }),
  players: pros.length,
  source: `${maps} pro maps, players with ${MIN_ROUNDS}+ rounds and all four parts`,
};

// ---------------------------------------------------------------- results

const fitted: Record<string, { value: (mp: MapPlayer) => number | null; research?: string }> = {
  aggressionScore: { value: (mp) => scoreOf(mp.parts, scale) },
  expectedDuel: { value: (mp) => (mp.duels.length ? 100 * mean(mp.duels.map((d) => xduelP(d.x, xparams))) : null), research: "analysis.json expected_duel" },
  duelsOverExpected: { value: (mp) => (mp.duels.length ? 100 * mean(mp.duels.map((d) => d.won - xduelP(d.x, xparams))) : null), research: "analysis.json execution_over_expected" },
};
const CANDIDATES = {
  ...Object.fromEntries(Object.entries(DIRECT).map(([id, c]) => [id, { value: (mp: MapPlayer) => mp.v[id], research: c.research }])),
  ...fitted,
};

function mapSplit(vals: { pid: string; map: number; v: number }[]) {
  const by = new Map<string, { map: number; v: number }[]>();
  for (const x of vals) (by.get(x.pid) ?? by.set(x.pid, []).get(x.pid)!).push(x);
  const halves: [number, number][] = [];
  for (const xs of by.values()) {
    if (xs.length < 4) continue;
    xs.sort((a, b) => a.map - b.map);
    const h = Math.floor(xs.length / 2);
    halves.push([mean(xs.slice(0, h).map((x) => x.v)), mean(xs.slice(-h).map((x) => x.v))]);
  }
  const r = spearman(halves);
  return { players: halves.length, r: round3(r), sb: round3(sb(r)) };
}

/** Event-level split-half at each bin: alternate events of each player's first n. */
function eventBins(events: Map<string, number[]>) {
  return BINS.map((n) => {
    const halves = [...events.values()].filter((e) => e.length >= n).map((e) => {
      const q = e.slice(0, n);
      return [mean(q.filter((_, i) => i % 2 === 0)), mean(q.filter((_, i) => i % 2 === 1))] as [number, number];
    });
    const r = halves.length >= 10 ? spearman(halves) : null;
    return { n, players: halves.length, r: round3(r), sb: round3(sb(r)) };
  });
}
/**
 * The sample a gated metric needs: the smallest measured size from which every larger measured size
 * reaches the bar (a single lucky bin does not count). When none does, the Spearman-Brown projection
 * from the largest measured size: reliability R at n events becomes kR / (1 + (k - 1)R) at kn.
 */
function gateOf(bins: ReturnType<typeof eventBins>): { n: number; how: "measured" | "projected" } | null {
  const measured = bins.filter((b) => b.sb !== null);
  for (let i = 0; i < measured.length; i++) if (measured.slice(i).every((b) => b.sb! >= RELIABLE)) return { n: measured[i].n, how: "measured" };
  const last = measured[measured.length - 1];
  if (!last || last.sb! <= 0) return null;
  const k = (RELIABLE * (1 - last.sb!)) / (last.sb! * (1 - RELIABLE));
  return { n: Math.ceil(k * last.n), how: "projected" };
}

const entry = mapPlayers.map((mp) => mp.entry);
const results = Object.entries(CANDIDATES).map(([id, c]) => {
  const v = mapPlayers.map((mp) => c.value(mp));
  const corrs = Object.fromEntries(Object.keys(EXISTING).map((k) => [k, round3(spearman(mapPlayers.map((mp, i) => [v[i], mp.existing[k]])))]));
  const known = Object.values(corrs).filter((x): x is number => x !== null);
  const maxAbs = known.length ? Math.max(...known.map(Math.abs)) : null;
  const split = mapSplit(mapPlayers.flatMap((mp, i) => (v[i] === null ? [] : [{ pid: mp.pid, map: mp.map, v: v[i]! }])));
  return {
    id, research: (c as { research?: string }).research ?? null, playerMaps: v.filter((x) => x !== null).length, mapSplit: split, maxAbsExisting: round3(maxAbs), corrs,
    withEntryAttempts: round3(spearman(mapPlayers.map((_, i) => [v[i], entry[i]]))),
    passes: split.sb !== null && split.sb >= RELIABLE && maxAbs !== null && maxAbs < OVERLAP,
  };
});

const saveBins = eventBins(saves);
const duelOver = new Map([...duels].map(([pid, d]) => [pid, d.map((x) => x.won - xduelP(x.x, xparams))]));
const duelExp = new Map([...duels].map(([pid, d]) => [pid, d.map((x) => xduelP(x.x, xparams))]));
const gates = {
  saveConversion: { unit: "saved rounds", bins: saveBins, gate: gateOf(saveBins) },
  expectedDuel: { unit: "duels", bins: eventBins(duelExp), gate: gateOf(eventBins(duelExp)) },
  duelsOverExpected: { unit: "duels", bins: eventBins(duelOver), gate: gateOf(eventBins(duelOver)) },
};

const report = { built: new Date().toISOString().slice(0, 10), maps, playerMaps: mapPlayers.length, bar: { reliable: RELIABLE, overlap: OVERLAP }, xduel: { n: xparams.n, auc: xparams.auc, brier: xparams.brier }, aggressionScale: scale, results, gates };
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
if (FIT) {
  const here = path.resolve(import.meta.dirname, "../src/stats");
  writeFileSync(path.join(here, "xduel-params.json"), `${JSON.stringify(xparams, null, 2)}\n`);
  writeFileSync(path.join(here, "aggression-scale.json"), `${JSON.stringify(scale, null, 2)}\n`);
}

console.log(`xduel: ${xparams.n} duels, cross-validated AUC ${xparams.auc}, Brier ${xparams.brier}`);
console.log(`aggression scale: ${scale.players} players; mean ${scale.mean.map((x) => x.toFixed(3))}; sd ${scale.sd.map((x) => x.toFixed(3))}`);
console.log("id | player-maps | map-split players | r | SB | max |r| existing | r with entryAttempts | passes");
for (const r of results) console.log([r.id, r.playerMaps, r.mapSplit.players, r.mapSplit.r, r.mapSplit.sb, r.maxAbsExisting, r.withEntryAttempts, r.passes].join(" | "));
for (const [id, g] of Object.entries(gates)) console.log(`${id}: gate ${g.gate ? `${g.gate.n} ${g.unit} (${g.gate.how})` : "none"}; bins ${g.bins.map((b) => `${b.n}:${b.players}p sb ${b.sb}`).join(", ")}`);
console.log(`report: ${OUT}`);
