// Node helpers for the engine CLIs and tests: read one map's parquet folder, and find the pro maps.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadTables, type ReadFile } from "../src/stats/load";
import { mapTablesDir } from "./map-dir";
import { winProbSource } from "../src/stats/model-params";
import type { MatchTables, TableName } from "../src/stats/tables";

/** The private data folder; override with CS2_STATS_DATA. */
export const DATA_DIR = process.env.CS2_STATS_DATA ?? path.resolve(import.meta.dirname, "../../../cs2-stats-data");

export function dirReader(dir: string): ReadFile {
  return async (name) => {
    const p = path.join(dir, name);
    if (!existsSync(p)) return null;
    const b = readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
}

/**
 * The round win-probability source the tools derive with: HLTV's lookup from the private pack
 * (%APPDATA%\BotMatchStats\packs\winprob-hltv.json, or CS2_WINPROB_PACK) when present, else CS2RB.
 * Results that depend on swing (Rating 3.0, swing, the baselines) name the source they used.
 */
const PACK = process.env.CS2_WINPROB_PACK ?? (process.env.APPDATA ? path.join(process.env.APPDATA, "BotMatchStats", "packs", "winprob-hltv.json") : "");
export const WINPROB = winProbSource(PACK && existsSync(PACK) ? JSON.parse(readFileSync(PACK, "utf-8")) : null);

export { mapTablesDir, type MapTables } from "./map-dir";

export const loadDir = (dir: string, optional?: readonly TableName[]): Promise<MatchTables> => loadTables(dirReader(dir), optional);

/** Every map folder under demos/<archive>/<map>/. */
function mapFolders(root = path.join(DATA_DIR, "demos")): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const a of readdirSync(root, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    for (const m of readdirSync(path.join(root, a.name), { withFileTypes: true })) if (m.isDirectory()) out.push(path.join(root, a.name, m.name));
  }
  return out.sort();
}

const skip = (mapDir: string, why: string) => console.error(`SKIPPED ${mapLabel(mapDir)}: ${why}`);

/** Every pro map's complete tables folder now; maps without one are skipped by name on stderr. */
export function proMapDirs(): string[] {
  const out: string[] = [];
  for (const m of mapFolders()) {
    const r = mapTablesDir(m);
    if (r && "dir" in r) out.push(r.dir);
    else if (r) skip(m, r.skipped);
  }
  return out;
}

/** The version a map resolved to changed or lost a file while it was read. */
class Republished extends Error {}

/**
 * One resolved map's tables. For a version folder every read is held to the COMPLETE manifest: a file
 * it does not list is absent, a listed file must read at its listed size, and after loading every
 * listed file (optional tables included) must still be there at its size; otherwise the attempt is
 * discarded as Republished.
 */
export async function loadMapTables(r: { dir: string; manifest?: Record<string, number> }, optional?: readonly TableName[]): Promise<MatchTables> {
  const m = r.manifest;
  if (!m) return loadDir(r.dir, optional);
  const intact = (f: string) => { const p = path.join(r.dir, f); return existsSync(p) && statSync(p).size === m[f]; };
  const read = dirReader(r.dir);
  const t = await loadTables(async (name) => {
    if (!(name in m)) return null;
    let b: ArrayBuffer | null;
    try { b = await read(name); } catch { b = null; }
    if (!b || b.byteLength !== m[name]) throw new Republished(`${name} changed while it was read`);
    return b;
  }, optional);
  for (const f of Object.keys(m)) if (!intact(f)) throw new Republished(`${f} changed while the map was read`);
  return t;
}

/**
 * Every pro map's tables, one at a time. The extractor publishes a version by renaming CURRENT, so a
 * version that changes while it is read means the map was just republished: the whole attempt is
 * discarded, CURRENT is resolved again and read once more, and the map is skipped by name only when it
 * then has no complete version. For a flat folder, a vanished match table is the same case. Any other
 * load error throws.
 */
export async function* proMaps(optional?: readonly TableName[]): AsyncGenerator<{ dir: string; t: MatchTables }> {
  for (const m of mapFolders()) {
    let r = mapTablesDir(m);
    for (let attempt = 0; r; attempt++) {
      if (!("dir" in r)) { skip(m, r.skipped); break; }
      let t: MatchTables;
      try {
        t = await loadMapTables(r, optional);
      } catch (e) {
        const vanished = !r.manifest && !existsSync(path.join(r.dir, "match.parquet")) && !existsSync(path.join(r.dir, "meta.parquet"));
        if (!(e instanceof Republished) && !vanished) throw e;
        if (attempt > 0) { skip(m, (e as Error).message); break; }
        r = mapTablesDir(m);
        continue;
      }
      yield { dir: r.dir, t };
      break;
    }
  }
}

/** "<archive>/<map>" for a tables folder from proMapDirs, for messages. */
export const mapLabel = (dir: string) => path.relative(path.join(DATA_DIR, "demos"), dir).split(path.sep).filter((s) => !s.startsWith("v-")).join("/");
