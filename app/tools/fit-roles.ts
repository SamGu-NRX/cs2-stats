// pnpm fit-roles <Packer CSV> [--cache-write <private JSON> | --cache-read <private JSON>] [--report <JSON>]
// Caches hold only input summaries, not fits or labels. Explicit reuse avoids re-reading parquet.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { derive } from "../src/stats/derive";
import { DERIVE_VERSION } from "../src/stats/facts";
import { roleBlend, type RoleModel } from "../src/stats/identity";
import { addMatch, emptySummary, rollup, type Summary } from "../src/stats/rollup";
import { seededStratifiedSplit, teamGroupedSplit } from "../src/stats/role-validation";
import { evaluateRoleRows, evaluationLabel, fitRoleThresholds, parseRoleCsv, reliabilityTable, trainRoleModel, type RoleEvaluation, type RoleRow, type RoleSide, type RoleSummaries } from "../src/stats/role-training";
import { ROLE_THRESHOLDS } from "../src/stats/role-thresholds";
import { WINPROB, proMaps } from "./node-read";
import { checkOutput, writeOutput, type OutputKind } from "./outputs";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const csv = process.argv[2];
if (!csv) throw new Error("usage: pnpm fit-roles <Packer CSV> [--cache-write file | --cache-read file] [--report file]");
const csvText = readFileSync(csv, "utf8");
const rows = parseRoleCsv(csvText);
const csvHash = createHash("sha256").update(csvText).digest("hex");
const sides = ["T", "CT"] as const;

