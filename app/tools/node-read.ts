// Node helpers for the engine CLIs and tests: read one map's parquet folder, and find the pro maps.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadTables, type ReadFile } from "../src/stats/load";
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

export const loadDir = (dir: string, optional?: readonly TableName[]): Promise<MatchTables> => loadTables(dirReader(dir), optional);

/** One map folder resolved: its tables folder, or why it has no complete map now. */
export type MapTables = { dir: string } | { skipped: string };

const VERSION_DIR = /^v-[0-9A-Za-z.+_]+-[0-9a-f]{8}$/;

/**
 * Where one map's tables are, by SCHEMA-v1.md "Finding a map's tables": a RETIRED map is skipped; a
 * CURRENT pointer names a version folder (refused unless the name has the version-folder form), which
 * counts only once its COMPLETE file lists every table at its size on disk; otherwise the flat folder
 * written before versioned output (match.parquet, or meta.parquet before schema v1). Null when the
 * folder holds no map at all.
 */
export function mapTablesDir(mapDir: string): MapTables | null {
  if (existsSync(path.join(mapDir, "RETIRED"))) return { skipped: "retired, a re-extraction replaced it" };
  const pointer = path.join(mapDir, "CURRENT");
  if (existsSync(pointer)) {
    const name = readFileSync(pointer, "utf-8").trim();
    if (!VERSION_DIR.test(name)) throw new Error(`${pointer} names "${name}", which is not a version folder (v-<version>-<8 hex>)`);
    const dir = path.join(mapDir, name);
    const complete = path.join(dir, "COMPLETE");
    if (!existsSync(complete)) return { skipped: `${name} has no COMPLETE file yet` };
    const sizes = JSON.parse(readFileSync(complete, "utf-8")) as Record<string, number>;
    for (const [file, bytes] of Object.entries(sizes)) {
      const f = path.join(dir, file);
      if (!existsSync(f) || statSync(f).size !== bytes) return { skipped: `${name}/${file} is not at its listed ${bytes} bytes` };
    }
    return { dir };
  }
  return existsSync(path.join(mapDir, "match.parquet")) || existsSync(path.join(mapDir, "meta.parquet")) ? { dir: mapDir } : null;
}

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

/**
 * Every pro map's tables, one at a time. The extractor publishes a version by renaming CURRENT, so a
 * file that vanishes while it is read means the map was just republished: it is resolved once more
 * and read again, and skipped by name only when it then has no complete version. Any other load
 * error throws.
 */
export async function* proMaps(optional?: readonly TableName[]): AsyncGenerator<{ dir: string; t: MatchTables }> {
  for (const m of mapFolders()) {
    let r = mapTablesDir(m);
    for (let attempt = 0; r; attempt++) {
      if (!("dir" in r)) { skip(m, r.skipped); break; }
      try {
        yield { dir: r.dir, t: await loadDir(r.dir, optional) };
        break;
      } catch (e) {
        const again = mapTablesDir(m);
        const vanished = !existsSync(path.join(r.dir, "match.parquet")) && !existsSync(path.join(r.dir, "meta.parquet"));
        if (attempt > 0 || !(vanished || (again && "dir" in again && again.dir !== r.dir))) throw e;
        r = again;
      }
    }
  }
}

/** "<archive>/<map>" for a tables folder from proMapDirs, for messages. */
export const mapLabel = (dir: string) => path.relative(path.join(DATA_DIR, "demos"), dir).split(path.sep).filter((s) => !s.startsWith("v-")).join("/");
