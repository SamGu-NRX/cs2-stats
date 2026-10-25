// Node helpers for the engine CLIs and tests: read one map's parquet folder, and find the pro maps.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadTables, type ReadFile } from "../src/stats/load";
import type { MatchTables } from "../src/stats/tables";

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

export const loadDir = (dir: string): Promise<MatchTables> => loadTables(dirReader(dir));

/** Every extracted pro map: demos/<archive>/<map>/ folders holding meta.parquet or match.parquet. */
export function proMapDirs(root = path.join(DATA_DIR, "demos")): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const a of readdirSync(root, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    for (const m of readdirSync(path.join(root, a.name), { withFileTypes: true })) {
      const dir = path.join(root, a.name, m.name);
      if (m.isDirectory() && (existsSync(path.join(dir, "match.parquet")) || existsSync(path.join(dir, "meta.parquet")))) out.push(dir);
    }
  }
  return out.sort();
}
