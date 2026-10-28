import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finishPartials } from "./partial-files";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dump = (rows: string) => {
  dir = mkdtempSync(path.join(tmpdir(), "partials-"));
  const file = path.join(dir, "rating-rounds.private.jsonl");
  writeFileSync(file, "last good dump\n");
  const s = createWriteStream(`${file}.partial`);
  s.write(rows);
  return { file, s };
};

describe("finishPartials", () => {
  it("keeps the last good file when nothing was written", async () => {
    // Review of PR 77: a dump that joined no map (a wrong CS2_DEMO_JOINS) renamed empty files over the last dump.
    const { file, s } = dump("");
    await expect(finishPartials([[s, file]], 0, "the rating dump")).rejects.toThrow("nothing was written, so the previous files are kept");
    expect(readFileSync(file, "utf-8")).toBe("last good dump\n");
    expect(existsSync(`${file}.partial`)).toBe(false);
  });

  it("puts the new file in place when rows were written", async () => {
    const { file, s } = dump("{}\n");
    await finishPartials([[s, file]], 1, "the rating dump");
    expect(readFileSync(file, "utf-8")).toBe("{}\n");
    expect(existsSync(`${file}.partial`)).toBe(false);
  });
});
