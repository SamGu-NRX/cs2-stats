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
