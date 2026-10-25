// Joins legacy event logs that were split by plugin reloads into one log for one match.
// Usage: pnpm exec vite-node tools/combine-logs.ts <out.jsonl> <fromTick> <toTick> <log1.jsonl> [log2.jsonl ...]
//
// - Logs are read in the order given and must be chronological.
// - Lines repeated from an earlier log (across a reload boundary) are written once.
// - Only events with fromTick <= Tick <= toTick are kept (one match).
// - Between two logs, a {"T":"log_gap"} line records the window in which nothing was logged
//   (the plugin was unloaded). tools/convert-legacy.ts treats rounds touching a gap as incomplete.
import { readFileSync, writeFileSync } from "node:fs";

const [out, fromArg, toArg, ...logs] = process.argv.slice(2);
if (!out || !fromArg || !toArg || !logs.length) {
  throw new Error("usage: combine-logs.ts <out.jsonl> <fromTick> <toTick> <log1.jsonl> [log2.jsonl ...]");
}
const from = Number(fromArg);
const to = Number(toArg);
interface Ev { T: string; Tick: number; Time: number; Round: number }

const lines: string[] = [];
const seen = new Set<string>();
let last: Ev | null = null;
let gaps = 0;
let dropped = 0;
for (const file of logs) {
  const kept = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).filter((l) => {
    const t = (JSON.parse(l) as Ev).Tick;
    return t >= from && t <= to;
  });
  if (!kept.length) continue;
  const first = JSON.parse(kept[0]) as Ev;
  if (last && first.Tick < last.Tick) throw new Error(`${file} starts at tick ${first.Tick}, before the previous log ends (${last.Tick})`);
  if (last) {
    lines.push(JSON.stringify({ T: "log_gap", Tick: last.Tick, Time: last.Time, Round: last.Round, Data: { untilTick: first.Tick, untilTime: first.Time, file } }));
    gaps++;
  }
  // Only lines repeated from an earlier log count as duplicates; identical lines within one log stay.
  for (const l of kept) {
    if (seen.has(l)) { dropped++; continue; }
    lines.push(l);
  }
  for (const l of kept) seen.add(l);
  last = JSON.parse(kept[kept.length - 1]) as Ev;
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${out}: ${lines.length} lines, ${gaps} reload gap(s), ${dropped} duplicate line(s) dropped`);
