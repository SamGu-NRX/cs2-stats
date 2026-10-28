// Writes the engine's per-player-round rows for every pro map joined to HLTV, beside HLTV's own
// per-round swing, for the Rating 3.0 fits in model/rating3 (fit_params.py, swing_credit_fit.py). The joins
// are model/rating3/join_demos.py's (<data>/model-rating3/demo_joins.json, or CS2_DEMO_JOINS): its HLTV page,
// map_*.json or ocs_map_*.json, and its pairing of SteamIDs with HLTV players, so a renamed player pairs. Four
// private JSONL files land in <cs2-stats-data>/model-rating3: player-round rows (every measure the
// engine fills), kill rows (both players' economy state and the swing credits), enemy-hit rows (damage
// per hit) and each round's win-probability path. Each is written beside its final name and renamed
// into place at the end, so a reader never sees a half-written file.
// Usage: pnpm rating-dump
import { createWriteStream, mkdirSync, readFileSync, renameSync, type WriteStream } from "node:fs";
import path from "node:path";
import { derive, enemyHit, hitDamage } from "../src/stats/derive";
import { rosterTables } from "../src/stats/roster";
import { acceptedJoins, joinFromRecord } from "./demo-joins";
import { HLTV_DIR, parseHltvMap } from "./hltv";
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
  // the kills table's economy columns, by (tick, victim), for every enemy kill
  const rt = rosterTables(t);
  const k = rt.kills;
  const at = new Map<string, number>();
  for (let i = 0; i < k.n; i++) at.set(`${k.tick[i]}:${k.victim_steamid[i]}`, i);
  for (const kf of f.kills) {
    const i = at.get(`${kf.tick}:${f.players[kf.victim].id}`);
    if (i === undefined) continue;
    kills.write(JSON.stringify({
      hltv: j.hltv.file, ri: kf.ri, tick: kf.tick, t: kf.t, killer: pid(kf.killer), victim: pid(kf.victim), assister: pid(kf.assister),
      flashAssist: kf.flashAssist, enemy: kf.enemy, killerSide: kf.killerSide, victimSide: kf.victimSide, weapon: kf.weapon,
      opening: kf.opening, traded: kf.traded, tradeKill: kf.tradeKill, ecoPoints: kf.ecoPoints, headshot: kf.headshot,
      aPrimary: k.a_best_primary[i], vPrimary: k.v_best_primary[i], aEquip: k.a_equip_value_game[i], vEquip: k.v_equip_value_game[i],
      aHealth: k.a_health[i], vActive: k.v_active_weapon[i], aActive: k.a_active_weapon[i], aArmor: k.a_armor[i], vArmor: k.v_armor[i],
      aHelmet: k.a_helmet[i], vHelmet: k.v_helmet[i],
      postEnd: kf.tick > f.rounds[kf.ri].endTick,
      credits: kf.credits.map(([p, v]) => [pid(p), v]),
    }) + "\n");
  }
  for (const rf of f.rounds) {
    paths.write(JSON.stringify({ hltv: j.hltv.file, ri: rf.ri, number: rf.number, winner: rf.winner, reason: rf.reason, ctTeam: rf.ctTeam, endTick: rf.endTick, plantTick: rf.plantTick, buy: rf.buy, equip: rf.equip, path: rf.winProb }) + "\n");
  }
  const d = rt.damages;
  const riOf = new Map(f.rounds.map((r) => [r.number, r.ri]));
  const idx = new Map(f.players.map((p, i) => [p.id, i]));
  for (let i = 0; i < d.n; i++) {
    if (!enemyHit(rt, i)) continue;
    const ri = riOf.get(d.round[i]);
    if (ri === undefined) continue;
    hits.write(JSON.stringify({
      hltv: j.hltv.file, ri, tick: d.tick[i], attacker: pid(idx.get(d.attacker_steamid[i]!) ?? null), victim: pid(idx.get(d.victim_steamid[i]) ?? null),
      dmg: hitDamage(rt, i), hpBefore: d.health_before[i], weapon: d.weapon[i], aSide: d.a_side[i], postEnd: d.tick[i] > f.rounds[ri].endTick,
    }) + "\n");
  }
}
await Promise.all(files.map(([s, file]) => new Promise<void>((done, fail) => {
  s.on("error", fail);
  s.end(() => { renameSync(`${file}.partial`, file); done(); });
})));
const missing = [...joins.keys()].filter((k) => !found.has(k));
if (missing.length) console.error(`${missing.length} accepted joins have no complete tables folder now: ${missing.slice(0, 5).join(", ")}`);
console.log(`joined ${maps} maps, ${n} player-rounds -> ${OUT}`);
