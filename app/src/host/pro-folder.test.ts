// The dev and preview servers' pro match library (tools/pro-folder.ts): what is listed and what can be
// read. src-tauri/src/pro.rs has the same rules for the desktop app, with its own tests.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { listPro, readPro } from "../../tools/pro-folder";

const base = mkdtempSync(path.join(tmpdir(), "cs2-pro-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = path.join(base, `r${n++}`); mkdirSync(d); return d; };
const V = "v-1.16.0-0a1b2c3d";
const write = (f: string, body: string) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, body); };

/** A versioned map: `files` written into the version folder, `listed` written into its COMPLETE. */
function map(dir: string, files: Record<string, string>, listed: Record<string, number>) {
  write(path.join(dir, "CURRENT"), V);
  for (const [f, body] of Object.entries(files)) write(path.join(dir, V, f), body);
  write(path.join(dir, V, "COMPLETE"), JSON.stringify(listed));
}

it("lists a map only when every table its COMPLETE names is there, not empty, at its size", () => {
  // fails if a version is listed while a table its marker names is missing, empty or short
  const lib = fresh();
  map(path.join(lib, "demos/s-1/whole"), { "match.parquet": "mm", "kills.parquet": "kkk" }, { "match.parquet": 2, "kills.parquet": 3 });
  map(path.join(lib, "demos/s-1/missing"), { "match.parquet": "mm" }, { "match.parquet": 2, "kills.parquet": 3 });
  map(path.join(lib, "demos/s-1/empty"), { "match.parquet": "mm", "kills.parquet": "" }, { "match.parquet": 2, "kills.parquet": 0 });
  const l = listPro(lib, null);
  expect(l.files.map((f) => f.file)).toEqual([`pro/s-1/whole/${V}`]);
  expect(l.incomplete).toBe(2);
  // the library's resolved path, which keys its maps' caches apart from another library's
  expect(l.library).toBe(realpathSync.native(lib));
});

it("refuses junctions that lead out of the library, and the app's own data folder", () => {
  // fails if a demos or map folder that is a junction to a folder outside is listed or read, or if the
  // library may be the folder the desktop app writes its setting to, or hold it
  const outside = fresh();
  map(path.join(outside, "s-1/m1"), { "match.parquet": "mm" }, { "match.parquet": 2 });
  const linked = fresh();
  symlinkSync(outside, path.join(linked, "demos"), "junction");
  expect(listPro(linked, null)).toMatchObject({ files: [], error: expect.stringContaining("is a link") });
  expect(() => readPro(linked, `s-1/m1/${V}/match.parquet`, null)).toThrow();

  const lib = fresh();
  map(path.join(lib, "demos/s-1/own"), { "match.parquet": "mm" }, { "match.parquet": 2 });
  symlinkSync(path.join(outside, "s-1/m1"), path.join(lib, "demos/s-1/m1"), "junction");
  expect(listPro(lib, null).files.map((f) => f.file)).toEqual([`pro/s-1/own/${V}`]);
  expect(() => readPro(lib, `s-1/m1/${V}/match.parquet`, null)).toThrow();

  const app = path.join(lib, "BotMatchStats");
  mkdirSync(app);
  for (const folder of [lib, app]) expect(listPro(folder, app).error).toMatch(/the app writes its settings there/);
});
