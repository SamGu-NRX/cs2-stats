// Writes the synthetic demo match to public/samples/synthetic-demo.json.gz. It is not listed in
// samples/index.json; the web build loads it only with ?demo=synthetic, labelled as synthetic.
// Usage: pnpm exec vite-node tools/make-synthetic.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { syntheticMatch } from "../src/stats/testing/synthetic";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/samples/synthetic-demo.json.gz");
writeFileSync(out, gzipSync(JSON.stringify(syntheticMatch(7)), { level: 9 }));
console.log("wrote", out);
