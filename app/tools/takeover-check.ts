// Compares the plugin adapter's per-player, per-round kills, deaths, assists and damage with the game's
// own round stats, on a folder of plugin match files. Usage: pnpm takeover-check <folder> [--misses]
// (--misses prints each player-round that disagrees).
//
// The plugin checks each round against CSPerRoundStats_t as it records (recon): recon.mismatch holds
// the game's value wherever the plugin's tally differed, and every other checked player-round matched
// that tally. This tool rebuilds the tally from the file's rows as the plugin kept it (recon-tally.ts)
// and uses it as the game's value off the mismatch list. A rebuilt tally that differs from a mismatch
// row's "ours" is counted and printed, since the comparison then rests on a wrong reconstruction.
// Rounds where the plugin could not read every player are skipped, because the file does not say which
// players it read (recon-tally.ts coverage).
//
// Damage agrees as the plugin's own check does (plugin/Core/Recon.cs): the game's figure may exceed
// ours by up to one HP per hit. Off the mismatch list the game's figure is known only to lie in
// [tally, tally + hits], so the adapter agrees when its own range [dmg, dmg + hits] meets that one.
//
// It also prints each file's score, the recording player's ADR, and how the round-result recovery
// (plugin/results.ts) fares on the rounds whose result the file does hold.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { derive, enemyHit } from "../src/stats/derive";
import { CS2RB } from "../src/stats/model-params";
import { pluginToTables } from "../src/stats/plugin/adapter";
import { bodyLookup } from "../src/stats/plugin/bodies";
import { decodeMatch } from "../src/stats/plugin/decode";
import { checkResultRules } from "../src/stats/plugin/results";
import { coverage, tallies, type Field } from "./recon-tally";

const dir = process.argv[2];
if (!dir) throw new Error("usage: pnpm takeover-check <folder of .json.gz match files> [--misses]");
const misses = process.argv.includes("--misses");

const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".json.gz")) files.push(p);
  }
};
walk(dir);
if (!files.length) throw new Error(`${dir}: no .json.gz match files`);

const FIELDS: Field[] = ["k", "d", "a", "dmg"];
const total = Object.fromEntries(FIELDS.map((f) => [f, { ok: 0, bad: 0, listedOk: 0, listed: 0 }])) as Record<Field, { ok: number; bad: number; listedOk: number; listed: number }>;
const rules = { known: 0, agree: 0, disagree: 0, undecided: 0, finalKnown: 0, finalAgree: 0, finalDisagree: 0, finalUndecided: 0, howKnown: 0, howAgree: 0, howDisagree: 0, howUndecided: 0, recovered: 0, howRecovered: 0 };
let skippedRounds = 0;
let badTally = 0;

