// The pro match library for the dev and preview servers (vite.config.ts): the folder named by
// CS2_PRO_LIBRARY, laid out as the extractor publishes (its demos folder, or the data folder above it).
// src-tauri/src/pro.rs implements the same rules for the desktop app, where the user picks the folder.
// Nothing here writes: listing and reading are readdir, stat and readFile. A map is listed as
// "pro/<series>/<map>" (flat) or "pro/<series>/<map>/<version folder>" (versioned).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { mapTablesDir, VERSION_DIR } from "./map-dir";

export interface ProEntry { file: string; size: number; mtime: number }
export interface ProListing {
  /** the library folder; null when none is set */
  folder: string | null;
  files: ProEntry[];
  /** map folders with no complete map now, and why */
  skipped: { file: string; why: string }[];
  /** why the folder could not be listed at all */
  error: string | null;
}

/** A request for a path that is not a pro library map or table: the caller's mistake, not the folder's. */
export class ProPathError extends Error {}

export const proRoot = (env: NodeJS.ProcessEnv = process.env) => (env.CS2_PRO_LIBRARY ? path.resolve(env.CS2_PRO_LIBRARY) : null);

const NAME = /^[A-Za-z0-9_.-]+$/;
const isName = (s: string) => NAME.test(s) && s !== "." && s !== "..";
const TABLE = /^[a-z0-9_]+\.parquet$/;

/** The folder whose subfolders are series: the library folder, or its demos folder. */
const seriesRoot = (folder: string) => (existsSync(path.join(folder, "demos")) ? path.join(folder, "demos") : folder);

/** Whether p, with links resolved, lies inside root's own resolved path. */
function inside(root: string, p: string): boolean {
  try {
    return realpathSync.native(p).startsWith(realpathSync.native(root) + path.sep);
  } catch {
    return false;
  }
}

/** A flat map folder's plain table files that resolve inside root, with their sizes. */
function flatTables(root: string, dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (TABLE.test(f) && inside(root, p) && statSync(p).isFile()) out[f] = statSync(p).size;
  }
  return out;
}

/**
 * Each map folder's last answer, by folder, with the stamp it was given under: the CURRENT pointer and
 * the stat of the file that completes the map (the version's COMPLETE, or match.parquet in a flat
 * folder). A version folder never changes once COMPLETE is written (SCHEMA-v1.md), so a map whose stamp
 * is unchanged keeps its answer and the next listing makes three file calls for it instead of one per
 * table: a full listing of 1,080 maps took 40 s on this machine. Reads still check each table's size.
 */
const answers = new Map<string, { stamp: string; file?: ProEntry; skipped?: string }>();

function stampOf(dir: string): string {
  let pointer = "";
  try { pointer = readFileSync(path.join(dir, "CURRENT"), "utf-8").trim(); } catch { /* a flat folder, or none */ }
  const done = path.join(dir, pointer, pointer ? "COMPLETE" : "match.parquet");
  try {
    const st = statSync(done);
    return `${pointer}|${st.size}|${st.mtimeMs}|${existsSync(path.join(dir, "RETIRED"))}`;
  } catch {
    return `${pointer}|missing|${existsSync(path.join(dir, "RETIRED"))}`;
  }
}

export function listPro(folder: string): ProListing {
  const out: ProListing = { folder, files: [], skipped: [], error: null };
  const root = seriesRoot(folder);
  let series: string[];
  try {
    series = readdirSync(root);
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
  for (const s of series) {
    if (!isName(s) || !statSync(path.join(root, s)).isDirectory()) continue;
    for (const m of readdirSync(path.join(root, s))) {
      const dir = path.join(root, s, m);
      if (!isName(m) || !statSync(dir).isDirectory()) continue;
      const rel = `pro/${s}/${m}`;
      const stamp = stampOf(dir);
      let a = answers.get(dir);
      if (a?.stamp !== stamp) {
        a = { stamp, ...mapAnswer(root, dir, rel) };
        answers.set(dir, a);
      }
      if (a.file) out.files.push(a.file);
      else if (a.skipped) out.skipped.push({ file: rel, why: a.skipped });
    }
  }
  out.files.sort((a, b) => b.file.localeCompare(a.file));
  return out;
}

/** One map folder's entry, why it has none, or neither when it holds no map. */
function mapAnswer(root: string, dir: string, rel: string): { file?: ProEntry; skipped?: string } {
  try {
    const r = mapTablesDir(dir);
    if (!r) return {};
    if ("skipped" in r) return { skipped: r.skipped };
    if (!inside(root, path.join(r.dir, "match.parquet"))) return { skipped: "resolves outside the library" };
    if (r.manifest) {
      const at = path.join(r.dir, "COMPLETE");
      return { file: { file: `${rel}/${path.basename(r.dir)}`, size: Object.values(r.manifest).reduce((x, y) => x + y, 0), mtime: Math.round(statSync(at).mtimeMs) } };
    }
    const sizes = flatTables(root, r.dir);
    return { file: { file: rel, size: Object.values(sizes).reduce((x, y) => x + y, 0), mtime: Math.round(statSync(path.join(r.dir, "match.parquet")).mtimeMs) } };
  } catch (e) {
    return { skipped: (e as Error).message };
  }
}

/**
 * One read under the library: rel is the listed file without "pro/", "<series>/<map>[/<version>]" (the
 * map's table file names, as JSON), or that with "/<table>.parquet" (one of the map's tables).
 */
export function readPro(folder: string, rel: string): Buffer {
  const parts = rel.split("/");
  const bad = () => new ProPathError(`${rel}: not a pro library path (<series>/<map>[/<version folder>][/<table>.parquet])`);
  if (parts.length < 2 || parts.length > 4 || !isName(parts[0]) || !isName(parts[1])) throw bad();
  const rest = parts.slice(2);
  const version = rest[0] && VERSION_DIR.test(rest[0]) ? rest[0] : null;
  const table = rest[version ? 1 : 0] ?? null;
  if (rest.length > (version ? 2 : 1) || (table !== null && !TABLE.test(table))) throw bad();
  const root = seriesRoot(folder);
  const map = path.join(root, parts[0], parts[1]);
  let dir: string, sizes: Record<string, number>;
  if (version) {
    dir = path.join(map, version);
    const complete = path.join(dir, "COMPLETE");
    if (!inside(root, complete)) throw new Error(`${rel}: this version is gone; rescan`);
    sizes = JSON.parse(readFileSync(complete, "utf-8")) as Record<string, number>;
    if (Object.keys(sizes).some((f) => !TABLE.test(f))) throw new Error(`${rel}: COMPLETE lists a name that is not a table file`);
  } else {
    if (!inside(root, path.join(map, "match.parquet"))) throw new Error(`${rel}: no map here; rescan`);
    dir = map;
    sizes = flatTables(root, map);
  }
  if (table === null) return Buffer.from(JSON.stringify(Object.keys(sizes).sort()));
  if (!(table in sizes)) throw new Error(`${rel}: not one of this map's tables`);
  if (!inside(root, path.join(dir, table))) throw new ProPathError(`${rel}: resolves outside the library`);
  const bytes = readFileSync(path.join(dir, table));
  if (version && bytes.length !== sizes[table]) throw new Error(`${rel}: ${bytes.length} bytes, not the ${sizes[table]} COMPLETE lists; rescan`);
  return bytes;
}
