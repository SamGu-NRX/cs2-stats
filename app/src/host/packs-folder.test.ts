// The dev server's packs route (tools/packs-folder.ts) and the real-path containment it and
// tools/baselines.ts share (tools/paths.ts).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Connect } from "vite";
import { isLoopback, packFile, packsFolder } from "../../tools/packs-folder";
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
  /** the route's middleware, as the dev server registers it */
  const handler = () => {
    let h: Connect.NextHandleFunction | null = null;
    (packsFolder(root).configureServer as (s: unknown) => void)({ middlewares: { use: (f: Connect.NextHandleFunction) => { h = f; } } });
    return h!;
  };
  const ask = async (remoteAddress: string | undefined) => {
    const res = { statusCode: 0, body: null as unknown, headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; }, end(b?: unknown) { this.body = b ?? null; } };
    const req = { url: "/__packs/file?f=pros.json", headers: { host: "localhost" }, socket: { remoteAddress } };
    await handler()(req as never, res as never, () => { res.statusCode = -1; });
    return res;
  };

  it("answers loopback clients and refuses every other address with a 403", async () => {
    // fails if TAURI_DEV_HOST=0.0.0.0 lets another machine on the LAN read the private packs
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect((await ask(a)).statusCode, a).toBe(200);
    for (const a of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.20", "fe80::1", "0.0.0.0", "128.0.0.1", "127.0.0.1.evil", undefined]) {
      const r = await ask(a);
      expect([r.statusCode, r.body], String(a)).toEqual([403, null]);
    }
  });

  it("recognizes the loopback ranges exactly", () => {
    expect(["127.0.0.1", "127.255.255.254", "::1", "::ffff:127.1.2.3"].every(isLoopback)).toBe(true);
    expect(["::2", "::ffff:10.0.0.1", "1.127.0.0", "localhost", ""].some(isLoopback)).toBe(false);
  });

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
