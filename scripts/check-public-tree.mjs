#!/usr/bin/env node
// The backstop behind tools/outputs.ts and extractor/repo_guard.py: fails when the tracked tree holds
// something that must not be published, whichever tool or hand put it there. It reads every tracked
// file (gzip files decoded) and reports:
// - a SteamID64 (7656119 and ten digits) not in scripts/steamid-allowlist.txt;
// - an absolute developer path, C:\Users\<name>\ or /Users/<name>/, in either slash style;
// - "hltv" anywhere under app/public/;
// - the private marker: a file named *.private.*, a JSON file whose top-level object has "_private",
//   or a parquet file (extracted tables hold SteamIDs and names and cannot carry a key).
//   node scripts/check-public-tree.mjs [--root <git work tree>]
// Exit 0 when clean, 1 with one line per finding.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const at = process.argv.indexOf("--root");
const root = path.resolve(at > 0 ? process.argv[at + 1] : path.join(import.meta.dirname, ".."));
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);

/** The allowlisted SteamID64s: one per line, the id then its reason; # starts a comment. */
const allowed = new Map();
const listFile = path.join(root, "scripts", "steamid-allowlist.txt");
for (const line of readFileSync(listFile, "utf8").split(/\r?\n/)) {
  const t = line.replace(/#.*/, "").trim();
  if (!t) continue;
  const m = /^(7656119\d{10})\s+(\S.*)$/.exec(t);
  if (!m) throw new Error(`${listFile}: "${line}" is not "<SteamID64> <reason>"`);
  allowed.set(m[1], m[2]);
}

const STEAMID = /7656119\d{10}/g;
// a drive letter or a leading slash, then Users, then a name that is not a placeholder (<name>, %VAR%, ${x}, *)
const DEV_PATH = /(?:\b[A-Za-z]:(?:\\\\|\\|\/)|(?<![\w.])\/)Users(?:\\\\|\\|\/)(?![<%$*{])([^\\/\s"'`<>|:*?]+)(?:\\\\|\\|\/)/gi;
const findings = [];
const report = (file, what) => findings.push(`${file}: ${what}`);

for (const file of files) {
  let bytes;
  try {
    bytes = readFileSync(path.join(root, file));
  } catch {
    continue; // deleted in the work tree but still in the index
  }
  if (/\.private\./i.test(path.basename(file))) report(file, "named *.private.*: a private output");
  if (/\.parquet$/i.test(file)) report(file, "a parquet table: extracted tables are private");
  if (file.endsWith(".gz")) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      report(file, "a .gz file that does not decompress, so it cannot be checked");
      continue;
    }
  }
  const text = bytes.toString("latin1");
  for (const id of new Set(text.match(STEAMID) ?? [])) if (!allowed.has(id)) report(file, `SteamID64 ${id} is not in scripts/steamid-allowlist.txt`);
  for (const m of text.matchAll(DEV_PATH)) report(file, `absolute developer path ${JSON.stringify(m[0])}`);
  if (file.startsWith("app/public/") && /hltv/i.test(text)) report(file, `"hltv" under app/public/`);
  if (/\.json(\.gz)?$/i.test(file)) {
    let obj = null;
    try {
      obj = JSON.parse(bytes.toString("utf8"));
    } catch {
      // not JSON after all (a JSON-lines or template file): the marker check needs an object
    }
    if (obj && typeof obj === "object" && !Array.isArray(obj) && Object.hasOwn(obj, "_private")) report(file, 'carries the private marker ("_private")');
  }
}

if (findings.length) {
  console.error(`check-public-tree: ${findings.length} finding(s) in ${files.length} tracked files`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-public-tree: ${files.length} tracked files, nothing private`);
