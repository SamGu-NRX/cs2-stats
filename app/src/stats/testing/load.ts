// Test helper: reads match files kept for tests.
// - public/samples: legacy logs converted to schema v1 (no shots, aim or positions).
// - testing/matches: copies of three files recorded by capture plugin 1.0.0 on 2026-10-25, with
//   shots, hit masks, positions, economy and utility. Copied from %APPDATA%\BotMatchStats\matches\2026
//   unchanged, so tests do not depend on that folder.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMatch } from "../decode";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(HERE, "../../../public/samples");
const PLUGIN = path.resolve(HERE, "matches");

export const SAMPLE_1809 = "20261024T223834Z_de_dust2_abe5d91c.json.gz";
export const SAMPLE_1714 = "20261024T214921Z_de_dust2_b2a5666c.json.gz";
export const SAMPLE_1939 = "20261025T000642Z_de_dust2_9b00e592.json.gz";

/** Plugin 1.0.0 recordings: 9 rounds (abandoned, round 8 partial), 23 rounds and 16 rounds. */
export const PLUGIN_MATCHES = [
  "20261025T025555Z_de_dust2_7ca6bc6c.json.gz",
  "20261025T030748Z_de_dust2_befc19e4.json.gz",
  "20261025T034340Z_de_dust2_82ddde68.json.gz",
] as const;

export function loadSample(name: string) {
  return decodeMatch(readFileSync(path.join(SAMPLES, name)), name);
}

export function loadPluginMatch(name: string) {
  return decodeMatch(readFileSync(path.join(PLUGIN, name)), name);
}
