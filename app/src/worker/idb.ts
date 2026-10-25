// Minimal IndexedDB store for derived summaries. The cache is rebuildable: deleting it only costs
// one re-derivation pass.
const DB = "cs2-stats-cache";
export const STORES = ["summary", "pos"] as const;
type Store = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = <T>(req: IDBRequest<T>) => new Promise<T>((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function idbGet<T>(store: Store, key: string): Promise<T | undefined> {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
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
