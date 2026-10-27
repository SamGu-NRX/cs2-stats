// Checks the built app (dist/, after `pnpm build`) against its size budgets:
//   pnpm bundle-budget
// The UI thread parses the entry chunk before the first paint, so the stats engine must stay out of it:
// the engine runs in the stats worker (worker/protocol.ts), and one value import of an engine module
// from a UI file used to pull most of the engine in (a 472 kB entry chunk, 156 kB gzip; 378 kB
// and 125 kB without it). Sizes are gzip at zlib's default level, which matches the gzip column of
// `vite build`. The budgets sit about 10% over the sizes measured when they were set, so moving the
// engine back into a UI chunk trips them and ordinary growth does not.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const DIST = path.resolve(import.meta.dirname, "../dist");
/** kB as Vite reports them */
const KB = 1000;

/** gzip budgets in bytes. */
const BUDGET = {
  /** index-*.js: the UI thread's first script (124.8 kB gzip when set) */
  entry: 138 * KB,
  /** index-*.css (31.6 kB gzip when set) */
  entryCss: 35 * KB,
  /** any lazily loaded chunk: a route or a match tab (Profile, the largest, was 23.6 kB gzip) */
  lazy: 30 * KB,
  /** the stats worker, parsed before the first scan starts (191 kB gzip when set) */
  statsWorker: 210 * KB,
} as const;

const html = readFileSync(path.join(DIST, "index.html"), "utf-8");
const ref = (re: RegExp, what: string) => {
  const m = re.exec(html);
  if (!m) throw new Error(`dist/index.html names no ${what}; run pnpm build first`);
  return path.basename(m[1]);
};
const entry = ref(/<script[^>]+src="\/?(assets\/index-[^"]+\.js)"/, "entry script");
const entryCss = ref(/<link[^>]+href="\/?(assets\/index-[^"]+\.css)"/, "entry stylesheet");
const assets = readdirSync(path.join(DIST, "assets"));
const gz = (f: string) => gzipSync(readFileSync(path.join(DIST, "assets", f))).length;
const kb = (n: number) => `${(n / KB).toFixed(1)} kB`;

const checks: { file: string; size: number; budget: number; what: string }[] = [
  { file: entry, size: gz(entry), budget: BUDGET.entry, what: "entry chunk" },
  { file: entryCss, size: gz(entryCss), budget: BUDGET.entryCss, what: "entry stylesheet" },
];
const statsWorker = assets.find((f) => /^stats\.worker-.+\.js$/.test(f));
if (!statsWorker) throw new Error("dist/assets has no stats.worker-*.js; run pnpm build first");
checks.push({ file: statsWorker, size: gz(statsWorker), budget: BUDGET.statsWorker, what: "stats worker" });
for (const f of assets) {
  if (!f.endsWith(".js") || f === entry || /\.worker-/.test(f)) continue;
  checks.push({ file: f, size: gz(f), budget: BUDGET.lazy, what: "lazy chunk" });
}

const over = checks.filter((c) => c.size > c.budget);
for (const c of checks.filter((x) => x.what !== "lazy chunk")) console.log(`${c.what.padEnd(16)} ${c.file.padEnd(36)} ${kb(c.size).padStart(9)} of ${kb(c.budget)}`);
const lazy = checks.filter((c) => c.what === "lazy chunk").sort((a, b) => b.size - a.size)[0];
if (lazy) console.log(`${"largest lazy".padEnd(16)} ${lazy.file.padEnd(36)} ${kb(lazy.size).padStart(9)} of ${kb(lazy.budget)}`);
if (over.length) {
  for (const c of over) console.error(`OVER BUDGET: ${c.what} ${c.file} is ${kb(c.size)} gzip, budget ${kb(c.budget)}`);
  if (over.some((c) => c.what !== "stats worker")) console.error("Look for a UI file that imports a value (not a type) from src/stats: that pulls the engine into the UI's chunks.");
  console.error("`pnpm exec vite build --sourcemap` shows which sources a chunk holds.");
  process.exit(1);
}
