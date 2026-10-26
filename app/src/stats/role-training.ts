// Offline fitting and evaluation. The worker imports identity.ts, never this module.
import { FEATURES, mapRoleName, roleBlend, type CalibrationPoint, type Feature, type RoleModel, type RoleName } from "./identity";
import { assertUniqueSteamids, type RoleSplitRow } from "./role-validation";
import type { Summary } from "./rollup";

export type RoleSide = "T" | "CT";
export type RoleRow = Record<string, string> & RoleSplitRow;
export type RoleSummaries = Map<string, Partial<Record<RoleSide, Summary>>>;
const COL: Record<Feature, string> = { tapd: "tapd", oap: "oap", podt: "podt", pokt: "pokt", adnt: "adnt_rank", adat: "adat_rank" };
const MAPPED = { T: ["Entry", "Lurker"], CT: ["Anchor", "Rotator"] } as const;

export const evaluationLabel = (row: RoleRow, side: RoleSide) => mapRoleName(row[`role_${side.toLowerCase()}`]);

export function parseRoleCsv(text: string): RoleRow[] {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(",");
  const required = ["steamid", "team_clan_name", "map_count", "role_t", "role_ct", ...FEATURES.flatMap((f) => [`${COL[f]}_t`, `${COL[f]}_ct`])];
  for (const col of required) if (!columns.includes(col)) throw new Error(`Role CSV is missing column ${col}`);
  // This public CSV has no quoted fields. Reject rather than silently misparse another format.
  const rows = lines.filter((line) => line.trim()).map((line, i) => {
    const cells = line.split(",");
    if (line.includes('"') || cells.length !== columns.length) throw new Error(`Unsupported role CSV row ${i + 2}`);
    const row = Object.fromEntries(cells.map((value, j) => [columns[j], value])) as RoleRow;
    for (const col of required.filter((col) => !["steamid", "team_clan_name", "role_t", "role_ct"].includes(col))) {
      if (!row[col].trim() || !Number.isFinite(Number(row[col]))) throw new Error(`Invalid ${col} for steamid ${row.steamid}`);
    }
    return row;
  });
  assertUniqueSteamids(rows);
  return rows;
}

export function fitRoleSide(side: RoleSide, data: readonly RoleRow[]): RoleModel["sides"]["T"] {
  const out: RoleModel["sides"]["T"] = { roles: {}, n: 0 };
  for (const role of MAPPED[side]) {
    // Map before grouping so Half-Lurker does not add a second prior.
    const xs = data.filter((row) => evaluationLabel(row, side) === role)
      .map((row) => FEATURES.map((f) => Number(row[`${COL[f]}_${side.toLowerCase()}`])));
    if (xs.length < 2) throw new Error(`Need at least two ${side} ${role} training players; got ${xs.length}`);
    if (xs.some((x) => x.some((v) => !Number.isFinite(v)))) throw new Error(`Non-finite ${side} ${role} training feature`);
    const mean = FEATURES.map((_, j) => xs.reduce((sum, x) => sum + x[j], 0) / xs.length);
    const sd = FEATURES.map((_, j) => Math.sqrt(xs.reduce((sum, x) => sum + (x[j] - mean[j]) ** 2, 0) / (xs.length - 1)));
    out.roles[role] = { n: xs.length, mean, sd };
    out.n += xs.length;
  }
  return out;
}

/** Pool-adjacent-violators isotonic regression, with equal scores pooled before fitting. */
export function fitIsotonic(samples: readonly CalibrationPoint[]): CalibrationPoint[] {
  if (samples.some(({ x, y }) => !Number.isFinite(x) || x < 0 || x > 1 || (y !== 0 && y !== 1))) throw new Error("Isotonic fit needs finite probabilities and binary outcomes");
  const grouped: { xs: number[]; sum: number; n: number }[] = [];
  for (const { x, y } of [...samples].sort((a, b) => a.x - b.x)) {
    const last = grouped[grouped.length - 1];
    if (last?.xs[0] === x) { last.sum += y; last.n++; }
    else grouped.push({ xs: [x], sum: y, n: 1 });
  }
  const blocks: typeof grouped = [];
  for (const group of grouped) {
    blocks.push(group);
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2], b = blocks[blocks.length - 1];
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { xs: [...a.xs, ...b.xs], sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => b.xs.map((x) => ({ x, y: b.sum / b.n })));
}

