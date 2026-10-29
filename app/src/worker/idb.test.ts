// Opening the IndexedDB cache after a newer build upgraded it (idb.ts open).
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { scanErrorText } from "../ui/data/sources";
import { CACHE_TOO_NEW } from "./protocol";

const at = (version?: number, upgrade?: (db: IDBDatabase) => void) => new Promise<IDBDatabase>((resolve, reject) => {
  const q = version === undefined ? indexedDB.open("cs2-stats-cache") : indexedDB.open("cs2-stats-cache", version);
  q.onupgradeneeded = () => upgrade?.(q.result);
  q.onsuccess = () => resolve(q.result);
  q.onerror = () => reject(q.error);
});

it("says a newer build's cache cannot be opened, in words, and leaves that cache as it is", async () => {
  // fails if an older build shows IndexedDB's raw VersionError on Home and in the scan status, or
  // deletes or rebuilds the newer build's cache to get past it
  globalThis.indexedDB = new IDBFactory();
  (await at(99, (db) => db.createObjectStore("facts"))).close();
  const { idbKeys } = await import("./idb");
  await expect(idbKeys("facts")).rejects.toThrow(CACHE_TOO_NEW);
  expect(scanErrorText(CACHE_TOO_NEW)).toBe(CACHE_TOO_NEW);
  const db = await at();
  expect([db.version, [...db.objectStoreNames]]).toEqual([99, ["facts"]]);
  db.close();
});
