// The packs route on real servers built from vite.config.ts: `vite dev` serves the packs folder,
// `vite preview` of a production build must not.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, preview, type PreviewServer, type ViteDevServer } from "vite";

const APP = path.resolve(import.meta.dirname, "../..");
const base = mkdtempSync(path.join(tmpdir(), "cs2-packs-route-"));
const was = process.env.APPDATA;
let dev: ViteDevServer;
let prev: PreviewServer;

beforeAll(async () => {
  // the plugins read APPDATA when the config loads
  process.env.APPDATA = base;
  mkdirSync(path.join(base, "BotMatchStats", "packs"), { recursive: true });
  writeFileSync(path.join(base, "BotMatchStats", "packs", "pros.json"), '{"pros":[]}');
  const configFile = path.join(APP, "vite.config.ts");
  dev = await createServer({ configFile, root: APP, logLevel: "silent", server: { port: 0, strictPort: false, hmr: false, watch: null } });
  await dev.listen();
  // preview serves a build; an empty outDir is enough to start it and reach its middlewares
  const outDir = path.join(base, "dist");
  mkdirSync(outDir);
  writeFileSync(path.join(outDir, "index.html"), "<!doctype html><title>build</title>");
  prev = await preview({ configFile, root: APP, logLevel: "silent", build: { outDir }, preview: { port: 0, strictPort: false } });
}, 60_000);

afterAll(async () => {
  await dev?.close();
  await new Promise<void>((r) => (prev ? prev.httpServer.close(() => r()) : r()));
  process.env.APPDATA = was;
  rmSync(base, { recursive: true, force: true });
});

const url = (s: { httpServer: { address(): unknown } | null }, p: string) => `http://localhost:${(s.httpServer!.address() as AddressInfo).port}${p}`;

describe("/__packs on real servers", () => {
  it("answers on the dev server and not on the preview server", async () => {
    // fails if configurePreviewServer serves the private packs again
    const d = await fetch(url(dev, "/__packs/file?f=pros.json"));
    expect([d.status, await d.text()]).toEqual([200, '{"pros":[]}']);
    const p = await fetch(url(prev, "/__packs/file?f=pros.json"));
    expect(await p.text()).not.toContain('"pros"');
    expect(p.headers.get("content-type") ?? "").not.toContain("application/json");
  });
});
