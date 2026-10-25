import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { importerCommand, listValve, readValve, ValvePathError, valveRoot } from "./tools/valve-folder";


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

/**
 * The user's imported Valve matches (tools/valve-folder.ts), for `vite dev` and `vite preview`; the
 * desktop app has the same commands in Rust. GET /__valve/list lists complete matches and the user's
 * SteamID64; GET /__valve/file?f=<demo>/<version>[/<table>.parquet] returns table names or one table;
 * POST /__valve/import runs extractor/valve_import.py and streams one JSON line per event: each
 * {"type":"progress",...} the importer reports, then {"type":"done","code","summary","error"}.
 */
function valveFolder(): Plugin {
  let running = false;
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/__valve/")) return next();
    const send = (code: number, body: string | Buffer, type = "application/json") => {
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
    };
    const root = valveRoot();
    if (!root) return send(404, JSON.stringify({ error: "APPDATA is not set and CS2_VALVE_MATCHES is not given" }));
    try {
      if (url.pathname === "/__valve/list") return send(200, JSON.stringify(listValve(root)));
      if (url.pathname === "/__valve/file") {
        const rel = url.searchParams.get("f") ?? "";
        const body = readValve(root, rel);
        return send(200, body, rel.endsWith(".parquet") ? "application/octet-stream" : "application/json");
      }
      if (url.pathname === "/__valve/import" && req.method === "POST") {
        const run = importerCommand(root);
        if ("missing" in run) return send(503, JSON.stringify({ error: run.missing }));
        if (running) return send(409, JSON.stringify({ error: "an import is already running" }));
        running = true;
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Cache-Control", "no-store");
        const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
        const child = spawn(run.cmd, run.args, { cwd: run.cwd, windowsHide: true });
        let stdout = "", errTail = "", partial = "";
        child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
        child.stderr.on("data", (b: Buffer) => {
          partial += b.toString();
          const lines = partial.split(/\r?\n/);
          partial = lines.pop() ?? "";
          for (const l of lines) {
            let ev: unknown = null;
            try { ev = JSON.parse(l); } catch { /* not a progress line */ }
            if (ev && typeof ev === "object" && "event" in ev) line({ type: "progress", ...ev });
            else if (l.trim()) errTail = `${errTail}\n${l}`.slice(-2000);
          }
        });
        child.on("error", (e) => { running = false; line({ type: "done", code: null, summary: null, error: e.message }); res.end(); });
        child.on("close", (code) => {
          running = false;
          let summary: unknown = null;
          try { summary = JSON.parse(stdout); } catch { /* a usage error prints no summary */ }
          line({ type: "done", code, summary, error: code === 0 ? null : errTail.trim() || null });
          res.end();
        });
        return;
      }
      return send(404, JSON.stringify({ error: "unknown endpoint" }));
    } catch (e) {
      return send(e instanceof ValvePathError ? 400 : 500, JSON.stringify({ error: (e as Error).message }));
    }
  };
  return {
    name: "cs2-valve-folder",
    configureServer: (s) => { s.middlewares.use(handler); },
    configurePreviewServer: (s) => { s.middlewares.use(handler); },
  };
}

/**
 * Development only: extracted match folders (schema v1 parquet, one folder per map) from the folder
 * named by CS2_DEV_MATCHES, such as cs2-stats-data/dev-matches, so views can be checked on demo data
 * before local recordings come through the extractor. Never the user's match folder: matches there
 * count in the user's career. `vite dev` only; preview, the static build and the desktop app never
 * serve it. GET /__dev-matches/list lists folders holding match.parquet as "dev/<folder>";
 * GET /__dev-matches/file?f=<folder> returns the folder's parquet file names, and
 * ?f=<folder>/<table>.parquet one file's bytes.
 */
function devMatches(): Plugin {
  const root = process.env.CS2_DEV_MATCHES ? path.resolve(process.env.CS2_DEV_MATCHES) : null;
  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/__dev-matches/")) return next();
    const send = (code: number, body: string | Buffer, type = "application/json") => {
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
    };
    // without the setting the endpoint is absent (404), not the app's index page
    if (!root) return send(404, JSON.stringify({ error: "CS2_DEV_MATCHES is not set" }));
    try {
      if (url.pathname === "/__dev-matches/list") {
        const files: { file: string; size: number; mtime: number }[] = [];
        for (const d of await fs.readdir(root, { withFileTypes: true })) {
          const m = path.join(root, d.name, "match.parquet");
          if (!d.isDirectory() || !existsSync(m)) continue;
          const st = await fs.stat(m);
          files.push({ file: `dev/${d.name}`, size: st.size, mtime: Math.round(st.mtimeMs) });
        }
        return send(200, JSON.stringify({ folder: root, files }));
      }
      if (url.pathname === "/__dev-matches/file") {
        const rel = url.searchParams.get("f") ?? "";
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(root + path.sep)) return send(400, JSON.stringify({ error: "not inside the dev match folder" }));
        if (rel.endsWith(".parquet")) return send(200, await fs.readFile(abs), "application/octet-stream");
        return send(200, JSON.stringify((await fs.readdir(abs)).filter((f) => f.endsWith(".parquet"))));
      }
      return send(404, JSON.stringify({ error: "unknown endpoint" }));
    } catch (e) {
      return send(500, JSON.stringify({ error: (e as Error).message }));
    }
  };
  return { name: "cs2-dev-matches", apply: "serve", configureServer: (s) => { s.middlewares.use(handler); } };
}

export default defineConfig({
  plugins: [react(), matchFolder(), valveFolder(), devMatches()],
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
