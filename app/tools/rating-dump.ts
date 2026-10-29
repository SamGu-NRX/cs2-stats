// Writes the engine's per-player-round rows for every pro map joined to HLTV, beside HLTV's own
// per-round swing, for the Rating 3.0 fits in model/rating3 (fit_params.py, swing_credit_fit.py). The joins
// are model/rating3/join_demos.py's (<data>/model-rating3/demo_joins.json, or CS2_DEMO_JOINS): its HLTV page,
// map_*.json or ocs_map_*.json, and its pairing of SteamIDs with HLTV players, so a renamed player pairs. Five
// private JSONL files land in <cs2-stats-data>/model-rating3: player-round rows (every measure the
// engine fills), kill rows (both players' economy state and the swing credits), enemy-hit rows (damage
// per hit), each round's win-probability path, and each map's join record and table layout. Each is
// written beside its final name and renamed into place at the end, so a reader never sees a half-written
// file.
// Usage: pnpm rating-dump
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import { derive } from "../src/stats/derive";
import { acceptedJoins, joinFromRecord } from "./demo-joins";
import { HLTV_DIR, parseHltvMap } from "./hltv";
import { finishPartials } from "./partial-files";
import { hitRows, joinRow, killRows } from "./rating-rows";
import { checkOutput } from "./outputs";
import { DATA_DIR, WINPROB, mapLabel, proMaps } from "./node-read";

const OUT = path.join(DATA_DIR, "model-rating3");
mkdirSync(OUT, { recursive: true });
const files: [WriteStream, string][] = [];
const open = (name: string) => {
  const file = path.join(OUT, name);
  checkOutput(file, { private: true, what: "per-round rating rows joined to HLTV" });
  const s = createWriteStream(`${file}.partial`);
  files.push([s, file]);
  return s;
};
const rows = open("rating-rounds.private.jsonl");
const kills = open("rating-kills.private.jsonl");
const hits = open("rating-hits.private.jsonl");
const paths = open("rating-winprob.private.jsonl");
const joined = open("rating-joins.private.jsonl");

const joinsFile = process.env.CS2_DEMO_JOINS ?? path.join(OUT, "demo_joins.json");
const joins = acceptedJoins(JSON.parse(readFileSync(joinsFile, "utf-8")));
const found = new Set<string>();

let maps = 0;
let n = 0;
console.log(`win probability: ${WINPROB.label}; joins: ${joinsFile} (${joins.size} accepted)`);
for await (const { dir, t } of proMaps()) {
  const rec = joins.get(mapLabel(dir));
  if (!rec) continue;
  found.add(mapLabel(dir));
  const page = parseHltvMap(path.join(HLTV_DIR, rec.hltv));
  if (!page) throw new Error(`${rec.hltv}: not a v3 HLTV map page`);
  const f = derive(t, WINPROB);
  const j = joinFromRecord(f.players, rec, page);
  maps++;
  // let the write streams open and drain: derive is synchronous, so without a turn of the event loop
  // every row would wait in memory until the end
  await new Promise((r) => setImmediate(r));
  const demo = mapLabel(dir);
  const pid = (pi: number | null) => (pi === null ? null : j.player.get(pi)?.pid ?? null);
  const nick = (pi: number) => j.player.get(pi)?.nick;
  for (const r of f.pr) {
    const p = pid(r.pi);
    if (p === null) continue;
    const rf = f.rounds[r.ri];
    const hs = j.hltv.swingPerRound.get(nick(r.pi)!)?.[rf.number - 1];
    rows.write(JSON.stringify({
      hltv: j.hltv.file, demo, pid: p, ri: r.ri, number: rf.number, side: r.side, won: r.won, reason: rf.reason,
      equip: r.equip, primary: r.primary, ownBuy: r.ownBuy, oppBuy: r.oppBuy, teamEquip: rf.equip[r.side], oppEquip: rf.equip[r.side === "CT" ? "T" : "CT"],
      hltvSwing: hs ?? null, m: r.m,
    }) + "\n");
    n++;
  }
  for (const rf of f.rounds) {
    paths.write(JSON.stringify({ hltv: j.hltv.file, ri: rf.ri, number: rf.number, winner: rf.winner, reason: rf.reason, ctTeam: rf.ctTeam, endTick: rf.endTick, plantTick: rf.plantTick, buy: rf.buy, equip: rf.equip, path: rf.winProb }) + "\n");
  }
  joined.write(JSON.stringify(joinRow(rec, j, dir)) + "\n");
  for (const row of killRows(f, t, j)) kills.write(JSON.stringify(row) + "\n");
  for (const row of hitRows(f, t, j)) hits.write(JSON.stringify(row) + "\n");
}
// no joined map (a wrong CS2_DEMO_JOINS, an empty demos folder) must not replace the last dump with nothing
await finishPartials(files, path.join(OUT, "rating-rounds.private.jsonl"),
  `the rating dump (${maps} of ${joins.size} accepted joins read, no player-round written)`);
const missing = [...joins.keys()].filter((k) => !found.has(k));
if (missing.length) console.error(`${missing.length} accepted joins have no complete tables folder now: ${missing.slice(0, 5).join(", ")}`);
console.log(`joined ${maps} maps, ${n} player-rounds -> ${OUT}`);
