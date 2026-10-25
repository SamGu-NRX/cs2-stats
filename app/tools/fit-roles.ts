// Fits the role model in src/stats/roles-params.json from Jamie Packer's CS2 playstyle dataset
// (2024, CC BY 4.0, https://github.com/Jamie-Packer/cs2-playstyle-dataset-2024; role labels adapted
// from Harry Richards' Positions Database). Usage:
//   pnpm fit-roles <path to cs2_playstyle_roles_2024.csv>
// Per side, a Gaussian naive Bayes over Packer's six features of the players he labelled (AWPers
// left out: AWP use decides them, and his features do not carry it). Prints leave-one-out accuracy.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FEATURES, type RoleModel } from "../src/stats/identity";

const csv = process.argv[2];
if (!csv) throw new Error("usage: pnpm fit-roles <cs2_playstyle_roles_2024.csv>");
const [head, ...lines] = readFileSync(csv, "utf8").trim().split(/\r?\n/);
const cols = head.split(",");
const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
const COL: Record<(typeof FEATURES)[number], string> = { tapd: "tapd", oap: "oap", podt: "podt", pokt: "pokt", adnt: "adnt_rank", adat: "adat_rank" };

type Fit = RoleModel["sides"]["T"];
function fit(side: "t" | "ct", data: Record<string, string>[]): Fit {
  const labelled = data.filter((r) => r[`role_${side}`] && r[`role_${side}`] !== "AWPer");
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
  source: "Jamie Packer, CS2 Playstyle & Roles Dataset (2024), CC BY 4.0; roles adapted from Harry Richards' Positions Database",
  features: [...FEATURES],
  sides: { T: fit("t", rows), CT: fit("ct", rows) },
};

// leave-one-out accuracy, from the same naive Bayes the engine uses
const { roleProbabilities } = await import("../src/stats/identity");
for (const side of ["t", "ct"] as const) {
  const labelled = rows.filter((r) => r[`role_${side}`] && r[`role_${side}`] !== "AWPer");
  let ok = 0;
  const confusion: Record<string, Record<string, number>> = {};
  labelled.forEach((r, i) => {
    const m = fit(side, labelled.filter((_, j) => j !== i));
    const feats = Object.fromEntries(FEATURES.map((f) => [f, Number(r[`${COL[f]}_${side}`])])) as Record<(typeof FEATURES)[number], number>;
    const p = roleProbabilities(m, feats);
    const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
    if (best === r[`role_${side}`]) ok++;
    (confusion[r[`role_${side}`]] ??= {})[best] = (confusion[r[`role_${side}`]][best] ?? 0) + 1;
  });
  console.log(`${side.toUpperCase()}: leave-one-out accuracy ${ok}/${labelled.length} (${((100 * ok) / labelled.length).toFixed(1)}%)`, JSON.stringify(confusion));
}
const out = path.resolve(import.meta.dirname, "../src/stats/roles-params.json");
writeFileSync(out, JSON.stringify(model, null, 1) + "\n");
console.log(`wrote ${out}`);
