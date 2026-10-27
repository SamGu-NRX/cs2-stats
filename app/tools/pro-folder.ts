// The pro match library for the dev and preview servers (vite.config.ts): the folder named by
// CS2_PRO_LIBRARY, laid out as the extractor publishes (its demos folder, or the data folder above it).
// src-tauri/src/pro.rs implements the same rules for the desktop app, where the user picks the folder.
// Nothing here writes: listing and reading are readdir, stat and readFile. A map is listed as
// "pro/<series>/<map>" (flat) or "pro/<series>/<map>/<version folder>" (versioned).
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { VERSION_DIR } from "./map-dir";

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
 * Every map of the library that is complete now. A version folder counts once its COMPLETE file exists
 * and a flat folder (the extractor's output from before version folders, never rewritten) once its
 * match.parquet does; each is keyed by that file's size and time, and a map's tables are checked as each
 * is read (readPro). The walk reads directory entries, so a folder or file that is a link shows as one:
 * only a map with a link on its path costs a realpath to prove it stays inside the library. Checking
 * every table of every map made a listing of 1,080 maps take 40 s on this machine.
 */
export function listPro(folder: string): ProListing {
  const out: ProListing = { folder, files: [], skipped: [], error: null };
  const root = seriesRoot(folder);
  let series: Dirent[];
  try {
    series = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
  for (const s of series) {
    if (!isName(s.name) || !(s.isDirectory() || s.isSymbolicLink())) continue;
    let maps: Dirent[];
    try { maps = readdirSync(path.join(root, s.name), { withFileTypes: true }); } catch { continue; }
    for (const m of maps) {
      if (!isName(m.name) || !(m.isDirectory() || m.isSymbolicLink())) continue;
      const rel = `pro/${s.name}/${m.name}`;
      const a = mapAnswer(root, path.join(root, s.name, m.name), rel, s.isSymbolicLink() || m.isSymbolicLink());
      if (a.file) out.files.push(a.file);
      else if (a.skipped) out.skipped.push({ file: rel, why: a.skipped });
    }
  }
  out.files.sort((a, b) => b.file.localeCompare(a.file));
  return out;
}

/** One map folder's entry, why it has none, or neither when it holds no map. `linked`: a link is on the path so far. */
function mapAnswer(root: string, dir: string, rel: string, linked: boolean): { file?: ProEntry; skipped?: string } {
  try {
    const names = new Map(readdirSync(dir, { withFileTypes: true }).map((d) => [d.name, d]));
    if (names.has("RETIRED")) return { skipped: "retired" };
    const pointer = names.get("CURRENT");
    let file: string, done: string, link = linked;
    if (pointer) {
      const v = readFileSync(path.join(dir, "CURRENT"), "utf-8").trim();
      if (!VERSION_DIR.test(v)) return { skipped: `CURRENT names "${v}", which is not a version folder` };
      const vdir = names.get(v);
      if (!vdir) return { skipped: `${v}: no such version folder` };
      done = path.join(dir, v, "COMPLETE");
      file = `${rel}/${v}`;
      link ||= pointer.isSymbolicLink() || vdir.isSymbolicLink();
    } else {
      const first = names.get("match.parquet");
      if (!first) return {};
      done = path.join(dir, "match.parquet");
      file = rel;
      link ||= first.isSymbolicLink();
    }
    let st;
    try { st = lstatSync(done); } catch { return { skipped: `${path.basename(path.dirname(done))}: no COMPLETE file yet` }; }
    if ((link || st.isSymbolicLink()) && !inside(root, done)) return { skipped: "resolves outside the library" };
    return { file: { file, size: st.size, mtime: Math.round(st.mtimeMs) } };
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
