// The extractor's output layout (SCHEMA-v1.md "Finding a map's tables"): a map's live tables are in the
// version folder its CURRENT file names, once that folder's COMPLETE file vouches for every table, or in
// the map folder itself for output written before versioned folders.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { loadMapTables, mapTablesDir } from "../../tools/node-read";

const root = mkdtempSync(path.join(tmpdir(), "cs2-maps-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const map = (name: string, files: Record<string, string>) => {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name, f)), { recursive: true });
    writeFileSync(path.join(root, name, f), body);
  }
  return path.join(root, name);
};
const V1 = "v-1.6.0-0a1b2c3d", V2 = "v-1.6.0-99aa00ff";

it("reads the complete version CURRENT names, falls back to the flat folder, and skips what is not complete", () => {
  // fails if a stale or half-written version is read, a retired map is read, or a bad pointer passes silently
  const ok = map("versioned", { CURRENT: `${V2}\n`, [`${V1}/match.parquet`]: "old", [`${V2}/match.parquet`]: "new", [`${V2}/COMPLETE`]: JSON.stringify({ "match.parquet": 3 }) });
  expect(mapTablesDir(ok)).toEqual({ dir: path.join(ok, V2), manifest: { "match.parquet": 3 } });
  const flat = map("flat", { "match.parquet": "" });
  expect(mapTablesDir(flat)).toEqual({ dir: flat });
  expect(mapTablesDir(map("empty", { "notes.txt": "" }))).toBeNull();
  expect(mapTablesDir(map("no-complete", { CURRENT: V1, [`${V1}/match.parquet`]: "x" }))).toHaveProperty("skipped");
  expect(mapTablesDir(map("short", { CURRENT: V1, [`${V1}/match.parquet`]: "x", [`${V1}/COMPLETE`]: JSON.stringify({ "match.parquet": 9 }) }))).toHaveProperty("skipped");
  expect(mapTablesDir(map("retired", { RETIRED: "", CURRENT: V2, [`${V2}/match.parquet`]: "new", [`${V2}/COMPLETE`]: JSON.stringify({ "match.parquet": 3 }) }))).toHaveProperty("skipped");
  expect(() => mapTablesDir(map("bad", { CURRENT: "../elsewhere" }))).toThrow(/not a version folder/);
});

it("discards a read of a version whose files change after it was resolved", async () => {
  // fails if a table rewritten between resolving CURRENT and reading it is parsed as the version's
  const dir = map("rewritten", { "match.parquet": "x" });
  await expect(loadMapTables({ dir, manifest: { "match.parquet": 9 } })).rejects.toThrow(/changed while it was read/);
});
