// Where the pro-data tools may write (tools/outputs.ts): private outputs (pack-built pools, the named
// pro pack) never inside the repository, and nothing in the repository but the shipped pool.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkOutput, marked, PRIVATE_KEY, PRIVATE_VALUE, REPO_ROOT, shippedPool, writeOutput } from "../../tools/outputs";

const base = mkdtempSync(path.join(tmpdir(), "cs2-outputs-"));
const repo = path.join(base, "repo");
mkdirSync(path.join(repo, "app", "public"), { recursive: true });
const outside = path.join(base, "data", "derived");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const NAMED = { private: true, what: "the named pro pack" };
const PACK_POOL = { private: true, what: "the pro pool built on the HLTV win-probability lookup" };
const PUBLIC_POOL = { private: false, what: "the pro pool built on the CS2RB round model", inRepo: shippedPool(repo) };

describe("writeOutput", () => {
  it("keeps private outputs out of the whole repository, public/ and elsewhere", () => {
    // fails if --named (or a pack-built pool) can land anywhere in the repository, as --named under public/ did
    for (const file of [
      path.join(repo, "app", "public", "baselines-named.json"),
      path.join(repo, "app", "tools", "named.json"),
      path.join(repo, "named.json"),
      path.join(repo, "app", "..", "model", "named.json"),
      path.join(outside, "..", "..", "repo", "app", "public", "x.json"),
    ]) {
      expect(() => writeOutput(file, "{}", NAMED, repo), file).toThrow(/is private and must stay outside the repository/);
      expect(() => writeOutput(file, "{}", PACK_POOL, repo), file).toThrow(/is private/);
      expect(existsSync(file), file).toBe(false);
    }
    if (process.platform === "win32") expect(() => checkOutput(path.join(base, "REPO", "APP", "PUBLIC", "x.json"), NAMED, repo)).toThrow(/is private/);
  });

  it("writes private outputs outside the repository, each carrying the private marker", () => {
    // fails if a private output can go out unmarked, which scripts/check-public-tree could not find
    const file = path.join(outside, "baselines-named.json");
    writeOutput(file, '{"players":[]}', NAMED, repo);
    expect(readFileSync(file, "utf8")).toBe(`{"${PRIVATE_KEY}":"${PRIVATE_VALUE}","players":[]}`);
    // indentation and the final newline are kept
    writeOutput(file, '{\n  "a": 1\n}\n', NAMED, repo);
    expect(readFileSync(file, "utf8")).toBe(`{\n  "${PRIVATE_KEY}": "${PRIVATE_VALUE}",\n  "a": 1\n}\n`);
    // a file named *.private.* carries the marker in its name, so its text is left alone
    writeOutput(path.join(outside, "cache.private.bin"), "raw", NAMED, repo);
    expect(readFileSync(path.join(outside, "cache.private.bin"), "utf8")).toBe("raw");
    expect(() => writeOutput(path.join(outside, "cache.bin"), "raw", NAMED, repo)).toThrow(/must be a JSON object or be named \*\.private\.\*/);
    expect(() => marked("x.json", "[1, 2]")).toThrow(/must be a JSON object/);
  });

  it("lets the public pool into the repository at the shipped path only", () => {
    // fails if the shipped CS2RB pool can no longer be built, or another file lands in public/
    writeOutput(shippedPool(repo), "{}", PUBLIC_POOL, repo);
    expect(readFileSync(shippedPool(repo), "utf8")).toBe("{}");
    expect(() => writeOutput(path.join(repo, "app", "public", "other.json"), "{}", PUBLIC_POOL, repo)).toThrow(/its only place in the repository is/);
    // a public output with no declared place (the metric evidence report) is refused in the repository
    expect(() => checkOutput(path.join(repo, "app", "public", "evidence.json"), { private: false, what: "the report" }, repo)).toThrow(/it has no place in the repository/);
    expect(() => checkOutput(path.join(outside, "pool.json"), PUBLIC_POOL, repo)).not.toThrow();
  });
});

describe("pnpm metric-evidence", () => {
  it("refuses a report inside the repository before reading any map", () => {
    // fails if --out skips writeOutput again: the report holds swing and rating overlaps, pack-derived with the pack loaded
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "app", "node_modules", "vite-node", "vite-node.mjs"), "tools/metric-evidence.ts", "--out", "public/metric-evidence.json"], {
      cwd: path.join(REPO_ROOT, "app"), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, CS2_WINPROB_PACK: "none", CS2_STATS_DATA: path.join(base, "no-data") },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing to write the metric evidence report");
    expect(existsSync(path.join(REPO_ROOT, "app", "public", "metric-evidence.json"))).toBe(false);
  }, 60_000);
});

describe("pnpm baselines", () => {
  // the tool itself: it checks both destinations before it reads any map, so these need no pro data
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO_ROOT, "app", "node_modules", "vite-node", "vite-node.mjs"), "tools/baselines.ts", ...args], {
    cwd: path.join(REPO_ROOT, "app"), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CS2_WINPROB_PACK: "none", CS2_STATS_DATA: path.join(base, "no-data") },
  });

  it("refuses --named under public/ and anywhere else in the repository", () => {
    for (const named of ["public/baselines-named.json", "../model/baselines-named.json", "PUBLIC/named.json"]) {
      const r = run("--named", named);
      expect(r.status, named).not.toBe(0);
      expect(r.stderr, named).toContain("refusing to write the named pro pack");
      expect(existsSync(path.join(REPO_ROOT, "app", named)), named).toBe(false);
    }
  }, 120_000);

  it("gets past the guard with the shipped pool and a named pack outside the repository", () => {
    // with no pro data here it stops at the next check, which shows the guard let both paths through
    const r = run("--named", path.join(base, "named.json"));
    expect(r.stderr).toContain("no pro tables under");
    expect(r.stderr).not.toContain("refusing to write");
  }, 60_000);
});
