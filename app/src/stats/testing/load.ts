// Test helper: reads a converted sample match from public/samples.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMatch } from "../decode";

const SAMPLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../public/samples");

export const SAMPLE_1809 = "20261024T223834Z_de_dust2_abe5d91c.json.gz";
export const SAMPLE_1714 = "20261024T214921Z_de_dust2_b2a5666c.json.gz";
export const SAMPLE_1939 = "20261025T000642Z_de_dust2_9b00e592.json.gz";

export function loadSample(name: string) {
  return decodeMatch(readFileSync(path.join(SAMPLES, name)), name);
}
