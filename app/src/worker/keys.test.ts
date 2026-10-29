// A facts record is rebuilt when DERIVE_VERSION changes; a match entry also when the model or the
// baselines do. A record rated with another model is rated again, not derived (cached-facts.test.ts).
import { afterEach, expect, it, vi } from "vitest";
import { DERIVE_VERSION } from "../stats/facts";
import { contentHash, CS2RB, modelFingerprint, winProbSource } from "../stats/model-params";
import { entryKey, factsKey, sameEntry } from "./keys";

const file = { file: "2026/a.json.gz", size: 10, mtime: 1 };

afterEach(() => {
  vi.doUnmock("../stats/facts");
  vi.doUnmock("../../../model/rating3/params.json");
  vi.resetModules();
});

it("keys entries by the win-probability pack's content and the baselines' content", () => {
  // fails if a refitted pack, a switch to CS2RB, or rebuilt baselines leave entries shown with the old ones readable
  const pack = (p: number) => winProbSource({ source_maps: 1, tables: [{ columns: ["alive_t"], states: { "5": { p_t: p, n: 1 } } }] });
  const keys = [pack(0.5), pack(0.5), pack(0.6), CS2RB].map((wp) => entryKey(factsKey(file), modelFingerprint(wp), "b"));
  expect(keys[0]).toBe(keys[1]);
  expect(new Set(keys).size).toBe(3);
  expect(entryKey(factsKey(file), "m", contentHash('{"built":"a"}'))).not.toBe(entryKey(factsKey(file), "m", contentHash('{"built":"b"}')));
});

it("gives a refit of params.json another model fingerprint", async () => {
  // fails if a refit keeps the fingerprint: every match would keep the old model's ratings
  const params = (await import("../../../model/rating3/params.json")).default;
  vi.resetModules();
  vi.doMock("../../../model/rating3/params.json", () => ({ default: { ...params, rating: { ...params.rating, intercept: params.rating.intercept + 0.01 } } }));
  const refit = await import("../stats/model-params");
  expect(refit.modelFingerprint(refit.CS2RB)).not.toBe(modelFingerprint(CS2RB));
});

it("changes the facts key, and the entry key with it, when DERIVE_VERSION changes", async () => {
  // fails if a change to what derive computes leaves the old facts, or the entries built from them, readable
  vi.resetModules();
  vi.doMock("../stats/facts", async (real) => ({ ...(await real<typeof import("../stats/facts")>()), DERIVE_VERSION: DERIVE_VERSION + 1 }));
  const next = await import("./keys");
  expect(next.factsKey(file)).not.toBe(factsKey(file));
  expect(next.entryKey(next.factsKey(file), "m", "b")).not.toBe(entryKey(factsKey(file), "m", "b"));
});

it("reuses an entry held in memory only while both its facts and its baselines are unchanged", () => {
  // fails if rebuilt baselines leave the entries shown against the old ones in memory
  const held = { key: "f", ekey: entryKey("f", "m", "b1") };
  expect([sameEntry(held, "f", entryKey("f", "m", "b1")), sameEntry(held, "f", entryKey("f", "m", "b2")), sameEntry(held, "g", held.ekey)]).toEqual([true, false, false]);
});
