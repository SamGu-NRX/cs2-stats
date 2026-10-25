// Node helpers for the engine CLIs and tests: read one map's parquet folder, and find the pro maps.
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * The folder holding one map's tables. The extractor writes each map to a versioned folder
 * (<map>/v-<version>-<hash>/) and names the live one in <map>/CURRENT (SCHEMA-v1.md); older output is
 * the flat <map>/ folder. Null when the map has no tables yet. A CURRENT naming a folder without
 * tables throws, naming both.
 */
export function mapTablesDir(mapDir: string): string | null {
  const pointer = path.join(mapDir, "CURRENT");
  const has = (dir: string) => existsSync(path.join(dir, "match.parquet")) || existsSync(path.join(dir, "meta.parquet"));
  if (existsSync(pointer)) {
    const live = path.join(mapDir, readFileSync(pointer, "utf-8").trim());
    if (!has(live)) throw new Error(`${pointer} names ${live}, which holds no tables`);
    return live;
  }
  return has(mapDir) ? mapDir : null;
}

/** Every extracted pro map's tables folder: demos/<archive>/<map>/, through mapTablesDir. */
export function proMapDirs(root = path.join(DATA_DIR, "demos")): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const a of readdirSync(root, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    for (const m of readdirSync(path.join(root, a.name), { withFileTypes: true })) {
      const dir = m.isDirectory() ? mapTablesDir(path.join(root, a.name, m.name)) : null;
      if (dir) out.push(dir);
    }
  }
  return out.sort();
}

/**
 * Every pro map's tables, one at a time. The extraction pipeline replaces folders while it runs (until
 * PR #16 makes the replacement atomic), so a map whose tables vanish between listing and reading is
 * skipped with a line on stderr naming it; any other load error throws.
 */
export async function* proMaps(optional?: readonly TableName[]): AsyncGenerator<{ dir: string; t: MatchTables }> {
  for (const dir of proMapDirs()) {
    let t: MatchTables;
    try {
      t = await loadDir(dir, optional);
    } catch (e) {
      if (existsSync(path.join(dir, "match.parquet")) || existsSync(path.join(dir, "meta.parquet"))) throw e;
      console.error(`SKIPPED ${mapLabel(dir)}: its tables were removed while reading (${(e as Error).message})`);
      continue;
    }
    yield { dir, t };
  }
}

/** "<archive>/<map>" for a tables folder from proMapDirs, for messages. */
export const mapLabel = (dir: string) => path.relative(path.join(DATA_DIR, "demos"), dir).split(path.sep).filter((s) => !s.startsWith("v-")).join("/");
