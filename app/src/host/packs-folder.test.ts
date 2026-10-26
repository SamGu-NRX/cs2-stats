// The dev server's packs route (tools/packs-folder.ts) and the real-path containment it and
// tools/baselines.ts share (tools/paths.ts).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { packFile, packsFolder } from "../../tools/packs-folder";
import { isInside } from "../../tools/paths";

const base = mkdtempSync(path.join(tmpdir(), "cs2-packs-"));
const root = path.join(base, "packs");
const outside = path.join(base, "elsewhere");
mkdirSync(path.join(root, "icons"), { recursive: true });
mkdirSync(outside);
writeFileSync(path.join(root, "pros.json"), "{}");
writeFileSync(path.join(root, "icons", "ak47.svg"), "<svg/>");
mkdirSync(path.join(root, "dir.json"));
writeFileSync(path.join(outside, "secret.json"), '{"secret":1}');
// a junction inside the folder that leads out of it (Windows makes one without admin rights)
symlinkSync(outside, path.join(root, "link"), "junction");
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("packFile", () => {
  it("serves a pack file inside the folder with its type", async () => {
    const a = await packFile(root, "icons/ak47.svg");
    expect(a.status === 200 && [a.type, a.bytes.toString()]).toEqual(["image/svg+xml", "<svg/>"]);
    expect((await packFile(root, "pros.json")).status).toBe(200);
  });

  it("refuses names outside the folder, through a junction, of other types, or that are not files", async () => {
    // fails if a lexical check lets a link or junction read outside the packs folder, or a directory is read
    expect((await packFile(root, "../elsewhere/secret.json")).status).toBe(400);
    expect((await packFile(root, "link/secret.json")).status).toBe(400);
    expect((await packFile(root, "pros.txt")).status).toBe(400);
    expect((await packFile(root, "dir.json")).status).toBe(400);
    expect((await packFile(root, null)).status).toBe(400);
    expect((await packFile(null, "pros.json")).status).toBe(400);
    expect((await packFile(root, "missing.json")).status).toBe(404);
    expect(readFileSync(path.join(root, "link", "secret.json"), "utf8")).toContain("secret");
  });
});

describe("the packs route", () => {
  it("exists for `vite dev` only, never for `vite preview` of a production build", () => {
    // fails if the private packs are served by preview again
    const p = packsFolder(root);
    expect(typeof p.configureServer).toBe("function");
    expect(p.configurePreviewServer).toBeUndefined();
    const config = readFileSync(path.resolve(import.meta.dirname, "../../vite.config.ts"), "utf8");
    expect(config).not.toContain('"/__packs');
  });
});

describe("isInside", () => {
  const pub = path.join(base, "public");
  mkdirSync(pub);
  it("compares real paths, a file that does not exist yet included", () => {
    expect(isInside(path.join(pub, "baselines.json"), pub)).toBe(true);
    expect(isInside(path.join(pub, "deep", "new", "x.json"), pub)).toBe(true);
    expect(isInside(pub, pub)).toBe(true);
  });

  it("is not fooled by .., a sibling with the same prefix, or a junction", () => {
    expect(isInside(path.join(pub, "..", "public2", "x.json"), pub)).toBe(false);
    expect(isInside(path.join(pub, "..", "x.json"), pub)).toBe(false);
    expect(isInside(path.join(base, "public-old", "x.json"), pub)).toBe(false);
    expect(isInside(path.join(pub, "..", "public", "x.json"), pub)).toBe(true);
    expect(isInside(path.join(root, "link", "secret.json"), root)).toBe(false);
  });

  it.runIf(process.platform === "win32")("ignores case on Windows, where the file system does", () => {
    // fails if PUBLIC\baselines.json gets past a guard on public\ (the case-sensitive check did)
    expect(isInside(path.join(base, "PUBLIC", "baselines.json"), pub)).toBe(true);
    expect(isInside(path.join(base, "Public", "..", "PUBLIC", "Deep", "X.JSON"), pub)).toBe(true);
    expect(isInside(path.join(base, "PUBLIC-old", "x.json"), pub)).toBe(false);
  });
});
