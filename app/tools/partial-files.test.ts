import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finishPartials } from "./partial-files";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Two dump files, each with a last good copy, and a partial stream for each holding the given rows. */
const dump = (rounds: string, kills: string) => {
  dir = mkdtempSync(path.join(tmpdir(), "partials-"));
  return (["rating-rounds.private.jsonl", "rating-kills.private.jsonl"] as const).map((name, i) => {
    const file = path.join(dir, name);
    writeFileSync(file, "last good dump\n");
    const s = createWriteStream(`${file}.partial`);
    s.write(i === 0 ? rounds : kills);
    return [s, file] as [ReturnType<typeof createWriteStream>, string];
  });
};

describe("finishPartials", () => {
  it("keeps the last good files when the required one got no rows, whatever else was written", async () => {
    // Review of PR 77: the guard counted joined maps, so a run that read a map but wrote no player-round (its
    // kills file had rows) renamed an empty rounds file over the last dump. It now reads what the stream wrote.
    const files = dump("", "{}\n");
    await expect(finishPartials(files, files[0][1], "the rating dump")).rejects.toThrow("nothing was written, so the previous files are kept");
    for (const [, file] of files) {
      expect(readFileSync(file, "utf-8")).toBe("last good dump\n");
      expect(existsSync(`${file}.partial`)).toBe(false);
    }
  });

  it("puts the new files in place when the required one got rows", async () => {
    const files = dump("{}\n", "");
    await finishPartials(files, files[0][1], "the rating dump");
    expect(files.map(([, file]) => readFileSync(file, "utf-8"))).toEqual(["{}\n", ""]);
  });
});
