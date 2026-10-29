// Minimal IndexedDB store for derived match facts and the match list built from them. The cache is
// rebuildable: deleting it only costs one re-derivation pass.
import { CACHE_TOO_NEW } from "./protocol";

const DB = "cs2-stats-cache";
/**
 * facts: MatchFacts with their rating inputs and the file's origin label, by facts key (derive-file.ts
 * Cached); entries: the MatchEntry of the same file;
 * presence: the worker's presence answers (a map's sampled shape), with the file keys they were folded from.
 */
export const STORES = ["facts", "entries", "presence"] as const;
type Store = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    // Version 4 adds the presence store. Version 3 added the entries store, so a sync reads small
    // entries instead of every match's facts. Version 2 cached MatchFacts; version 1's summary and
    // position stores held the old engine's output.
    const req = indexedDB.open(DB, 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of [...db.objectStoreNames]) if (!(STORES as readonly string[]).includes(s)) db.deleteObjectStore(s);
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    // A newer build upgraded the cache past this version: say so, and leave the cache as it is. It
    // stays readable to the newer build, and the matches it was derived from are on disk.
    req.onerror = () => reject(req.error?.name === "VersionError" ? new Error(CACHE_TOO_NEW) : req.error);
  });
  // a failed open is tried again on the next call (Try again), not kept
  dbp.catch(() => { dbp = null; });
  return dbp;
}

const wrap = <T>(req: IDBRequest<T>) => new Promise<T>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

/** Several keys in one transaction, in their order; undefined for a key that is not there. */
export async function idbGetMany<T>(store: Store, keys: string[]): Promise<(T | undefined)[]> {
  if (!keys.length) return [];
  const db = await open();
  const os = db.transaction(store).objectStore(store);
  return Promise.all(keys.map((k) => wrap(os.get(k)) as Promise<T | undefined>));
}

export async function idbPut(store: Store, key: string, value: unknown): Promise<void> {
  const db = await open();
  await wrap(db.transaction(store, "readwrite").objectStore(store).put(value, key));
}

export async function idbKeys(store: Store): Promise<string[]> {
  const db = await open();
  return (await wrap(db.transaction(store).objectStore(store).getAllKeys())) as string[];
}

export async function idbDelete(store: Store, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const db = await open();
  const tx = db.transaction(store, "readwrite");
  for (const k of keys) tx.objectStore(store).delete(k);
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