// The callback is for fold-isolation tests, not part of the runtime model.
export type FitObserver = (stage: "gaussian" | "calibration", ids: readonly string[]) => void;
export function trainRoleModel(data: readonly RoleRow[], summaries: RoleSummaries, observe?: FitObserver): RoleModel {
  assertUniqueSteamids(data);
  const gaussian = (rows: readonly RoleRow[]): RoleModel => {
    observe?.("gaussian", rows.map((row) => row.steamid));
    return {
      source: "Jamie Packer 2024, CC BY 4.0; merged Lurker class; isotonic fit on inner-LOO pro summaries. Threshold-only roles have no labels. AWPer is measured loadout share.",
      features: [...FEATURES], sides: { T: fitRoleSide("T", rows), CT: fitRoleSide("CT", rows) },
    };
  };
  const base = gaussian(data);
  const samples: Record<RoleSide, Partial<Record<RoleName, CalibrationPoint[]>>> = { T: {}, CT: {} };
  const calibrationIds: string[] = [];
  for (const row of data) {
    const eligible = (["T", "CT"] as const).filter((side) => {
      const truth = evaluationLabel(row, side);
      return truth && (MAPPED[side] as readonly string[]).includes(truth) && summaries.get(row.steamid)?.[side];
    });
    if (!eligible.length) continue;
    const inner = gaussian(data.filter((candidate) => candidate.steamid !== row.steamid));
    for (const side of eligible) {
      const b = roleBlend(summaries.get(row.steamid)![side]!, side, inner);
      if (!b.distribution) continue;
      for (const role of MAPPED[side]) (samples[side][role] ??= []).push({ x: b.distribution[role], y: evaluationLabel(row, side) === role ? 1 : 0 });
    }
    calibrationIds.push(row.steamid);
  }
  observe?.("calibration", calibrationIds);
  // No negative labels are invented for Trader/Support/Aggressor or AWPer.
  base.calibration = {
    T: Object.fromEntries(Object.entries(samples.T).map(([role, points]) => [role, fitIsotonic(points)])),
    CT: Object.fromEntries(Object.entries(samples.CT).map(([role, points]) => [role, fitIsotonic(points)])),
  };
  return base;
}

export interface RoleEvaluation {
  total: number;
  excludedLabels: number;
  missingSummary: number;
  insufficient: number;
  top1Correct: number;
  singleCorrect: number;
  setCorrect: number;
  single: number;
  topTwo: number;
  confusion: Record<string, Record<string, number>>;
  decisions: Record<string, Record<string, number>>;
  reliability: { probability: number; correct: boolean }[];
}
export function evaluateRoleRows(side: RoleSide, rows: readonly RoleRow[], summaries: RoleSummaries, modelFor: (row: RoleRow) => RoleModel): RoleEvaluation {
  const out: RoleEvaluation = { total: 0, excludedLabels: 0, missingSummary: 0, insufficient: 0, top1Correct: 0, singleCorrect: 0, setCorrect: 0, single: 0, topTwo: 0, confusion: {}, decisions: {}, reliability: [] };
  const count = (matrix: RoleEvaluation["confusion"], truth: string, predicted: string) => {
    const row = matrix[truth] ??= {};
    row[predicted] = (row[predicted] ?? 0) + 1;
  };
  for (const row of rows) {
    const truth = evaluationLabel(row, side);
    if (!truth) { out.excludedLabels++; continue; }
    const summary = summaries.get(row.steamid)?.[side];
    if (!summary?.m.rounds) { out.missingSummary++; continue; }
    const result = roleBlend(summary, side, modelFor(row));
    out.total++;
    if (!result.distribution || (!result.primary && !result.top2)) {
      out.insufficient++;
      count(out.decisions, truth, "insufficient");
      continue;
    }
    const [top, probability] = Object.entries(result.distribution).sort((a, b) => b[1] - a[1])[0];
    const correct = top === truth;
    if (correct) out.top1Correct++;
    // Reliability tests the probability's prediction, not whether the confidence gate abstained.
    out.reliability.push({ probability, correct });
    count(out.confusion, truth, top);
    count(out.decisions, truth, result.primary ?? `top2:${result.top2!.join("/")}`);
    if (result.primary) { out.single++; if (result.primary === truth) out.singleCorrect++; }
    else out.topTwo++;
    if (result.primary === truth || (!result.primary && result.top2?.includes(truth))) out.setCorrect++;
  }
  return out;
}

export function reliabilityTable(values: RoleEvaluation["reliability"]) {
  return Array.from({ length: 5 }, (_, i) => {
    const lo = i / 5, hi = (i + 1) / 5;
    const xs = values.filter((x) => x.probability >= lo && (i === 4 ? x.probability <= hi : x.probability < hi));
    return { bin: `${lo.toFixed(1)}-${hi.toFixed(1)}`, n: xs.length, mean: xs.length ? xs.reduce((sum, x) => sum + x.probability, 0) / xs.length : null, observed: xs.length ? xs.filter((x) => x.correct).length / xs.length : null };
  });
}
