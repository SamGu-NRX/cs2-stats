// Per-map cost of the stats worker's path over the pro library, and a hash of what it produces:
//   pnpm perf-maps [--n 60 | --all] [--of 2 --shard 0] [--hashes out.json]
// Each map is read, derived and turned into its match entry, match bundle and round bundles, as the
// worker does (worker/stats.worker.ts, views.ts). The table gives each step's median, 90th percentile,
// maximum and sum: times in ms, sizes in MB ("clone" is v8.serialize of the facts, close to what
// IndexedDB's structured clone costs). --hashes writes the sha256 of every output's JSON per map, so
// two builds can be compared output for output: a change meant only to make the app faster must
// leave every hash the same. --of and --shard split the maps between processes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { derive } from "../src/stats/derive";
import { loadTables } from "../src/stats/load";
import { entryOf, matchBundle, roundBundle } from "../src/worker/views";
import { DATA_DIR, proMapDirs, WINPROB } from "./node-read";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const all = proMapDirs();
if (!all.length) throw new Error(`no pro tables under ${DATA_DIR}/demos (set CS2_STATS_DATA)`);
const n = process.argv.includes("--all") ? all.length : Number(arg("--n", "60"));
const of = Number(arg("--of", "1")), shard = Number(arg("--shard", "0"));
const dirs = Array.from({ length: n }, (_, i) => all[Math.floor((i * all.length) / n)]).filter((_, i) => i % of === shard);
const hashOut = arg("--hashes", "");
const hashes: Record<string, string> = {};
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const rows: Record<string, number>[] = [];
const time = <T>(f: () => T): [T, number] => { const t0 = performance.now(); const r = f(); return [r, performance.now() - t0]; };

for (const dir of dirs) {
  let reads = 0, bytes = 0;
  const t0 = performance.now();
  const t = await loadTables(async (name) => {
    reads++;
    const p = path.join(dir, name);
    if (!existsSync(p)) return null;
    const b = readFileSync(p);
    bytes += b.byteLength;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
  const load = performance.now() - t0;
  const [f, deriveMs] = time(() => derive(t, WINPROB));
  const json = JSON.stringify(f);
  const [ser, cloneOut] = time(() => serialize({ facts: f, origin: "" }));
  const [, cloneIn] = time(() => deserialize(ser));
  // a pro map has no recording player (match.pov); its first player stands in for the entry and bundle
  const ff = f.players.some((p) => p.id === f.match.pov) ? f : { ...f, match: { ...f.match, pov: f.players[0].id } };
  const [e, entry] = time(() => entryOf("dev/map", "", ff));
  const [mb, bundle] = time(() => matchBundle(e, ff));
  const [rb, rounds] = time(() => ff.rounds.map((r) => roundBundle(ff, r.number)));
  if (hashOut) {
    const key = path.relative(DATA_DIR, dir);
    hashes[key] = sha(json);
    hashes[`${key}#entry`] = sha(JSON.stringify(e));
    hashes[`${key}#bundle`] = sha(JSON.stringify(mb));
    hashes[`${key}#rounds`] = sha(JSON.stringify(rb));
  }
  rows.push({ reads, readMB: bytes / 1e6, load, derive: deriveMs, factsMB: json.length / 1e6, cloneOut, cloneIn, entry, bundle, rounds });
}

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
console.log(`maps ${rows.length} of ${all.length}`);
console.log("".padEnd(9), "median".padStart(9), "p90".padStart(9), "max".padStart(9), "sum".padStart(10));
for (const k of Object.keys(rows[0] ?? {})) {
  const xs = rows.map((r) => r[k]);
  console.log(k.padEnd(9), q(xs, 0.5).toFixed(2).padStart(9), q(xs, 0.9).toFixed(2).padStart(9), Math.max(...xs).toFixed(2).padStart(9), xs.reduce((a, b) => a + b, 0).toFixed(1).padStart(10));
}
if (hashOut) writeFileSync(hashOut, JSON.stringify(hashes, null, 1));
