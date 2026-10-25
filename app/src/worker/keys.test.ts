// Cached facts and entries must be rebuilt when what they were derived with changes.
import { expect, it } from "vitest";
import { contentHash, CS2RB, modelFingerprint, winProbSource } from "../stats/model-params";
import { entryKey, factsKey, sameEntry } from "./keys";

it("keys facts by the win-probability pack's content and entries by the baselines' content", () => {
  // fails if a refitted pack, a switch to CS2RB, or rebuilt baselines leave the old cache readable
  const file = { file: "2026/a.json.gz", size: 10, mtime: 1 };
  const pack = (p: number) => winProbSource({ source_maps: 1, tables: [{ columns: ["alive_t"], states: { "5": { p_t: p, n: 1 } } }] });
  const keys = [pack(0.5), pack(0.5), pack(0.6), CS2RB].map((wp) => factsKey(file, modelFingerprint(wp)));
  expect(keys[0]).toBe(keys[1]);
  expect(new Set(keys).size).toBe(3);
  expect(entryKey(keys[0], contentHash('{"built":"a"}'))).not.toBe(entryKey(keys[0], contentHash('{"built":"b"}')));
});

it("reuses an entry held in memory only while both its facts and its baselines are unchanged", () => {
  // fails if rebuilt baselines leave the entries shown against the old ones in memory
  const held = { key: "f", ekey: entryKey("f", "b1") };
  expect([sameEntry(held, "f", entryKey("f", "b1")), sameEntry(held, "f", entryKey("f", "b2")), sameEntry(held, "g", held.ekey)]).toEqual([true, false, false]);
});
