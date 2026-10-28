// The pro match library for the dev and preview servers (vite.config.ts): the folder named by
// CS2_PRO_LIBRARY, laid out as the extractor publishes (its demos folder, or the data folder above it).
// src-tauri/src/pro.rs implements the same rules for the desktop app, where the user picks the folder.
// Nothing here writes: listing and reading are readdir, stat and readFile. A map is listed as
// "pro/<series>/<map>" (flat) or "pro/<series>/<map>/<version folder>" (versioned).
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import { VERSION_DIR } from "./map-dir";

export interface ProEntry { file: string; size: number; mtime: number }
export interface ProListing {
  /** the library folder; null when none is set */
  folder: string | null;
  /** the library's resolved path once the folder opens (pro.rs ProListing.library): part of every listed map's cache key */
  library: string | null;
  files: ProEntry[];
  /** map folders left out, and why */
  skipped: { file: string; why: string }[];
  /** how many of those are not whole yet (a table missing, empty or short of its listed size) */
  incomplete: number;
  /** why the folder could not be listed at all */
  error: string | null;
}

/** A request for a path that is not a pro library map or table: the caller's mistake, not the folder's. */
export class ProPathError extends Error {}

export const proRoot = (env: NodeJS.ProcessEnv = process.env) => (env.CS2_PRO_LIBRARY ? path.resolve(env.CS2_PRO_LIBRARY) : null);
/** The desktop app's data folder, which the library may not be, sit inside or hold (pro.rs open). */
const appDir = (env: NodeJS.ProcessEnv = process.env) => (env.APPDATA ? path.join(env.APPDATA, "BotMatchStats") : null);

const NAME = /^[A-Za-z0-9_.-]+$/;
const isName = (s: string) => NAME.test(s) && s !== "." && s !== "..";
const TABLE = /^[a-z0-9_]+\.parquet$/;

interface Library { canon: string; series: string }

const within = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

/** The chosen folder resolved, and the folder of series under it; or why it cannot be the library (pro.rs open). */
export function openLibrary(folder: string, app: string | null = appDir()): Library {
  const canon = realpathSync.native(folder);
  if (app) {
    let a = app;
    try { a = realpathSync.native(app); } catch { /* not created yet */ }
    if (within(canon, a) || within(a, canon)) {
      throw new Error(`${folder} is the app's own data folder, inside it or above it, and the app writes its settings there. Choose the extractor's demos folder instead.`);
    }
  }
  const demos = path.join(canon, "demos");
  let st: Stats | null = null;
  try { st = lstatSync(demos); } catch { /* no demos folder: the series are in the chosen folder */ }
  if (st?.isSymbolicLink()) throw new Error(`${demos} is a link to another folder. Choose the folder it points to instead.`);
  return { canon, series: st?.isDirectory() ? demos : canon };
}

/** Whether p, resolved, lies inside the chosen folder. */
function under(lib: Library, p: string): boolean {
  try {
    const q = realpathSync.native(p);
    return q !== lib.canon && within(q, lib.canon);
  } catch {
    return false;
  }
}

/** A version folder's COMPLETE list: file name to bytes, the extractor's record of every table it wrote. */
function completeList(text: string): Record<string, number> {
  const sizes = JSON.parse(text) as Record<string, number>;
  const bad = Object.keys(sizes).find((t) => !TABLE.test(t));
  if (bad !== undefined) throw new Error(`COMPLETE lists "${bad}", which is not a table file name`);
  return sizes;
}

type Answer = { file?: ProEntry; skipped?: string; incomplete?: boolean };

/**
 * Each map folder's last answer, by the file that completes it (a version's COMPLETE, or a flat folder's
 * match.parquet) and that file's size and time. A version folder never changes once COMPLETE is written
 * (SCHEMA-v1.md), so the dev server checks each table of a map once, not at every rescan: Node's
 * directory entries carry no sizes, and a stat per table of 1,084 maps takes seconds here.
 */
const answers = new Map<string, Answer>();

/**
 * One map folder: listed when every table its version's COMPLETE names is there, not a link, not empty
 * and at its listed size (a flat folder: match.parquet there and no table empty); else why not, or
 * nothing when it holds no map. A folder or file that is a link is left out.
 */
