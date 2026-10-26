import { expect, it, vi } from "vitest";
import { FEATURES, roleBlend, roleProbabilities, type RoleModel } from "./identity";
import { evaluateRoleRows, evaluationLabel, fitIsotonic, fitRoleSide, fitRoleThresholds, parseRoleCsv, reliabilityTable, trainRoleModel, type RoleRow, type RoleSummaries } from "./role-training";
import { teamGroupedSplit } from "./role-validation";
import { emptySummary } from "./rollup";

const row = (id: string, t: string, ct: string, value = 1): RoleRow => ({
  steamid: id, team_clan_name: `team-${Number(id) % 3}`, role_t: t, role_ct: ct, map_count: "20",
  ...Object.fromEntries(FEATURES.flatMap((f) => ["t", "ct"].map((side) => [`${f === "adnt" || f === "adat" ? f + "_rank" : f}_${side}`, String(value)]))),
});
const training = Array.from({ length: 12 }, (_, i) => row(String(i + 1), i % 2 ? "Spacetaker" : "Lurker", i % 2 ? "Anchor" : "Rotator", i / 10));
function summariesFor(rows: RoleRow[]): RoleSummaries {
  return new Map(rows.map((r) => {
    const s = emptySummary();
    Object.assign(s.m, { rounds: 100, kills: 30, deaths: 50, spacingSamples: 100, deathTimeSum: 2400, openingKills: 20, tradeKills: 6, tradedDeaths: 10, adntRank: 50, adatRank: 50, nearestDistSum: 50000, loadoutRounds: 100 });
    return [r.steamid, { T: s, CT: structuredClone(s) }];
  }));
}

it("fits Half-Lurker and Lurker as one class, not two posterior priors", () => {
  const rows = [row("1", "Half-Lurker", "Anchor", 1), row("2", "Lurker", "Anchor", 3), row("3", "Spacetaker", "Rotator", 1), row("4", "Spacetaker", "Rotator", 3), row("5", "Mixed", "Mixed", 100)];
  const fit = fitRoleSide("T", rows);
  expect(Object.keys(fit.roles)).toEqual(["Entry", "Lurker"]);
  expect(fit.n).toBe(4);
  expect(fit.roles.Lurker.n).toBe(2);
  expect(fit.roles.Lurker.mean).toEqual(Array(6).fill(2));
  expect(roleProbabilities(fit, Object.fromEntries(FEATURES.map((f) => [f, 2])) as Record<typeof FEATURES[number], number>)).toEqual({ Entry: 0.5, Lurker: 0.5 });
});

it("pools duplicate scores and preserves both endpoints of isotonic blocks", () => {
  expect(fitIsotonic([{ x: 0.1, y: 0 }, { x: 0.2, y: 1 }, { x: 0.3, y: 0 }, { x: 0.4, y: 1 }])).toEqual([{ x: 0.1, y: 0 }, { x: 0.2, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.4, y: 1 }]);
  expect(fitIsotonic([{ x: 0.2, y: 1 }, { x: 0.2, y: 0 }])).toEqual([{ x: 0.2, y: 0.5 }]);
  expect(() => fitIsotonic([{ x: NaN, y: 1 }])).toThrow("finite probabilities");
});

it("fits threshold ranges from the rows in the current fold only", () => {
  const rows = training.slice(0, 6);
  const summaries = summariesFor(training);
  rows.forEach((r, i) => {
    const s = summaries.get(r.steamid)!.T!;
    s.m.openingKills = 10 + i * 10;
  });
  summaries.get(training[6].steamid)!.T!.m.openingKills = 1000;
  const local = fitRoleThresholds(rows, summaries);
  const withHeld = fitRoleThresholds([...rows, training[6]], summaries);
  expect(local.openingAttempts.proRange).not.toEqual(withHeld.openingAttempts.proRange);
  expect(local.openingAttempts.n).toBe(12);
});

