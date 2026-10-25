// The user's imported Valve matchmaking matches (extractor/valve_import.py output), for the dev and
// preview servers; src-tauri/src/lib.rs implements the same rules for the desktop app.
//
// The folder holds one map folder per demo in the extractor's versioned layout, and valve-user.local.json,
// the user's SteamID64. A match is listed as "valve/<demo>/<version folder>": naming the version means
// one match's tables never mix two extractions, and a re-import lists as a new file. Reading that path
// returns its table file names; "valve/<demo>/<version folder>/<table>.parquet" returns one table, only if
// the version's COMPLETE list names it at its size on disk.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { mapTablesDir, VERSION_DIR } from "./map-dir";

export const VALVE_USER_FILE = "valve-user.local.json";
/** SteamID64 of account 0 in the public universe; every real SteamID64 is above it. */
const STEAMID64_MIN = 76561197960265728n;
const NAME = /^[A-Za-z0-9_.-]+$/;

/** A request for a path that is not a Valve match or table: the caller's mistake, not the folder's. */
export class ValvePathError extends Error {}

export interface ValveEntry { file: string; size: number; mtime: number }
export interface ValveListing {
  folder: string;
  /** the user's SteamID64 as a string, or null before the first import */
  user: string | null;
  files: ValveEntry[];
  /** map folders with no complete version now, and why */
  skipped: { file: string; why: string }[];
}

/** The folder: CS2_VALVE_MATCHES when set (the dev data), else %APPDATA%\BotMatchStats\valve. */
export function valveRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CS2_VALVE_MATCHES) return path.resolve(env.CS2_VALVE_MATCHES);
  return env.APPDATA ? path.join(env.APPDATA, "BotMatchStats", "valve") : null;
}

/**
 * The user's SteamID64 from valve-user.local.json, or null when the file is absent. It is read from the
 * text, because a SteamID64 is above 2^53 and JSON.parse would round it. A file that names no valid
 * SteamID64 throws.
 */
export function valveUser(root: string): string | null {
  const f = path.join(root, VALVE_USER_FILE);
  if (!existsSync(f)) return null;
  const m = /"steamid"\s*:\s*(\d{17,20})\s*[,}]/.exec(readFileSync(f, "utf-8"));
  if (!m || BigInt(m[1]) < STEAMID64_MIN) throw new Error(`${f} names no SteamID64 ("steamid": <integer>)`);
  return m[1];
}

/** A demo folder name; "." and ".." match NAME but would lead out of the folder. */
const isName = (s: string) => NAME.test(s) && s !== "." && s !== "..";

/** Whether p, with every junction and symbolic link resolved, lies inside root's own resolved path. */
function isInside(root: string, p: string): boolean {
  const r = realpathSync.native(root), q = realpathSync.native(p);
  return q.startsWith(r + path.sep);
}

/** Throws unless p, resolved, lies inside root: a version folder or table that is a link to elsewhere is refused. */
function contained(root: string, p: string, rel: string): void {
  if (!isInside(root, p)) throw new ValvePathError(`${rel}: resolves outside the Valve folder`);
}

export function listValve(root: string): ValveListing {
  const out: ValveListing = { folder: root, user: null, files: [], skipped: [] };
  if (!existsSync(root)) return out;
  out.user = valveUser(root);
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !isName(d.name)) continue;
    let r;
    try {
      r = mapTablesDir(path.join(root, d.name));
    } catch (e) {
      out.skipped.push({ file: `valve/${d.name}`, why: (e as Error).message });
      continue;
    }
    if (!r) continue;
    if ("skipped" in r) { out.skipped.push({ file: `valve/${d.name}`, why: r.skipped }); continue; }
    if (!r.manifest) { out.skipped.push({ file: `valve/${d.name}`, why: "not in the versioned layout the importer writes" }); continue; }
    if (!isInside(root, path.join(r.dir, "COMPLETE"))) { out.skipped.push({ file: `valve/${d.name}`, why: "its version folder resolves outside the Valve folder" }); continue; }
    out.files.push({
      file: `valve/${d.name}/${path.basename(r.dir)}`,
      size: Object.values(r.manifest).reduce((a, b) => a + b, 0),
      mtime: Math.round(statSync(path.join(r.dir, "COMPLETE")).mtimeMs),
    });
  }
  out.files.sort((a, b) => b.file.localeCompare(a.file));
  return out;
}

/**
 * How to run the importer into root: the extractor folder is CS2_EXTRACTOR_DIR, else this repository's
 * extractor/; its Python is CS2_EXTRACTOR_PYTHON, else the folder's .venv; CS2_MAPDATA, when set, is the
 * awpy-data release for mesh visibility. { missing } says what is not there.
 */
export function importerCommand(root: string, env: NodeJS.ProcessEnv = process.env, appDir = path.resolve(import.meta.dirname, "..")):
  { cmd: string; args: string[]; cwd: string } | { missing: string } {
  const dir = env.CS2_EXTRACTOR_DIR ? path.resolve(env.CS2_EXTRACTOR_DIR) : path.resolve(appDir, "..", "extractor");
  const script = path.join(dir, "valve_import.py");
  if (!existsSync(script)) return { missing: `no importer at ${script}; set CS2_EXTRACTOR_DIR to the extractor folder` };
  const py = env.CS2_EXTRACTOR_PYTHON ?? path.join(dir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(py)) return { missing: `no Python at ${py}; create the extractor's .venv (extractor/README.md) or set CS2_EXTRACTOR_PYTHON` };
  const args = ["-I", script, "--progress", "--out", root];
  if (env.CS2_MAPDATA) args.push("--mapdata", path.resolve(env.CS2_MAPDATA));
  return { cmd: py, args, cwd: dir };
}

/**
 * One read under the folder: rel is "<demo>/<version>" (the version's table file names, as JSON) or
 * "<demo>/<version>/<table>.parquet" (the table's bytes). Anything else, or a table the version's COMPLETE
 * list does not name at its size, throws.
 */
export function readValve(root: string, rel: string): Buffer {
  const parts = rel.split("/");
  const [demo, version, table] = parts;
  if (parts.length < 2 || parts.length > 3 || !isName(demo) || !VERSION_DIR.test(version) || (table !== undefined && !/^[a-z0-9_]+\.parquet$/.test(table))) {
    throw new ValvePathError(`${rel}: not a Valve match path (<demo>/<version folder>[/<table>.parquet])`);
  }
  const dir = path.join(root, demo, version);
  const complete = path.join(dir, "COMPLETE");
  if (!existsSync(complete)) throw new Error(`${rel}: this version is gone; rescan`);
  contained(root, complete, rel);
  const sizes = JSON.parse(readFileSync(complete, "utf-8")) as Record<string, number>;
  if (table === undefined) return Buffer.from(JSON.stringify(Object.keys(sizes).filter((f) => f.endsWith(".parquet"))));
  if (!(table in sizes)) throw new Error(`${rel}: not one of this version's tables`);
  contained(root, path.join(dir, table), rel);
  const bytes = readFileSync(path.join(dir, table));
  if (bytes.length !== sizes[table]) throw new Error(`${rel}: ${bytes.length} bytes, not the ${sizes[table]} COMPLETE lists; rescan`);
  return bytes;
}
