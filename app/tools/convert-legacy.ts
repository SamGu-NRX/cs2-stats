// Converts the legacy bot matches in ../../fixtures (server snapshots + event logs) into schema-v1
// match files in public/samples/, which serve as the app's sample data and as test fixtures.
// Usage: pnpm convert
//
// The rules are in tools/legacy.ts. Logs split by plugin reloads are joined first with
// tools/combine-logs.ts, which also marks the reload gaps.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { convertMatch } from "./legacy";
import { eventsFor, FIXTURES, MATCHES } from "./matches";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/samples");

function main() {
  mkdirSync(OUT, { recursive: true });
  const names: string[] = [];
  for (const m of MATCHES) {
    const { file, name, warnings } = convertMatch(path.join(FIXTURES, m.snapshot), eventsFor(m), { briefFirstFullRound: m.briefFirstFullRound });
    console.log(`  ${m.snapshot}`);
    for (const w of warnings) console.log(`    ${w}`);
    writeFileSync(path.join(OUT, name), gzipSync(JSON.stringify(file), { level: 9 }));
    names.push(name);
    console.log(`    wrote public/samples/${name}`);
  }
  writeFileSync(path.join(OUT, "index.json"), JSON.stringify(names.sort().reverse(), null, 1) + "\n");
}

main();