it("never passes outer held players to Gaussian or calibration fitting", () => {
  const held = training[0], train = training.slice(1), summaries = summariesFor(training);
  const observed: { stage: string; ids: readonly string[] }[] = [];
  const model = trainRoleModel(train, summaries, (stage, ids) => observed.push({ stage, ids }));
  expect(observed.length).toBeGreaterThan(2);
  for (const fit of observed) expect(fit.ids).not.toContain(held.steamid);
  expect(observed.filter((fit) => fit.stage === "gaussian").slice(1).every((fit) => fit.ids.length === train.length - 1)).toBe(true);
  expect(Object.keys(model.calibration!.T).sort()).toEqual(["Entry", "Lurker"]);
  expect(Object.keys(model.calibration!.CT).sort()).toEqual(["Anchor", "Rotator"]);
  const altered = summariesFor(training);
  altered.get(held.steamid)!.T!.m.roundsWithAwp = 100;
  expect(trainRoleModel(train, altered)).toEqual(model);
});

it("excludes every held team's players from Gaussian and calibration fits", () => {
  const split = teamGroupedSplit(training, (r) => evaluationLabel(r, "T"), 0xC0DE);
  expect(split.holdout.length).toBeGreaterThan(0);
  const heldTeams = new Set(split.holdout.map((r) => r.team_clan_name));
  const heldIds = new Set(training.filter((r) => heldTeams.has(r.team_clan_name)).map((r) => r.steamid));
  const summaries = summariesFor(training);
  const calls: string[][] = [];
  trainRoleModel(training.filter((r) => !heldTeams.has(r.team_clan_name)), summaries, (_, ids) => calls.push([...ids]));
  expect(calls.length).toBeGreaterThan(2);
  expect(calls.every((ids) => ids.every((id) => !heldIds.has(id)))).toBe(true);
});

it("validates the shared CSV input before identity checks or splitting", () => {
  const columns = Object.keys(training[0]);
  const csv = (rows: RoleRow[]) => [columns.join(","), ...rows.map((r) => columns.map((c) => r[c]).join(","))].join("\n");
  expect(parseRoleCsv(csv(training))).toEqual(training);
  expect(() => parseRoleCsv(csv([training[0], training[0]]))).toThrow("one row per steamid");
  expect(() => parseRoleCsv(csv([{ ...training[0], tapd_t: "bad" }]))).toThrow("Invalid tapd_t");
  expect(() => parseRoleCsv(csv([{ ...training[0], team_clan_name: "\"quoted\"" }]))).toThrow("Unsupported role CSV");
  expect(evaluationLabel(row("20", "Mixed", "Mixed"), "T")).toBeNull();
  expect(evaluationLabel(row("20", "Mixed", "Mixed"), "CT")).toBeNull();
});

it("evaluates production AWP, softmax, calibration and abstention, excluding Mixed before counting", () => {
  const rows = [...training, row("13", "AWPer", "AWPer"), row("14", "Mixed", "Mixed")];
  const summaries = summariesFor(rows);
  const base = trainRoleModel(training, summaries);
  const model: RoleModel = base;
  summaries.get("13")!.T!.m.roundsWithAwp = 80;
  const callback = vi.fn(() => model);
  const output = evaluateRoleRows("T", [rows[12], rows[13]], summaries, callback);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(output.total).toBe(1);
  expect(output.excludedLabels).toBe(1);
  expect(output.confusion).toEqual({ AWPer: { AWPer: 1 } });
  expect(output.singleCorrect).toBe(1);
  expect(output.reliability).toEqual([{ probability: 0.8, correct: true }]);
  const s = summaries.get("13")!.T!;
  s.m.roundsWithAwp = 50;
  expect(roleBlend(s, "T", model).primary).toBeNull();
  const abstaining = evaluateRoleRows("T", [rows[12]], summaries, () => model);
  expect(abstaining.single).toBe(0);
  expect(abstaining.topTwo).toBe(1);
  expect(abstaining.reliability).toEqual([{ probability: 0.5, correct: true }]);
  expect(reliabilityTable(abstaining.reliability)[2]).toEqual({ bin: "0.4-0.6", n: 1, mean: 0.5, observed: 1 });
  s.m.rounds = 29;
  expect(evaluateRoleRows("T", [rows[12]], summaries, () => model).insufficient).toBe(1);
});
