// Compares the engine's Rating 3.0 inputs and rating with HLTV's on every joined pro map: eKPR, eDPR,
// eADR, eKAST, swing and the rating. Prints MAE and Pearson r per column. Usage: pnpm rating-check
import { derive } from "../src/stats/derive";
import { r3Inputs, rating3 } from "../src/stats/rating3";
import { rollup } from "../src/stats/rollup";
import { hltvMaps, joinHltv } from "./hltv";
import { loadDir, proMapDirs } from "./node-read";

const cols = { eKPR: [[], []], eDPR: [[], []], eADR: [[], []], eKAST: [[], []], swing: [[], []], rating: [[], []] } as Record<string, [number[], number[]]>;
let maps = 0;
for (const dir of proMapDirs()) {
  const f = derive(await loadDir(dir));
  const j = joinHltv(f, hltvMaps());
  if (!j) continue;
  maps++;
  for (const [pi, h] of j.player) {
    const m = rollup([f], { player: f.players[pi].id }).m;
    const q = r3Inputs(m);
    const r = rating3(m).value;
    if (!q || r === null) continue;
    const put = (c: string, ours: number, theirs: number) => { cols[c][0].push(ours); cols[c][1].push(theirs); };
    put("eKPR", q.kpr_eco, h.total.eK / m.rounds);
    put("eDPR", q.dpr_eco, h.total.eD / m.rounds);
    put("eADR", q.adr_eco, h.total.eAdr);
    put("eKAST", q.kast_eco, h.total.eKast);
    put("swing", q.swing, h.total.swing);
    put("rating", r, h.total.rating);
  }
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pearson = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  a.forEach((x, i) => { n += (x - ma) * (b[i] - mb); da += (x - ma) ** 2; db += (b[i] - mb) ** 2; });
  return n / Math.sqrt(da * db);
};
console.log(`joined ${maps} maps, ${cols.rating[0].length} player-maps`);
for (const [c, [ours, theirs]] of Object.entries(cols)) {
  const mae = mean(ours.map((x, i) => Math.abs(x - theirs[i])));
  console.log(`${c.padEnd(7)} MAE ${mae.toFixed(4)}  r ${pearson(ours, theirs).toFixed(4)}  mean ours ${mean(ours).toFixed(3)} HLTV ${mean(theirs).toFixed(3)}`);
}
