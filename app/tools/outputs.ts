// Every file the app's tools write goes through writeOutput, which decides from one rule where it may
// land. Private outputs (anything built from the HLTV pack, and anything that names or identifies a
// pro) stay outside the repository entirely, so no flag, path spelling or default can commit them. A
// public output may land in the repository only at the one path it declares (`inRepo`): the shipped
// pool app/public/baselines.json, or a generated source file such as src/stats/recoil.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isInside, realPathOf } from "./paths";

/** The repository root, two levels above app/tools. */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
/** The shipped pool's place in a repository. */
export const shippedPool = (repo = REPO_ROOT) => path.join(repo, "app", "public", "baselines.json");

export interface OutputKind {
  /** true for anything built from the HLTV pack or holding pro names: it must not land in the repository */
  private: boolean;
  /** what the file is, for the error */
  what: string;
  /** for a public output, the one repository path it may take; without it, it must land outside */
  inRepo?: string;
}

const same = (a: string, b: string) => {
  const [x, y] = [realPathOf(a), realPathOf(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * Throws when `file` may not hold this kind of output, compared on real paths (tools/paths.ts): a
 * private output anywhere in the repository, or a public one in the repository anywhere but its
 * declared `inRepo` path.
 */
export function checkOutput(file: string, kind: OutputKind, repo = REPO_ROOT): void {
  if (!isInside(file, repo)) return;
  if (kind.private) throw new Error(`refusing to write ${kind.what} to ${file}: it is private and must stay outside the repository (${repo})`);
  if (!kind.inRepo || !same(file, kind.inRepo)) {
    throw new Error(`refusing to write ${kind.what} to ${file}: ${kind.inRepo ? `its only place in the repository is ${kind.inRepo}` : "it has no place in the repository"}`);
  }
}

/** The private marker, the same as extractor/repo_guard.py's; scripts/check-public-tree fails a tree holding it. */
export const PRIVATE_KEY = "_private";
export const PRIVATE_VALUE = "do not commit";

/**
 * A private output's text with the marker: a JSON object gets PRIVATE_KEY set to PRIVATE_VALUE as its first
 * key, keeping the indentation and final newline it had; a file named *.private.* carries the marker in
 * its name. Anything else is refused, so no private output goes out unmarked.
 */
export function marked(file: string, data: string): string {
  if (/\.private\./.test(path.basename(file))) return data;
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${file}: a private output must be a JSON object or be named *.private.*, to carry the private marker`);
  const indent = /^\{\s*\n(\s+)"/.exec(data)?.[1].length ?? 0;
  return JSON.stringify({ [PRIVATE_KEY]: PRIVATE_VALUE, ...(obj as object) }, null, indent || undefined) + (data.endsWith("\n") ? "\n" : "");
}

/** Checks where `file` may go, then writes it, making its folder; a private output gets the marker. */
export function writeOutput(file: string, data: string, kind: OutputKind, repo = REPO_ROOT): void {
  checkOutput(file, kind, repo);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, kind.private ? marked(file, data) : data);
}