const fmt = (x: number) => x.toFixed(1);
for (const file of files.sort()) {
  const m = await decodeMatch(readFileSync(file), file);
  const t = pluginToTables(m);
  const f = derive(t, CS2RB);
  const key = m.players.key;

  // the adapter's figures per (round index, player index)
  const ours = new Map<string, Record<Field | "hits", number>>();
  const at = (ri: number, pi: number) => {
    const k = `${ri}:${pi}`;
    let v = ours.get(k);
    if (!v) ours.set(k, (v = { k: 0, d: 0, a: 0, dmg: 0, hits: 0 }));
    return v;
  };
  for (const r of f.pr) {
    const x = at(f.rounds[r.ri].number - 1, key.indexOf(f.players[r.pi].id));
    x.k = r.m.kills ?? 0;
    x.d = r.m.deaths ?? 0;
    x.a = r.m.assists ?? 0;
    x.dmg = r.m.dmg ?? 0;
  }
  for (let i = 0; i < t.damages.n; i++) {
    if (!enemyHit(t, i)) continue;
    at(t.damages.round[i] - 1, key.indexOf(t.damages.attacker_steamid[i]!)).hits++;
  }

  const tally = tallies(m);
  // enemy damage per round that the adapter leaves out because the file names no body for it
  const bodyAt = bodyLookup(m);
  const unnamed = new Map<number, number>();
  for (let i = 0; i < m.damage.ri.length; i++) {
    const a = m.damage.attacker[i], ri = m.damage.ri[i];
    if (a === null || bodyAt(a, ri, m.damage.tick[i]) !== null) continue;
    const sa = m.rounds.side[ri]?.[a], sv = m.rounds.side[ri]?.[m.damage.victim[i]];
    if (sa != null && sv != null && sa !== sv) unnamed.set(ri, (unnamed.get(ri) ?? 0) + m.damage.dmg[i]);
  }
  const mism = new Map<string, number>();
  const mm = m.recon?.mismatch;
  for (let i = 0; i < (mm?.ri.length ?? 0); i++) {
    const field = mm!.field[i] as Field;
    mism.set(`${mm!.ri[i]}:${mm!.pi[i]}:${field}`, mm!.game[i]);
    if (tally(mm!.ri[i], mm!.pi[i])[field] !== mm!.ours[i]) {
      badTally++;
      console.log(`  tally rebuild differs: ${path.basename(file)} round ${mm!.ri[i] + 1} player ${mm!.pi[i]} ${field}: rebuilt ${tally(mm!.ri[i], mm!.pi[i])[field]}, plugin ${mm!.ours[i]}`);
    }
  }

  const here = Object.fromEntries(FIELDS.map((x) => [x, { ok: 0, bad: 0 }])) as Record<Field, { ok: number; bad: number }>;
  const rr = m.recon?.rounds;
  for (let j = 0; j < (rr?.ri.length ?? 0); j++) {
    const ri = rr!.ri[j];
    const { checked, expected } = coverage(rr!, j);
    if (!checked) continue;
    if (checked !== expected) { skippedRounds++; continue; }
    m.rounds.side[ri].forEach((side, pi) => {
      if (side === null) return;
      const a = ours.get(`${ri}:${pi}`) ?? { k: 0, d: 0, a: 0, dmg: 0, hits: 0 };
      const tl = tally(ri, pi);
      for (const field of FIELDS) {
        const game = mism.get(`${ri}:${pi}:${field}`);
        let ok: boolean;
        if (field !== "dmg") ok = a[field] === (game ?? tl[field]);
        else if (game !== undefined) ok = game - a.dmg >= 0 && game - a.dmg <= a.hits;
        else ok = a.dmg <= tl.dmg + tl.hits && tl.dmg <= a.dmg + a.hits;
        if (!ok && misses) console.log(`  miss ${path.basename(file)} round ${ri + 1} player ${pi}${m.players.isBot[pi] ? " (bot)" : ""} ${field}: ours ${a[field]} (${a.hits} hits), game ${game ?? `tally ${tl[field]}`}${unnamed.has(ri) ? `; ${unnamed.get(ri)} damage in this round has no named body` : ""}`);
        here[field][ok ? "ok" : "bad"]++;
        total[field][ok ? "ok" : "bad"]++;
        if (game !== undefined) { total[field].listed++; if (ok) total[field].listedOk++; }
      }
    });
  }

  const r = checkResultRules(m);
  for (const k of Object.keys(rules) as (keyof typeof rules)[]) rules[k] += r[k];

  const human = m.players.key[m.human];
  const hp = f.pr.filter((x) => f.players[x.pi].id === human);
  const adr = hp.length ? hp.reduce((s, x) => s + (x.m.dmg ?? 0), 0) / hp.length : NaN;
  const us = f.players[f.players.findIndex((p) => p.id === human)]?.team ?? 0;
  const score = `${f.match.score[us]}-${f.match.score[1 - us]}`;
  const agree = FIELDS.map((x) => `${x} ${here[x].ok}/${here[x].ok + here[x].bad}`).join("  ");
  console.log(`${path.basename(file)}  rounds ${m.rounds.winSide.length}  score ${score}  ADR ${fmt(adr)}  ${agree}`);
}

console.log("\nagreement with the game's round stats, player-rounds:");
for (const x of FIELDS) {
  const t = total[x];
  console.log(`  ${x}: ${t.ok} of ${t.ok + t.bad} agree; on the mismatch list ${t.listedOk} of ${t.listed}, off it ${t.ok - t.listedOk} of ${t.ok + t.bad - t.listed}`);
}
console.log(`  rounds skipped because not every player was read: ${skippedRounds}; mismatch rows the rebuilt tally does not reproduce: ${badTally}`);
console.log("\nround-result recovery checked on rounds the file holds:");
console.log(`  from the next round's score: ${rules.agree} agree, ${rules.disagree} disagree, ${rules.undecided} undecided, of ${rules.known}`);
console.log(`  final round of a complete match: ${rules.finalAgree} agree, ${rules.finalDisagree} disagree, ${rules.finalUndecided} undecided, of ${rules.finalKnown}`);
console.log(`  how the round ended: ${rules.howAgree} agree, ${rules.howDisagree} disagree, ${rules.howUndecided} undecided, of ${rules.howKnown}`);
console.log(`  winners recovered: ${rules.recovered}, with how: ${rules.howRecovered}`);
