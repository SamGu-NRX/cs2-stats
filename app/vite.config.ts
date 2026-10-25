import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The trained win-probability model is bundled only when it is complete: winprob.ts and the
// model.json it imports. A half-written export must not break the app's build.
const modelDir = path.resolve(__dirname, "../model/export");
const modelReady = existsSync(path.join(modelDir, "winprob.ts")) && existsSync(path.join(modelDir, "model.json"));
const modelModule = modelReady ? path.join(modelDir, "winprob.ts") : path.resolve(__dirname, "src/stats/no-model.ts");

// Tauri expects a fixed dev port and must not watch the Rust sources.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@model/winprob": modelModule } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    // the worker bundles ../model/export/winprob.ts and its model.json when both exist
    fs: { allow: [".", "../model"] },
  },
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
    include: ["src/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
