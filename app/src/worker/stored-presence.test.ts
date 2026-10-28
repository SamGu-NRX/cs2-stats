// When a presence answer kept in IndexedDB may be used, and when it is dropped (stored-presence.ts).
import { expect, it } from "vitest";
import { PRESENCE_FORMAT, storedFits, storedStale, type StoredPresence } from "./stored-presence";

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
