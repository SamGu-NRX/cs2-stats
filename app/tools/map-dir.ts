// Where one extracted map's tables are on disk (SCHEMA-v1.md "Finding a map's tables"). Node only, and
// free of the parquet reader, so the dev server can resolve map folders without loading the engine.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * One map folder resolved: its tables folder (with the COMPLETE manifest, file name to bytes, for a
 * version folder), or why it has no complete map now.
 */
export type MapTables = { dir: string; manifest?: Record<string, number> } | { skipped: string };

export const VERSION_DIR = /^v-[0-9A-Za-z.+_]+-[0-9a-f]{8}$/;

/**
 * Where one map's tables are, by SCHEMA-v1.md "Finding a map's tables": a RETIRED map is skipped; a
 * CURRENT pointer names a version folder (refused unless the name has the version-folder form), which
 * counts only once its COMPLETE file lists every table at its size on disk; otherwise the flat folder
 * written before versioned output (match.parquet, or meta.parquet before schema v1). Null when the
 * folder holds no map at all.
 */
export function mapTablesDir(mapDir: string): MapTables | null {
  // RETIRED's first line says why: "replaced" (a successor exists) or "stale: <reason>"
  const retired = path.join(mapDir, "RETIRED");
  if (existsSync(retired)) return { skipped: `retired (${readFileSync(retired, "utf-8").split("\n")[0].trim() || "no reason given"})` };
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
    return { dir, manifest: sizes };
  }
  return existsSync(path.join(mapDir, "match.parquet")) || existsSync(path.join(mapDir, "meta.parquet")) ? { dir: mapDir } : null;
}