function mapAnswer(dir: string, rel: string): Answer {
  try {
    const names = new Map(readdirSync(dir, { withFileTypes: true }).map((d) => [d.name, d]));
    if (names.has("RETIRED")) return { skipped: "retired" };
    if (names.has("CURRENT")) {
      const v = readFileSync(path.join(dir, "CURRENT"), "utf-8").trim();
      if (!VERSION_DIR.test(v)) return { skipped: `CURRENT names "${v}", which is not a version folder` };
      const vdir = names.get(v);
      if (!vdir) return { skipped: `${v}: no such version folder`, incomplete: true };
      if (vdir.isSymbolicLink() || !vdir.isDirectory()) return { skipped: `${v}: a link, left out` };
      const done = path.join(dir, v, "COMPLETE");
      let st: Stats;
      try { st = lstatSync(done); } catch { return { skipped: `${v}: no COMPLETE file yet`, incomplete: true }; }
      if (!st.isFile()) return { skipped: `${v}: COMPLETE is a link, left out` };
      const key = `${done}|${st.size}|${st.mtimeMs}`;
      const known = answers.get(key);
      if (known) return known;
      let answer: Answer = { file: { file: `${rel}/${v}`, size: st.size, mtime: Math.round(st.mtimeMs) } };
      try {
        for (const [t, bytes] of Object.entries(completeList(readFileSync(done, "utf-8")))) {
          let ts: Stats | null = null;
          try { ts = lstatSync(path.join(dir, v, t)); } catch { /* missing */ }
          const why = !ts ? `${t} is missing` : !ts.isFile() ? `${t} is a link, left out` : ts.size === 0 || bytes === 0 ? `${t} is empty`
            : ts.size !== bytes ? `${t} is ${ts.size} bytes, not the ${bytes} COMPLETE lists` : null;
          if (why) { answer = { skipped: `${v}: ${why}`, incomplete: true }; break; }
        }
      } catch (e) {
        answer = { skipped: `${v}: ${(e as Error).message}`, incomplete: true };
      }
      answers.set(key, answer);
      return answer;
    }
    const first = names.get("match.parquet");
    if (!first) return {};
    if (first.isSymbolicLink()) return { skipped: "match.parquet is a link, left out" };
    for (const d of names.values()) {
      if (TABLE.test(d.name) && d.isFile() && statSync(path.join(dir, d.name)).size === 0) return { skipped: `${d.name} is empty`, incomplete: true };
    }
    const st = statSync(path.join(dir, "match.parquet"));
    return { file: { file: rel, size: st.size, mtime: Math.round(st.mtimeMs) } };
  } catch (e) {
    return { skipped: (e as Error).message };
  }
}

/** Every whole map of the library; a folder that cannot be listed is reported in `error`. */
export function listPro(folder: string, app: string | null = appDir()): ProListing {
  const out: ProListing = { folder, library: null, files: [], skipped: [], incomplete: 0, error: null };
  let lib: Library, series: Dirent[];
  try {
    lib = openLibrary(folder, app);
    out.library = lib.canon;
    series = readdirSync(lib.series, { withFileTypes: true });
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
  for (const s of series) {
    if (!isName(s.name) || !(s.isDirectory() || s.isSymbolicLink())) continue;
    if (s.isSymbolicLink()) { out.skipped.push({ file: `pro/${s.name}`, why: "a link, left out" }); continue; }
    let maps: Dirent[];
    try { maps = readdirSync(path.join(lib.series, s.name), { withFileTypes: true }); } catch { continue; }
    for (const m of maps) {
      if (!isName(m.name) || !(m.isDirectory() || m.isSymbolicLink())) continue;
      const rel = `pro/${s.name}/${m.name}`;
      const a = m.isSymbolicLink() ? { skipped: "a link, left out" } : mapAnswer(path.join(lib.series, s.name, m.name), rel);
      if (a.file) out.files.push(a.file);
      else if (a.skipped) {
        out.skipped.push({ file: rel, why: a.skipped });
        if ("incomplete" in a && a.incomplete) out.incomplete++;
      }
    }
  }
  out.files.sort((a, b) => b.file.localeCompare(a.file));
  return out;
}

/**
 * One read under the library: rel is the listed file without "pro/", "<series>/<map>[/<version>]" (the
 * map's table file names, as JSON), or that with "/<table>.parquet" (one of the map's tables, at its
 * COMPLETE size for a version folder), resolved inside the chosen folder.
 */
export function readPro(folder: string, rel: string, app: string | null = appDir()): Buffer {
  const parts = rel.split("/");
  const bad = () => new ProPathError(`${rel}: not a pro library path (<series>/<map>[/<version folder>][/<table>.parquet])`);
  if (parts.length < 2 || parts.length > 4 || !isName(parts[0]) || !isName(parts[1])) throw bad();
  const rest = parts.slice(2);
  const version = rest[0] && VERSION_DIR.test(rest[0]) ? rest[0] : null;
  const table = rest[version ? 1 : 0] ?? null;
  if (rest.length > (version ? 2 : 1) || (table !== null && !TABLE.test(table))) throw bad();
  const lib = openLibrary(folder, app);
  const map = path.join(lib.series, parts[0], parts[1]);
  const dir = version ? path.join(map, version) : map;
  let sizes: Record<string, number> | null = null;
  if (version) {
    const complete = path.join(dir, "COMPLETE");
    if (!under(lib, complete)) throw new Error(`${rel}: this version is gone; rescan`);
    sizes = completeList(readFileSync(complete, "utf-8"));
  } else if (!under(lib, path.join(map, "match.parquet"))) {
    throw new Error(`${rel}: no map here; rescan`);
  }
  if (table === null) {
    const names = sizes ? Object.keys(sizes) : readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && TABLE.test(d.name)).map((d) => d.name);
    return Buffer.from(JSON.stringify(names.sort()));
  }
  if (sizes && !(table in sizes)) throw new Error(`${rel}: not one of this map's tables`);
  if (!under(lib, path.join(dir, table))) throw new ProPathError(`${rel}: not one of this map's tables`);
  const bytes = readFileSync(path.join(dir, table));
  if (sizes && bytes.length !== sizes[table]) throw new Error(`${rel}: ${bytes.length} bytes, not the ${sizes[table]} COMPLETE lists; rescan`);
  return bytes;
}
