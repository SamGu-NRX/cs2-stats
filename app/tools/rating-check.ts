// Compares the engine's Rating 3.0 inputs and rating with HLTV's on every joined pro map: eKPR, eDPR,
// eADR, eKAST, swing and the rating, and beside the eco inputs their raw versions (KPR, DPR, ADR, KAST
// against HLTV's traditional columns), so an eco error can be told from a counting error. Prints MAE and Pearson r per column, and the win-probability source
// swing used (node-read.ts WINPROB; CS2_WINPROB_PACK=none forces CS2RB). The maps and players are
// model/rating3/join_demos.py's joins (<data>/model-rating3/demo_joins.json, or CS2_DEMO_JOINS), as the rating
// dump reads them. Usage: pnpm rating-check
import { derive } from "../src/stats/derive";
import { rating3BySide } from "../src/stats/rating3";
import { pearson } from "../src/stats/trends";
import { rollup } from "../src/stats/rollup";
import { readFileSync } from "node:fs";
import path from "node:path";
import { acceptedJoins, joinFromRecord } from "./demo-joins";
import { HLTV_DIR, parseHltvMap } from "./hltv";
import { DATA_DIR, WINPROB, mapLabel, proMaps } from "./node-read";

const cols = { KPR: [[], []], eKPR: [[], []], DPR: [[], []], eDPR: [[], []], ADR: [[], []], eADR: [[], []], KAST: [[], []], eKAST: [[], []], swing: [[], []], rating: [[], []], "rating CT": [[], []], "rating T": [[], []] } as Record<string, [number[], number[]]>;
let maps = 0;
const joins = acceptedJoins(JSON.parse(readFileSync(process.env.CS2_DEMO_JOINS ?? path.join(DATA_DIR, "model-rating3", "demo_joins.json"), "utf-8")));
console.log(`win probability: ${WINPROB.label}; ${joins.size} accepted joins`);
for await (const { dir, t } of proMaps()) {
  const rec = joins.get(mapLabel(dir));
  if (!rec) continue;
  const page = parseHltvMap(path.join(HLTV_DIR, rec.hltv));
  if (!page) throw new Error(`${rec.hltv}: not a v3 HLTV map page`);
  const f = derive(t, WINPROB);
  const j = joinFromRecord(f.players, rec, page);
  maps++;
  for (const [pi, h] of j.player) {
    const bySide = rating3BySide([f], { player: f.players[pi].id });
    const m = rollup([f], { player: f.players[pi].id }).m;
    const q = bySide.both.inputs;
    const r = bySide.both.value;
    if (!q || r === null) continue;
    const put = (c: string, ours: number, theirs: number) => { cols[c][0].push(ours); cols[c][1].push(theirs); };
    put("KPR", m.kills / m.rounds, h.total.k / m.rounds);
    put("DPR", m.deaths / m.rounds, h.total.d / m.rounds);
    put("ADR", m.dmg / m.rounds, h.total.adr);
    put("KAST", (100 * m.kast) / m.rounds, h.total.kast);
    put("eKPR", q.kpr_eco, h.total.eK / m.rounds);
    put("eDPR", q.dpr_eco, h.total.eD / m.rounds);
    put("eADR", q.adr_eco, h.total.eAdr);
    put("eKAST", q.kast_eco, h.total.eKast);
    put("swing", q.swing, h.total.swing);
    put("rating", r, h.total.rating);
    if (h.ct && bySide.CT.value !== null) put("rating CT", bySide.CT.value, h.ct.rating);
    if (h.t && bySide.T.value !== null) put("rating T", bySide.T.value, h.t.rating);
  }
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`joined ${maps} maps, ${cols.rating[0].length} player-maps`);
for (const [c, [ours, theirs]] of Object.entries(cols)) {
  const mae = mean(ours.map((x, i) => Math.abs(x - theirs[i])));
  console.log(`${c.padEnd(9)} MAE ${mae.toFixed(4)}  r ${pearson(ours, theirs)?.toFixed(4) ?? "– (no spread)"}  mean ours ${mean(ours).toFixed(3)} HLTV ${mean(theirs).toFixed(3)}`);
}
