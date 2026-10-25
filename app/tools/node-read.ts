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
