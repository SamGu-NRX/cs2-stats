// Cross-era feature and role agreement, not held-out accuracy. Packer labels are from 2024;
// demo summaries are from October 2026. Use fit-roles for fold-isolated validation.
// Usage: pnpm identity-check <cs2_playstyle_roles_2024.csv>
import { readFileSync } from "node:fs";
import { derive } from "../src/stats/derive";
import type { MatchFacts } from "../src/stats/facts";
import { FEATURES, packerFeatures, roleBlend, ROLE_MIN_ROUNDS, type RoleModel } from "../src/stats/identity";
import { evaluateRoleRows, evaluationLabel, parseRoleCsv, type RoleSummaries } from "../src/stats/role-training";
import model from "../src/stats/roles-params.json";
import { pearson } from "../src/stats/trends";
import { rollup } from "../src/stats/rollup";
import { WINPROB, proMaps } from "./node-read";

const csv = process.argv[2];
if (!csv) throw new Error("usage: pnpm identity-check <cs2_playstyle_roles_2024.csv>");
const rows = parseRoleCsv(readFileSync(csv, "utf8"));
const COL = { tapd: "tapd", oap: "oap", podt: "podt", pokt: "pokt", adnt: "adnt_rank", adat: "adat_rank" } as const;
const facts: MatchFacts[] = [];
for await (const { t } of proMaps()) facts.push(derive(t, WINPROB));
const ids = new Set(facts.flatMap((f) => f.players.map((p) => p.id)));
const summaries: RoleSummaries = new Map();
for (const side of ["T", "CT"] as const) {
  const ours: Record<string, number[]> = {}, theirs: Record<string, number[]> = {};
  const lines: string[] = [];
  for (const row of rows) {
    // Apply the evaluator's label policy before correlations as well as role agreement.
    const want = evaluationLabel(row, side);
    if (!want || !ids.has(row.steamid)) continue;
    const s = rollup(facts, { player: row.steamid, sides: [side] });
    const pair = summaries.get(row.steamid) ?? {};
    pair[side] = s;
    summaries.set(row.steamid, pair);
    if (s.m.rounds < ROLE_MIN_ROUNDS) continue;
    const x = packerFeatures(s.m);
    if (x) for (const f of FEATURES) { (ours[f] ??= []).push(x[f]); (theirs[f] ??= []).push(Number(row[`${COL[f]}_${side.toLowerCase()}`])); }
    const b = roleBlend(s, side);
    const decision = b.primary ?? (b.top2 ? `top2:${b.top2.join("/")}` : b.reason!);
    lines.push(`${(row.player_name ?? row.steamid).padEnd(12)} ${want.padEnd(11)} ours ${decision} ${Object.entries(b.distribution ?? {}).map(([r, v]) => `${r} ${v === null ? "unknown" : `${Math.round(100 * v)}%`}`).join(", ")}`);
  }
  const result = evaluateRoleRows(side, rows, summaries, () => model as unknown as RoleModel);
  console.log(`\n${side}: ${ours.tapd?.length ?? 0} labelled players with features and ${ROLE_MIN_ROUNDS}+ side rounds; Mixed excluded`);
  for (const f of FEATURES) if (ours[f]) console.log(`  ${f.padEnd(5)} r ${pearson(ours[f], theirs[f]).toFixed(2)}  mean ours ${(ours[f].reduce((s, v) => s + v, 0) / ours[f].length).toFixed(2)} Packer ${(theirs[f].reduce((s, v) => s + v, 0) / theirs[f].length).toFixed(2)}`);
  console.log(`  top-one matches ${result.top1Correct}/${result.total}; single-primary matches ${result.singleCorrect}/${result.single}; returned-set matches ${result.setCorrect}/${result.total}; top2 ${result.topTwo}; insufficient ${result.insufficient}; missing ${result.missingSummary}; excluded labels ${result.excludedLabels}`);
  for (const line of lines) console.log("   " + line);
}
