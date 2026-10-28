// The presence answers the stats worker keeps in IndexedDB (idb.ts "presence"). The radar backgrounds
// ask for every match on a map with every player, which reads each of those matches' facts: 0.4 to
// 2.5 s of worker time per pro map in the release build, at every launch and ahead of the calls the
// open tab is waiting on. A kept answer is used when it was folded from the same files (by facts key,
// which changes with the file and with DERIVE_VERSION), the same filter and the same format.
import { contentHash } from "../stats/model-params";
import type { Summary } from "../stats/rollup";

export interface StoredPresence { format: number; files: string[]; filter: string; presence: Summary["presence"] }

/** Raise when addPresence's output changes, so answers kept by an older build are not used. */
export const PRESENCE_FORMAT = 1;

/** The record's key. A 32-bit hash, so a record is checked with storedFits before its answer is used. */
export const storedKey = (files: string[], filter: string) => contentHash(`${PRESENCE_FORMAT}\n${filter}\n${files.join("\n")}`);

/** Whether a kept record answers this question: same format, filter and facts keys, in order. */
export function storedFits(r: StoredPresence | undefined, files: string[], filter: string): r is StoredPresence {
  return !!r && r.format === PRESENCE_FORMAT && r.filter === filter && r.files.length === files.length && r.files.every((f, i) => f === files[i]);
}

/** Whether a kept record can never be asked for again: another format, or folded from a file no longer listed as it was. */
export const storedStale = (r: StoredPresence | undefined, live: ReadonlySet<string>) => !r || r.format !== PRESENCE_FORMAT || r.files.some((f) => !live.has(f));

/** What presenceThroughStore needs from the worker: the index as it stands, IndexedDB, and the fold. */
export interface PresenceSource {
  /** the match index's generation (stats.worker.ts gen), raised whenever a sync changes a file's facts key */
  gen(): number;
  /** a file's facts key in the index now */
  keyOf(file: string): string;
  get(key: string): Promise<StoredPresence | undefined>;
  put(key: string, r: StoredPresence): Promise<void>;
  /** folds the presence of `files` under `filter`, reading each file's facts from the index as it stands then */
  fold(): Promise<Summary["presence"]>;
}

/**
 * A presence answer from IndexedDB when the same files and filter were folded before, else folded now and
 * kept. A sync that changes the index while the fold reads can mix two versions of a file into it, so
 * an answer folded across a generation change is returned once and never stored: stored, it would stand
 * under the keys of files it was not folded from.
 */
export async function presenceThroughStore(files: string[], filter: string, s: PresenceSource): Promise<Summary["presence"]> {
  const at = s.gen();
  const keys = files.map((f) => s.keyOf(f));
  const key = storedKey(keys, filter);
  const hit = await s.get(key).catch(() => undefined);
  if (storedFits(hit, keys, filter)) return hit.presence;
  const presence = await s.fold();
  // a failed write only costs the next launch a fold
  if (s.gen() === at) await s.put(key, { format: PRESENCE_FORMAT, files: keys, filter, presence }).catch(() => {});
  return presence;
}
