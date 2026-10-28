// When a presence answer kept in IndexedDB may be used, and when it is dropped (stored-presence.ts).
import { expect, it } from "vitest";
import { presenceThroughStore, PRESENCE_FORMAT, storedFits, storedStale, type PresenceSource, type StoredPresence } from "./stored-presence";

const record = (files: string[], filter = '{"player":["a"]}', format = PRESENCE_FORMAT): StoredPresence => ({ format, files, filter, presence: { de_x: { cells: {}, places: {} } } });

it("uses a kept answer only for the same facts keys, in order, the same filter and the same format", () => {
  // fails if a radar shows a shape folded from other files (a changed or re-derived match has a new
  // facts key), another filter, or an older build's fold
  const files = ["k1", "k2"];
  expect(storedFits(record(files), files, '{"player":["a"]}')).toBe(true);
  expect(storedFits(record(["k1", "k2-changed"]), files, '{"player":["a"]}')).toBe(false);
  expect(storedFits(record(["k1"]), files, '{"player":["a"]}')).toBe(false);
  expect(storedFits(record(["k2", "k1"]), files, '{"player":["a"]}')).toBe(false);
  expect(storedFits(record(files), files, '{"player":["b"]}')).toBe(false);
  expect(storedFits(record(files, '{"player":["a"]}', PRESENCE_FORMAT - 1), files, '{"player":["a"]}')).toBe(false);
  expect(storedFits(undefined, files, '{"player":["a"]}')).toBe(false);
});

it("drops a kept answer once any of its files is no longer listed as it was, or its format is old", () => {
  // fails if answers for gone or changed matches pile up in IndexedDB, or a live one is thrown away
  const live = new Set(["k1", "k2", "k3"]);
  expect(storedStale(record(["k1", "k3"]), live)).toBe(false);
  expect(storedStale(record(["k1", "gone"]), live)).toBe(true);
  expect(storedStale(record(["k1"], "f", PRESENCE_FORMAT + 1), live)).toBe(true);
  expect(storedStale(undefined, live)).toBe(true);
});

it("never stores a presence folded while a sync changed the index", async () => {
  // fails if an overlapping sync lets a fold that read library B's facts be kept under library A's keys,
  // so going back to A shows B's cells
  let gen = 1;
  let keys: Record<string, string> = { m1: "A1", m2: "A2" };
  const db = new Map<string, StoredPresence>();
  const cells = (tag: string) => ({ de_x: { cells: { [tag]: 1 }, places: {} } });
  const source = (fold: () => Promise<StoredPresence["presence"]>): PresenceSource => ({
    gen: () => gen, keyOf: (f) => keys[f],
    get: async (k) => db.get(k), put: async (k, r) => { db.set(k, r); }, fold,
  });
  const files = ["m1", "m2"], filter = '{"player":["a"]}';
  // A's fold is overtaken by a sync to B: it reads B's facts, and nothing is kept
  const mixed = await presenceThroughStore(files, filter, source(async () => { gen++; keys = { m1: "B1", m2: "B2" }; return cells("B"); }));
  expect(mixed).toEqual(cells("B"));
  expect(db.size).toBe(0);
  // B folded with no sync in between is kept under B's keys
  await presenceThroughStore(files, filter, source(async () => cells("B")));
  expect([...db.values()].map((r) => r.files)).toEqual([["B1", "B2"]]);
  // back on A, the answer is A's own fold, not B's
  keys = { m1: "A1", m2: "A2" };
  expect(await presenceThroughStore(files, filter, source(async () => cells("A")))).toEqual(cells("A"));
  expect(await presenceThroughStore(files, filter, source(async () => { throw new Error("folded again"); }))).toEqual(cells("A"));
});
