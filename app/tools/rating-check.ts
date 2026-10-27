// Compares the engine's Rating 3.0 inputs and rating with HLTV's on every joined pro map: eKPR, eDPR,
// eADR, eKAST, swing and the rating, and beside the eco inputs their raw versions (KPR, DPR, ADR, KAST
// against HLTV's traditional columns), so an eco error can be told from a counting error. Prints MAE and Pearson r per column, and the win-probability source
// swing used (node-read.ts WINPROB; CS2_WINPROB_PACK=none forces CS2RB). Usage: pnpm rating-check
import { derive } from "../src/stats/derive";
import { rating3BySide } from "../src/stats/rating3";
import { pearson } from "../src/stats/trends";
import { rollup } from "../src/stats/rollup";
import { hltvMaps, joinHltv } from "./hltv";
import { WINPROB, proMaps } from "./node-read";

const cols = { KPR: [[], []], eKPR: [[], []], DPR: [[], []], eDPR: [[], []], ADR: [[], []], eADR: [[], []], KAST: [[], []], eKAST: [[], []], swing: [[], []], rating: [[], []], "rating CT": [[], []], "rating T": [[], []] } as Record<string, [number[], number[]]>;
let maps = 0;
console.log(`win probability: ${WINPROB.label}`);
for await (const { t } of proMaps()) {
  const f = derive(t, WINPROB);
  const j = joinHltv(f, hltvMaps());
  if (!j) continue;
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
