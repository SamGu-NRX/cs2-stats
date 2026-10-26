// Every file a tool writes from the pro data goes through writeOutput, which decides from one rule
// where it may land. Private outputs (anything built from the HLTV pack, and anything that names a
// pro) stay outside the repository entirely, so no flag, path spelling or default can commit them.
// The one output allowed inside the repository is the shipped pool, app/public/baselines.json, built
// anonymously on the public CS2RB model.
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
}

const same = (a: string, b: string) => {
  const [x, y] = [realPathOf(a), realPathOf(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * Throws when `file` may not hold this kind of output, compared on real paths (tools/paths.ts): a
 * private output anywhere in the repository, or an anonymous one in the repository anywhere but the
 * shipped pool's path.
 */
export function checkOutput(file: string, kind: OutputKind, repo = REPO_ROOT): void {
  if (!isInside(file, repo)) return;
  if (kind.private) throw new Error(`refusing to write ${kind.what} to ${file}: it is private and must stay outside the repository (${repo})`);
  if (!same(file, shippedPool(repo))) throw new Error(`refusing to write ${kind.what} to ${file}: the only output allowed in the repository is ${shippedPool(repo)}`);
}

/** Checks where `file` may go, then writes it, making its folder. */
export function writeOutput(file: string, data: string, kind: OutputKind, repo = REPO_ROOT): void {
  checkOutput(file, kind, repo);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}
