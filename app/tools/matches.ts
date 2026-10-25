// The legacy matches and their logs, shared by tools/convert-legacy.ts and the fixture tests.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLog, readSnapshot, segmentFor, splitSegments, type Ev } from "./legacy";

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");
/**
 * Each match: its snapshot, and its event log. The first two share one log spanning several
 * matches; their segment is picked as the reference generator does. The rest have one combined
 * log each (tools/combine-logs.ts).
 * The brief gave firstFullRound 14 for the 17:14 match; the log shows 15 (round index 14 has no
 * freeze_end and only part of its damage), and the converter reports the difference.
 */
export const MATCHES: { snapshot: string; log: string; shared?: boolean; briefFirstFullRound?: number }[] = [
  { snapshot: "de_dust2_20261024_180954_match_end.json", log: "events_two_matches.jsonl", shared: true, briefFirstFullRound: 0 },
  { snapshot: "de_dust2_20261024_171429_match_end.json", log: "events_two_matches.jsonl", shared: true, briefFirstFullRound: 14 },
  { snapshot: "de_dust2_20261024_183231_match_end.json", log: "events_match_1832.jsonl" },
  { snapshot: "de_dust2_20261024_190549_match_end.json", log: "events_match_1905.jsonl" },
  { snapshot: "de_dust2_20261024_193943_match_end.json", log: "events_match3.jsonl" },
];

export function eventsFor(m: (typeof MATCHES)[number]): Ev[] {
  const evs = readLog(path.join(FIXTURES, m.log));
  if (!m.shared) return evs;
  const n = readSnapshot(path.join(FIXTURES, m.snapshot)).RoundsPlayed;
  return segmentFor(splitSegments(evs), n, m.snapshot);
}