interface CorpusCache {
  deriveVersion: number;
  maps: number;
  summaries: [string, Partial<Record<RoleSide, Summary>>][];
  metrics: Record<string, number[]>;
}
let corpus: CorpusCache;
const cacheRead = arg("--cache-read"), cacheWrite = arg("--cache-write");
// The cache holds each labelled pro's summaries by steamid, and the report their labels and teams: both
// private. The fitted model reads six role features (identity.ts FEATURES), none of them swing or
// rating, and holds no ids, so it is public and lives in the repository.
const PRIVATE: OutputKind = { private: true, what: "the role corpus cache or report (pro ids and labels)" };
const MODEL_OUT = path.resolve(import.meta.dirname, "../src/stats/roles-params.json");
const MODEL: OutputKind = { private: false, what: "roles-params.json", inRepo: MODEL_OUT };
for (const f of [cacheWrite, arg("--report")]) if (f) checkOutput(path.resolve(f), PRIVATE);
if (cacheRead) {
  corpus = JSON.parse(readFileSync(cacheRead, "utf8"));
  if (corpus.deriveVersion !== DERIVE_VERSION || !corpus.maps || !Array.isArray(corpus.summaries) || !corpus.metrics) throw new Error("Role cache has incompatible derive version or missing corpus data");
} else {
  const summaries: RoleSummaries = new Map();
  const metrics: Record<string, number[]> = {};
  let maps = 0;
  for await (const { t } of proMaps()) {
    const fact = derive(t, WINPROB);
    maps++;
    for (const player of fact.players) {
      let pair = summaries.get(player.id);
      if (!pair) summaries.set(player.id, pair = {});
      for (const side of sides) {
        const summary = pair[side] ??= emptySummary();
        addMatch(summary, fact, { player: player.id, sides: [side] });
        // Roles do not read these large arrays. Keep raw measures, aggression and place totals.
        summary.aim = emptySummary().aim;
        summary.movement = emptySummary().movement;
        for (const presence of Object.values(summary.presence)) presence.cells = {};
        const perMap = rollup([fact], { player: player.id, sides: [side] });
        if (perMap.m.rounds < 16) continue;
        for (const metric of roleBlend(perMap, side).metrics) if (metric.value !== null) (metrics[metric.id] ??= []).push(metric.value);
      }
    }
    if (maps % 50 === 0) console.error(`Derived ${maps} pro maps`);
  }
  if (!maps) throw new Error("No pro maps found; cannot evaluate roleBlend from Packer features alone");
  corpus = { deriveVersion: DERIVE_VERSION, maps, summaries: [...summaries], metrics };
  if (cacheWrite) writeOutput(path.resolve(cacheWrite), JSON.stringify(corpus), PRIVATE);
}
const summaries: RoleSummaries = new Map(corpus.summaries);
function quantile(values: number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p, lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
const quantiles = Object.fromEntries(Object.entries(corpus.metrics).map(([id, values]) => [id, { n: values.length, q10: quantile(values, 0.1), q50: quantile(values, 0.5), q90: quantile(values, 0.9) }]));
const distance = corpus.metrics.teamDistance ?? [];
const distanceCheck = { n: distance.length, above1100: distance.filter((v) => v >= 1100).length, measure: "3D Source units, positioning.ts Math.hypot(dx,dy,dz)" };
console.log(`Loaded ${corpus.maps} maps, ${summaries.size} unique pro careers; CSV sha256 ${csvHash}`);
console.log(`pro-corpus role quantiles ${JSON.stringify(quantiles)}`);
console.log(`Lurker threshold check ${JSON.stringify(distanceCheck)}`);

const range = (data: readonly RoleRow[]) => {
  const counts = data.map((row) => Number(row.map_count));
  return counts.length ? [Math.min(...counts), Math.max(...counts)] : null;
};
function report(side: RoleSide, name: string, result: RoleEvaluation, train: readonly RoleRow[], held: readonly RoleRow[]) {
  const pct = (n: number, d: number) => d ? (100 * n / d).toFixed(1) : "n/a";
  console.log(`${side} ${name}: top1 ${result.top1Correct}/${result.total} (${pct(result.top1Correct, result.total)}%); single correct ${result.singleCorrect}/${result.single} (${pct(result.singleCorrect, result.single)}%); returned set ${result.setCorrect}/${result.total}; single ${result.single}/${result.total}; top2 ${result.topTwo}/${result.total}; insufficient ${result.insufficient}`);
  console.log(`${side} ${name}: confusion ${JSON.stringify(result.confusion)}; decisions ${JSON.stringify(result.decisions)}`);
  console.log(`${side} ${name}: reliability ${JSON.stringify(reliabilityTable(result.reliability))}`);
  const mappedTrain = train.filter((row) => { const label = evaluationLabel(row, side); return label && label !== "AWPer"; });
  const calibrationTrain = mappedTrain.filter((row) => summaries.get(row.steamid)?.[side]?.m.rounds);
  console.log(`${side} ${name}: mapped train maps ${JSON.stringify(range(mappedTrain))}; calibration train maps ${JSON.stringify(range(calibrationTrain))}; held maps ${JSON.stringify(range(held))}`);
  return { ...result, reliabilityBins: reliabilityTable(result.reliability), trainMapRange: range(mappedTrain), calibrationTrainMapRange: range(calibrationTrain), holdoutMapRange: range(held), trainingPlayers: mappedTrain.length, holdoutPlayers: held.length };
}

const results: Record<string, unknown> = {};
// Each outer fold excludes the player from both Gaussian training and inner-LOO isotonic fitting.
const looModels = new Map<string, RoleModel>();
for (const row of rows) if (sides.some((side) => evaluationLabel(row, side) && summaries.get(row.steamid)?.[side]?.m.rounds)) {
  const foldRows = rows.filter((r) => r.steamid !== row.steamid);
  looModels.set(row.steamid, trainRoleModel(foldRows, summaries, undefined, fitRoleThresholds(foldRows, summaries)));
}
const finalModel = trainRoleModel(rows, summaries, undefined, ROLE_THRESHOLDS);
for (const side of sides) {
  const eligible = rows.filter((row) => evaluationLabel(row, side) && summaries.get(row.steamid)?.[side]?.m.rounds);
  const loo = evaluateRoleRows(side, rows, summaries, (row) => looModels.get(row.steamid)!);
  const strat = seededStratifiedSplit(eligible, (row) => evaluationLabel(row, side), 0x5EED);
  const stratIds = new Set(strat.holdout.map((row) => row.steamid));
  const stratTrain = rows.filter((row) => !stratIds.has(row.steamid));
  const stratModel = trainRoleModel(stratTrain, summaries, undefined, fitRoleThresholds(stratTrain, summaries));
  const team = teamGroupedSplit(eligible, (row) => evaluationLabel(row, side), 0xC0DE);
  const teamNames = new Set(team.holdout.map((row) => row.team_clan_name));
  const teamTrain = rows.filter((row) => !teamNames.has(row.team_clan_name));
  const teamModel = trainRoleModel(teamTrain, summaries, undefined, fitRoleThresholds(teamTrain, summaries));
  // Retain the old tail split as a covariate-shift diagnostic, never the headline holdout.
  const legacy = rows.filter((row) => evaluationLabel(row, side) && evaluationLabel(row, side) !== "AWPer");
  const nTail = Math.floor(legacy.length * 0.2), tail = legacy.slice(-nTail);
  const tailIds = new Set(tail.map((row) => row.steamid));
  const tailTrain = rows.filter((row) => !tailIds.has(row.steamid));
  const tailModel = trainRoleModel(tailTrain, summaries, undefined, fitRoleThresholds(tailTrain, summaries));
  results[side] = {
    loo: {
      ...report(side, "LOO training pool", loo, rows, eligible),
      // LOO has no single training partition. Record each actual fold as well as the pool range.
      folds: eligible.map((held) => {
        const train = rows.filter((r) => r.steamid !== held.steamid && evaluationLabel(r, side) && evaluationLabel(r, side) !== "AWPer");
        return { heldSteamid: held.steamid, trainingPlayers: train.length, trainMapRange: range(train), holdoutMapRange: range([held]) };
      }),
    },
    stratified: report(side, "stratified", evaluateRoleRows(side, strat.holdout, summaries, () => stratModel), stratTrain, strat.holdout),
    team: report(side, "team", evaluateRoleRows(side, team.holdout, summaries, () => teamModel), teamTrain, team.holdout),
    tail: report(side, "legacy tail", evaluateRoleRows(side, tail, summaries, () => tailModel), legacy.slice(0, -nTail), tail),
    production: report(side, "production", evaluateRoleRows(side, rows, summaries, () => finalModel), rows, eligible),
    teamHoldout: [...teamNames].sort(),
  };
}
writeOutput(MODEL_OUT, JSON.stringify(finalModel, null, 1) + "\n", MODEL);
const reportFile = arg("--report");
if (reportFile) writeOutput(path.resolve(reportFile), JSON.stringify({ maps: corpus.maps, csvHash, quantiles, distanceCheck, results }, null, 2) + "\n", PRIVATE);
console.log(`wrote ${MODEL_OUT}`);
