// Fits the labelled part of the role model and reports cross-validation evidence.
// Usage: pnpm fit-roles <cs2_playstyle_roles_2024.csv>
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FEATURES, ROLE_NAME, roleProbabilities, type RoleModel, type RoleName } from "../src/stats/identity";

const csv = process.argv[2];
if (!csv) throw new Error("usage: pnpm fit-roles <cs2_playstyle_roles_2024.csv>");
const [head, ...lines] = readFileSync(csv, "utf8").trim().split(/\r?\n/);
const cols = head.split(",");
const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
const COL: Record<(typeof FEATURES)[number], string> = { tapd: "tapd", oap: "oap", podt: "podt", pokt: "pokt", adnt: "adnt_rank", adat: "adat_rank" };

type Fit = RoleModel["sides"]["T"];
const mapped = (label: string | undefined): RoleName | null => (label ? ROLE_NAME[label] ?? null : null);

function fit(side: "t" | "ct", data: Record<string, string>[]): Fit {
  const labelled = data.filter((r) => mapped(r[`role_${side}`]) && r[`role_${side}`] !== "AWPer");
  const x = (r: Record<string, string>) => FEATURES.map((f) => Number(r[`${COL[f]}_${side}`]));
  const roles = [...new Set(labelled.map((r) => r[`role_${side}`]))].sort();
  const out: Fit = { roles: {}, n: labelled.length };
  for (const role of roles) {
    const xs = labelled.filter((r) => r[`role_${side}`] === role).map(x);
    const mean = FEATURES.map((_, j) => xs.reduce((s, v) => s + v[j], 0) / xs.length);
    const sd = FEATURES.map((_, j) => Math.sqrt(xs.reduce((s, v) => s + (v[j] - mean[j]) ** 2, 0) / Math.max(1, xs.length - 1)));
    out.roles[role] = { n: xs.length, mean, sd };
  }
  return out;
}

const model: RoleModel = {
  source: "Jamie Packer, CS2 Playstyle & Roles Dataset (2024), CC BY 4.0; mapped to observable roles; Mixed excluded",
  features: [...FEATURES],
  sides: { T: fit("t", rows), CT: fit("ct", rows) },
};

function classify(fitModel: Fit, row: Record<string, string>, side: "t" | "ct"): RoleName | null {
  const wanted = mapped(row[`role_${side}`]);
  if (!wanted || wanted === "AWPer") return null;
  const features = Object.fromEntries(FEATURES.map((f) => [f, Number(row[`${COL[f]}_${side}`])])) as Record<(typeof FEATURES)[number], number>;
  const posterior = roleProbabilities(fitModel, features);
  const best = Object.entries(posterior).sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? ROLE_NAME[best] : null;
}

function report(side: "t" | "ct") {
  const labelled = rows.filter((r) => mapped(r[`role_${side}`]) && mapped(r[`role_${side}`]) !== "AWPer");
  let ok = 0;
  const confusion: Record<string, Record<string, number>> = {};
  for (let i = 0; i < labelled.length; i++) {
    const truth = mapped(labelled[i][`role_${side}`])!;
    const predicted = classify(fit(side, labelled.filter((_, j) => j !== i)), labelled[i], side)!;
    if (predicted === truth) ok++;
    (confusion[truth] ??= {})[predicted] = (confusion[truth][predicted] ?? 0) + 1;
  }

  const split = Math.max(1, Math.floor(labelled.length * 0.2));
  const holdout = labelled.slice(-split);
  const train = labelled.slice(0, -split);
  const holdoutFit = fit(side, train);
  const holdoutCorrect = holdout.filter((row) => classify(holdoutFit, row, side) === mapped(row[`role_${side}`])).length;
  console.log(`${side.toUpperCase()}: leave-one-out accuracy ${ok}/${labelled.length} (${((100 * ok) / labelled.length).toFixed(1)}%)`);
  console.log(`${side.toUpperCase()}: holdout accuracy ${holdoutCorrect}/${holdout.length} (${((100 * holdoutCorrect) / holdout.length).toFixed(1)}%)`);
  console.log(`${side.toUpperCase()}: confusion matrix ${JSON.stringify(confusion)}`);
}

report("t");
report("ct");
const out = path.resolve(import.meta.dirname, "../src/stats/roles-params.json");
writeFileSync(out, JSON.stringify(model, null, 1) + "\n");
console.log(`wrote ${out}`);
