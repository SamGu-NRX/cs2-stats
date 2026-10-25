// The dev and preview servers' Valve folder (tools/valve-folder.ts): what is listed and what can be read.
// src-tauri/src/lib.rs has the same rules for the desktop app, with its own tests.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { importerCommand, listValve, readValve, VALVE_USER_FILE, ValvePathError } from "../../tools/valve-folder";

const base = mkdtempSync(path.join(tmpdir(), "cs2-valve-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = path.join(base, `r${n++}`); mkdirSync(d); return d; };
const V1 = "v-1.13.0-0a1b2c3d";

/** A map folder whose CURRENT names V1; `listed` overrides the sizes COMPLETE gives. */
function map(root: string, demo: string, tables: Record<string, string>, listed?: number) {
  const dir = path.join(root, demo, V1);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, demo, "CURRENT"), `${V1}\n`);
  for (const [f, body] of Object.entries(tables)) writeFileSync(path.join(dir, f), body);
  writeFileSync(path.join(dir, "COMPLETE"), JSON.stringify(Object.fromEntries(Object.entries(tables).map(([f, b]) => [f, listed ?? b.length]))));
}

it("lists complete Valve matches by their version folder, with the user's exact SteamID64", () => {
  // fails if a half-written or retired version is listed, a listed path loses its version, or the id is rounded
  const root = fresh();
  map(root, "match730_a", { "match.parquet": "abc" });
  map(root, "match730_b", { "match.parquet": "abc" }, 9);
  map(root, "match730_c", { "match.parquet": "abc" });
  writeFileSync(path.join(root, "match730_c", "RETIRED"), "replaced\n");
  writeFileSync(path.join(root, VALVE_USER_FILE), '{\n "steamid": 76561197960265729,\n "source": "--user"\n}\n');
  const l = listValve(root);
  expect(l.files.map((f) => [f.file, f.size])).toEqual([[`valve/match730_a/${V1}`, 3]]);
  expect(l.skipped.map((s) => s.file).sort()).toEqual(["valve/match730_b", "valve/match730_c"]);
  expect(l.user).toBe("76561197960265729");
  expect(listValve(path.join(root, "absent"))).toMatchObject({ files: [], user: null });
});

it("still lists the matches when the user file is unreadable, and says why", () => {
  // fails if a half-written or broken user file hides every match (review of #29)
  const root = fresh();
  map(root, "match730_a", { "match.parquet": "abc" });
  for (const body of ['{"steamid": 12345}', '{"steam']) {
    writeFileSync(path.join(root, VALVE_USER_FILE), body);
    expect(listValve(root)).toMatchObject({ user: null, userError: expect.stringMatching(/names no SteamID64/), files: [{ file: `valve/match730_a/${V1}` }] });
  }
});

it("reads only the tables a version's COMPLETE list names, at their size", () => {
  // fails if a path escapes the folder, or a table rewritten after COMPLETE was written is returned
  const root = fresh();
  map(root, "match730_a", { "match.parquet": "abc", "kills.parquet": "k" });
  expect(JSON.parse(readValve(root, `match730_a/${V1}`).toString())).toEqual(["match.parquet", "kills.parquet"]);
  expect(readValve(root, `match730_a/${V1}/match.parquet`).toString()).toBe("abc");
  for (const bad of [`../x/${V1}`, `match730_a/${V1}/../../x.parquet`, "match730_a/CURRENT", `match730_a/${V1}/COMPLETE`, `match730_a/${V1}/rounds.parquet`]) {
    expect(() => readValve(root, bad), bad).toThrow();
  }
  writeFileSync(path.join(root, "match730_a", V1, "match.parquet"), "abcd");
  expect(() => readValve(root, `match730_a/${V1}/match.parquet`)).toThrow(/rescan/);
});

it("never lists or reads a version that resolves outside the folder", () => {
  // fails if "../v-…/match.parquet" or a version folder that is a junction reads files beside the folder
  // (review of #29: both read outside it)
  const root = fresh();
  const outside = path.join(path.dirname(root), V1);
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "match.parquet"), "secret");
  writeFileSync(path.join(outside, "COMPLETE"), JSON.stringify({ "match.parquet": 6 }));
  expect(() => readValve(root, `../${V1}/match.parquet`)).toThrow(ValvePathError);
  mkdirSync(path.join(root, "match730_j"));
  writeFileSync(path.join(root, "match730_j", "CURRENT"), `${V1}\n`);
  symlinkSync(outside, path.join(root, "match730_j", V1), "junction");
  expect(listValve(root)).toMatchObject({ files: [], skipped: [{ file: "valve/match730_j" }] });
  expect(() => readValve(root, `match730_j/${V1}`)).toThrow(/outside the Valve folder/);
  expect(() => readValve(root, `match730_j/${V1}/match.parquet`)).toThrow(/outside the Valve folder/);
});

it("runs the importer with progress into the Valve folder, and says what is missing when it cannot", () => {
  // fails if the importer runs without --progress (the app shows nothing), writes elsewhere, or fails silently
  const dir = fresh();
  expect(importerCommand("out", { CS2_EXTRACTOR_DIR: dir })).toMatchObject({ missing: expect.stringMatching(/no importer/) });
  writeFileSync(path.join(dir, "valve_import.py"), "");
  expect(importerCommand("out", { CS2_EXTRACTOR_DIR: dir })).toMatchObject({ missing: expect.stringMatching(/no Python/) });
  const py = path.join(dir, "python.exe");
  writeFileSync(py, "");
  const run = importerCommand("out", { CS2_EXTRACTOR_DIR: dir, CS2_EXTRACTOR_PYTHON: py, CS2_MAPDATA: dir });
  expect(run).toEqual({ cmd: py, cwd: dir, args: ["-I", path.join(dir, "valve_import.py"), "--progress", "--out", "out", "--mapdata", dir] });
});
