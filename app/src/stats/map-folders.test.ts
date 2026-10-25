// The extractor's output layout: a map's live tables are in the versioned folder its CURRENT file names,
// or in the map folder itself for output written before versioned folders.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { mapTablesDir } from "../../tools/node-read";

const root = mkdtempSync(path.join(tmpdir(), "cs2-maps-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const map = (name: string, files: Record<string, string>) => {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name, f)), { recursive: true });
    writeFileSync(path.join(root, name, f), body);
  }
  return path.join(root, name);
};

it("reads the folder CURRENT names, falls back to the flat folder, and refuses a pointer to nothing", () => {
  // fails if a versioned map is skipped or read from a stale version, or a dangling pointer passes silently
  const versioned = map("versioned", { "CURRENT": "v-1-bbb\n", "v-1-aaa/match.parquet": "", "v-1-bbb/match.parquet": "" });
  expect(mapTablesDir(versioned)).toBe(path.join(versioned, "v-1-bbb"));
  const flat = map("flat", { "match.parquet": "" });
  expect(mapTablesDir(flat)).toBe(flat);
  expect(mapTablesDir(map("empty", { "notes.txt": "" }))).toBeNull();
  expect(() => mapTablesDir(map("dangling", { "CURRENT": "v-2-ccc" }))).toThrow(/v-2-ccc/);
});
