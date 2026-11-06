// Rating facts that were rated with another model gives exactly what deriving them with this one gives:
// the stats worker rates kept facts again after a refit (worker/cached-facts.ts) instead of deriving them.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { derive, deriveBase } from "./derive";
import { CS2RB, winProbSource } from "./model-params";
import { pluginToTables } from "./plugin/adapter";
import { decodeMatch } from "./plugin/decode";
import { rate } from "./rate";

const SAMPLES = path.resolve(import.meta.dirname, "../../public/samples");
const FILES = readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"));

/** An HLTV-style lookup that values every count of living players, unlike CS2RB, which also weighs health, equipment and time. */
const ALIVE = winProbSource({
  source_maps: 1,
  tables: [{ columns: ["alive_t", "alive_ct"], states: Object.fromEntries(Array.from({ length: 36 }, (_, i) => [`${i % 6}|${Math.floor(i / 6)}`, { p_t: ((i % 6) + 1) / ((i % 6) + Math.floor(i / 6) + 2), n: 1 }])) }],
});

it.each(FILES)("rates %s already rated with another model as deriving it with this one does", async (file) => {
  // fails if rate() leaves any value of the model the facts were rated with, which every refit would
  // then carry into the ratings, the swing and the win-probability path
  const tables = pluginToTables(await decodeMatch(readFileSync(path.join(SAMPLES, file)), file));
  const { facts, inputs } = deriveBase(tables);
  const other = rate(facts, inputs, ALIVE);
  const again = rate(other, inputs, CS2RB);
  // the two models value the match differently, so a value left from the first would show
  expect(other.pr.map((r) => r.m.swing)).not.toEqual(again.pr.map((r) => r.m.swing));
  expect(again).toEqual(derive(tables, CS2RB));
  expect(rate(again, inputs, ALIVE)).toEqual(other);
});
