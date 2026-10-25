// Compares the engine's role features and role blend with Jamie Packer's 2024 dataset for players in
// both (by steamid). Usage: pnpm identity-check <cs2_playstyle_roles_2024.csv>
// Packer's data is from 2024 and ours from October 2026, so agreement measures how stable a style is
// as much as how well the features match.
import { readFileSync } from "node:fs";
import { roleOf } from "../src/stats/compare";
import { derive } from "../src/stats/derive";
import type { MatchFacts } from "../src/stats/facts";
import { FEATURES, packerFeatures, roleBlend } from "../src/stats/identity";
import { pearson } from "../src/stats/trends";
import { rollup } from "../src/stats/rollup";
import { loadDir, proMapDirs, WINPROB } from "./node-read";

const csv = process.argv[2];
if (!csv) throw new Error("usage: pnpm identity-check <cs2_playstyle_roles_2024.csv>");
const [head, ...lines] = readFileSync(csv, "utf8").trim().split(/\r?\n/);
const cols = head.split(",");
const packer = new Map(lines.map((l) => { const r = Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])); return [r.steamid, r]; }));
const COL = { tapd: "tapd", oap: "oap", podt: "podt", pokt: "pokt", adnt: "adnt_rank", adat: "adat_rank" } as const;

const facts: MatchFacts[] = [];
for (const d of proMapDirs()) facts.push(derive(await loadDir(d), WINPROB));
const ids = new Set(facts.flatMap((f) => f.players.map((p) => p.id)).filter((id) => packer.has(id)));

const MIN_ROUNDS = 20;
for (const side of ["T", "CT"] as const) {
  const ours: Record<string, number[]> = {}, theirs: Record<string, number[]> = {};
  let agree = 0, labelled = 0, awpAgree = 0, awpN = 0;
  const lines: string[] = [];
  for (const id of ids) {
    const s = rollup(facts, { player: id, sides: [side] });
    if (s.m.rounds < MIN_ROUNDS) continue;
    const x = packerFeatures(s.m);
    const p = packer.get(id)!;
    const sfx = side.toLowerCase();
    if (x) for (const f of FEATURES) { (ours[f] ??= []).push(x[f]); (theirs[f] ??= []).push(Number(p[`${COL[f]}_${sfx}`])); }
    const label = p[`role_${sfx}`];
    if (label === "AWPer" || roleOf(rollup(facts, { player: id })) === "awper") { awpN++; if ((label === "AWPer") === (roleOf(rollup(facts, { player: id })) === "awper")) awpAgree++; }
    const b = roleBlend(s, side);
    if (!label || label === "AWPer" || !b.blend) continue;
    const top = Object.entries(b.blend).filter(([r]) => r !== "AWPer").sort((u, v) => v[1] - u[1])[0][0];
    const want = { Spacetaker: "Entry", Lurker: "Lurker", "Half-Lurker": "Half-lurker", Anchor: "Anchor", Rotator: "Rotator", Mixed: "Mixed" }[label];
    labelled++;
    if (top === want) agree++;
    lines.push(`${p.player_name.padEnd(12)} ${label.padEnd(11)} ours ${top.padEnd(11)} ${Object.entries(b.blend).map(([r, v]) => `${r} ${Math.round(100 * v)}%`).join(", ")}`);
  }
  console.log(`\n${side}: ${ours.tapd?.length ?? 0} players in both datasets with ${MIN_ROUNDS}+ ${side} rounds`);
  for (const f of FEATURES) if (ours[f]) console.log(`  ${f.padEnd(5)} r ${pearson(ours[f], theirs[f]).toFixed(2)}  mean ours ${(ours[f].reduce((s, v) => s + v, 0) / ours[f].length).toFixed(2)} Packer ${(theirs[f].reduce((s, v) => s + v, 0) / theirs[f].length).toFixed(2)}`);
  console.log(`  top role matches Packer's label: ${agree}/${labelled}; AWPer status agrees: ${awpAgree}/${awpN}`);
  for (const l of lines) console.log("   " + l);
}
