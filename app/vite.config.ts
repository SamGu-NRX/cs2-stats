import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";


// Tauri expects a fixed dev port and must not watch the Rust sources.
const host = process.env.TAURI_DEV_HOST;

/**
 * Serves the capture plugin's match folder to the browser in `vite dev` and `vite preview`, so the
 * web build shows the same recorded matches as the desktop app. Mirrors the Rust commands:
 * GET /__matches/list lists finished files (skipping inprogress), GET /__matches/file?f=<rel>
 * returns one file's gzip bytes. Paths must stay inside the folder and end in .json.gz.
 */
function matchFolder(): Plugin {
  const root = process.env.APPDATA ? path.join(process.env.APPDATA, "BotMatchStats", "matches") : null;
  const packs = process.env.APPDATA ? path.join(process.env.APPDATA, "BotMatchStats", "packs") : null;
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__packs/file") {
      // the optional packs folder: pro scores and agent art kept out of the repository
      const rel = url.searchParams.get("f") ?? "";
      const abs = packs ? path.resolve(packs, rel) : "";
      if (!packs || !/\.(json|png)$/.test(rel) || !abs.startsWith(path.resolve(packs) + path.sep)) { res.statusCode = 400; return res.end(); }
      if (!existsSync(abs)) { res.statusCode = 404; return res.end(); }
      res.setHeader("Content-Type", rel.endsWith(".png") ? "image/png" : "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.end(await fs.readFile(abs));
    }
    if (!url.pathname.startsWith("/__matches/")) return next();
    const send = (code: number, body: string | Buffer, type = "application/json") => {
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
    };
    if (!root) return send(404, JSON.stringify({ error: "APPDATA is not set" }));
    try {
      if (url.pathname === "/__matches/list") {
        const files: { file: string; size: number; mtime: number }[] = [];
        const add = async (abs: string) => {
          if (!abs.endsWith(".json.gz")) return;
          const st = await fs.stat(abs);
          if (st.isFile()) files.push({ file: path.relative(root, abs).split(path.sep).join("/"), size: st.size, mtime: Math.round(st.mtimeMs) });
        };
        const top = existsSync(root) ? await fs.readdir(root, { withFileTypes: true }) : [];
        for (const d of top) {
          const abs = path.join(root, d.name);
          if (d.isDirectory()) {
            if (d.name === "inprogress") continue;
            for (const f of await fs.readdir(abs)) await add(path.join(abs, f));
          } else await add(abs);
        }
        files.sort((a, b) => b.file.localeCompare(a.file));
        return send(200, JSON.stringify({ folder: root, files }));
      }
      if (url.pathname === "/__matches/file") {
        const rel = url.searchParams.get("f") ?? "";
        const abs = path.resolve(root, rel);
        if (!rel.endsWith(".json.gz") || !abs.startsWith(path.resolve(root) + path.sep)) return send(400, JSON.stringify({ error: "not a match file inside the folder" }));
        return send(200, await fs.readFile(abs), "application/octet-stream");
      }
      return send(404, JSON.stringify({ error: "unknown endpoint" }));
    } catch (e) {
      return send(500, JSON.stringify({ error: (e as Error).message }));
    }
  };
  return {
    name: "cs2-match-folder",
    configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [react(), matchFolder()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    // the engine imports ../model/rating3/params.json (Rating 3.0 and win probability)
    fs: { allow: [".", "../model"] },
  },
  preview: { port: 4173, strictPort: true },
  worker: { format: "es" },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    reportCompressedSize: true,
  },
  // One test process, files in sequence: the suite takes about a second, and this keeps it light
  // on a machine that may be running the game.
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
