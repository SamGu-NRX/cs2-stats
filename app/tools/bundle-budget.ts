// Checks the built app (dist/, after `pnpm build`) against its size budgets:
//   pnpm bundle-budget
// Before the first paint the UI thread loads the entry script and every chunk index.html preloads with
// it, so the stats engine must stay out of them: the engine runs in the stats worker
// (worker/protocol.ts), and one value import of an engine module from a UI file used to pull most of
// it in, about 30 kB gzip of that first load. Sizes are gzip at zlib's default level, which matches the
// gzip column of `vite build`. Each budget sits about 10% over the size measured when it was set, so
// moving the engine back into a UI chunk trips it and ordinary growth does not.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const DIST = path.resolve(import.meta.dirname, "../dist");
/** kB as Vite reports them */
const KB = 1000;

/** gzip budgets in bytes. */
const BUDGET = {
  /** the entry script and the chunks index.html preloads with it, summed (132.1 kB when set; 163.1 kB with the engine in it) */
  initial: 145 * KB,
  /** the entry stylesheet (34.1 kB when set) */
  css: 38 * KB,
  /** any chunk loaded later, for a route or a tab (Profile, the largest, was 23.6 kB) */
  lazy: 30 * KB,
  /**
   * Each worker, by name. The stats worker starts before the first scan (191 kB when set), a derive
   * worker for a scan with many files to derive (144 kB), the replay worker with the Replay tab
   * (100 kB). A worker with no budget here fails the check, so a new one gets one.
   */
  workers: { "stats.worker": 210 * KB, "derive.worker": 160 * KB, "replay.worker": 112 * KB } as Record<string, number>,
} as const;

const html = readFileSync(path.join(DIST, "index.html"), "utf-8");
const assets = readdirSync(path.join(DIST, "assets"));
const name = (href: string) => path.basename(href);
const entry = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
const css = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
if (!entry || !css) throw new Error("dist/index.html names no entry script or stylesheet; run pnpm build first");
const initial = [name(entry), ...[...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)].map((m) => name(m[1]))];
const workers = assets.filter((f) => /\.worker-[^.]+\.js$/.test(f));
if (!workers.some((f) => f.startsWith("stats.worker-"))) throw new Error("dist/assets has no stats.worker-*.js; run pnpm build first");
const workerBudget = (f: string) => {
  const budget = BUDGET.workers[f.slice(0, f.indexOf(".worker-") + ".worker".length)];
  if (budget === undefined) throw new Error(`${f}: a worker with no budget in tools/bundle-budget.ts; give it one`);
  return budget;
};

const gz = (f: string) => gzipSync(readFileSync(path.join(DIST, "assets", f))).length;
const kb = (n: number) => `${(n / KB).toFixed(1)} kB`;
const checks: { what: string; size: number; budget: number }[] = [
  { what: `first load (${initial.length} chunks)`, size: initial.reduce((a, f) => a + gz(f), 0), budget: BUDGET.initial },
  { what: `stylesheet ${name(css)}`, size: gz(name(css)), budget: BUDGET.css },
  ...workers.map((f) => ({ what: `worker ${f}`, size: gz(f), budget: workerBudget(f) })),
];
const lazy = assets.filter((f) => f.endsWith(".js") && !initial.includes(f) && !/\.worker-/.test(f)).map((f) => ({ what: `lazy chunk ${f}`, size: gz(f), budget: BUDGET.lazy }));
checks.push(...lazy);

for (const c of checks.filter((x) => !lazy.includes(x))) console.log(`${c.what.padEnd(48)} ${kb(c.size).padStart(9)} of ${kb(c.budget)}`);
const largest = [...lazy].sort((a, b) => b.size - a.size)[0];
if (largest) console.log(`${`largest ${largest.what}`.padEnd(48)} ${kb(largest.size).padStart(9)} of ${kb(largest.budget)}`);
const over = checks.filter((c) => c.size > c.budget);
if (over.length) {
  for (const c of over) console.error(`OVER BUDGET: ${c.what} is ${kb(c.size)} gzip, budget ${kb(c.budget)}`);
  if (over.some((c) => !c.what.startsWith("worker "))) console.error("Look for a UI file that imports a value (not a type) from src/stats: that pulls the engine into the UI's chunks.");
  console.error("`pnpm exec vite build --sourcemap` shows which sources a chunk holds.");
  process.exit(1);
}
