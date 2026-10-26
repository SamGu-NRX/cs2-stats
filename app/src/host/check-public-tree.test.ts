// scripts/check-public-tree.mjs, the CI backstop: a clean tree passes, and each kind of finding planted
// into a scratch git tree fails it.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "check-public-tree.mjs");
const base = mkdtempSync(path.join(tmpdir(), "cs2-tree-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

// The planted findings are built at run time, so this file itself holds none of them.
const ID = (tail: string) => `7656119${tail}`;
const USERS = ["Us", "ers"].join("");
const BS = "\\";
const MARK = ["_pri", "vate"].join("");

let n = 0;
/** A scratch git tree with the real allowlist and these files tracked; the checker's exit and output. */
function check(files: Record<string, string | Buffer>) {
  const root = path.join(base, `t${n++}`);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(path.join(REPO, "scripts", "steamid-allowlist.txt"), path.join(root, "scripts", "steamid-allowlist.txt"));
  for (const [f, data] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), data);
  }
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("check-public-tree", () => {
  it("passes this repository's tree", () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect([r.status, r.stdout]).toEqual([0, expect.stringMatching(/nothing private/)]);
  });

  it("passes allowlisted ids, placeholders, URLs and the marker named in code", () => {
    const r = check({
      "fixtures/a.json": `{"SteamID": ${ID("7961265729")}, "bot": ${ID("8024248129")}}`,
      "docs/x.md": `Paths like C:${BS}${USERS}${BS}<name>${BS} or /${USERS}/<name>/ are placeholders, and https://example.com/${USERS}/x/ is a URL.`,
      "app/tools/outputs.ts": `export const PRIVATE_KEY = "${MARK}";`,
      "app/public/baselines.json": '{"source": "CS2RB"}',
    });
    expect(r).toEqual({ code: 0, out: expect.stringMatching(/nothing private/) });
  });

  it("fails on each kind of finding, gzip files decoded", () => {
    // fails if any of the four rules stops catching what it names
    const cases: [Record<string, string | Buffer>, string][] = [
      [{ "fixtures/x.json": `{"id": ${ID("8000000042")}}` }, `SteamID64 ${ID("8000000042")} is not in scripts/steamid-allowlist.txt`],
      [{ "app/public/samples/s.json.gz": gzipSync(`{"key": ["${ID("8000000043")}"]}`) }, `s.json.gz: SteamID64 ${ID("8000000043")}`],
      [{ "model/README.md": `run C:${BS}${USERS}${BS}someone${BS}proj${BS}x.py` }, "absolute developer path"],
      [{ "model/README.md": `cd "C:/${USERS}/someone/proj"` }, "absolute developer path"],
      [{ "a.json": `{"p": "C:${BS}${BS}${USERS}${BS}${BS}someone${BS}${BS}x"}` }, "absolute developer path"],
      [{ "docs/mac.md": `see /${USERS}/someone/Programming/x` }, "absolute developer path"],
      [{ "app/public/baselines.json": '{"source": "swing from the HLTV win-probability lookup"}' }, '"hltv" under app/public/'],
      [{ "app/public/samples/x.json.gz": gzipSync('{"model": "hltv-530cdd3e"}') }, '"hltv" under app/public/'],
      [{ "data/baselines.local.json": `{"${MARK}": "do not commit", "pools": {}}` }, "carries the private marker"],
      [{ "data/report.private.txt": "anything" }, "named *.private.*"],
      [{ "data/players.parquet": Buffer.from("PAR1") }, "a parquet table"],
    ];
    for (const [files, why] of cases) {
      const r = check(files);
      expect(r.code, Object.keys(files)[0]).toBe(1);
      expect(r.out, Object.keys(files)[0]).toContain(why);
    }
  }, 60_000);
});
