// One match file to tables and facts, the same in the stats worker and in the derive workers that help
// it through a first scan (derive-pool.ts). Bytes come from `bytes`, which in both is a round trip to
// the UI thread, which owns the host.
import { deriveBase } from "../stats/derive";
import type { MatchFacts } from "../stats/facts";
import { rate, type RatingInputs } from "../stats/rate";
import { loadTables, withPov } from "../stats/load";
import type { WinProbSource } from "../stats/model-params";
import { pluginToTables } from "../stats/plugin/adapter";
import { decodeMatch } from "../stats/plugin/decode";
import type { MatchTables, TableName } from "../stats/tables";

export type Bytes = (file: string) => Promise<ArrayBuffer>;

/**
 * What IndexedDB keeps per file: the facts, rated with the model facts.match.model names; what rating
 * them again with another model needs from the file's tables (rate.ts); and the plugin's own label for
 * the file.
 */
export interface Cached { facts: MatchFacts; inputs: RatingInputs; origin: string }

/** An extracted match folder (host.ts: any path not ending in .json.gz), read table by table; else a plugin file. */
export const isFolder = (file: string) => !file.endsWith(".json.gz");

/**
 * An extracted folder's tables; reading the folder's path returns its table file names. `pov` is the
 * user's SteamID64 for a Valve match. `optional` and `columns`: what to read (loadTables).
 */
async function folderTables(file: string, bytes: Bytes, pov: string | undefined, optional?: readonly TableName[], columns?: Partial<Record<TableName, readonly string[]>>, between?: () => Promise<void>): Promise<MatchTables> {
  const names = new Set(JSON.parse(new TextDecoder().decode(await bytes(file))) as string[]);
  const t = await loadTables((name) => (names.has(name) ? bytes(`${file}/${name}`) : Promise.resolve(null)), optional, columns, between);
  return pov ? withPov(t, pov) : t;
}

/**
 * A file's tables, whichever kind of file it is. `optional` and `columns` narrow an extracted folder's
 * tables, and `between` runs between their decodes (loadTables); a plugin file is decoded whole either
 * way, so it gets them all.
 */
export async function fileTables(file: string, bytes: Bytes, pov: string | undefined, optional?: readonly TableName[], columns?: Partial<Record<TableName, readonly string[]>>, between?: () => Promise<void>): Promise<MatchTables> {
  return isFolder(file) ? folderTables(file, bytes, pov, optional, columns, between) : pluginToTables(await decodeMatch(await bytes(file), file));
}

export async function deriveFile(file: string, bytes: Bytes, pov: string | undefined, wp: WinProbSource): Promise<Cached> {
  const rated = (t: MatchTables, origin: string): Cached => {
    const { facts, inputs } = deriveBase(t);
    return { facts: rate(facts, inputs, wp), inputs, origin };
  };
  if (isFolder(file)) {
    const t = await folderTables(file, bytes, pov);
    return rated(t, `extracted, ${t.match.extractor_version[0]}`);
  }
  const m = await decodeMatch(await bytes(file), file);
  return rated(pluginToTables(m), m.env.plugin ?? "");
}
