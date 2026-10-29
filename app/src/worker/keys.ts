// The worker's IndexedDB keys. A facts record depends on the file and DERIVE_VERSION. It does not depend
// on the model (rating parameters and win-probability source, by content: model-params.ts
// modelFingerprint): a record rated with another model is rated again from what it keeps (rate.ts,
// stats.worker.ts cached), not derived again. A match entry depends on its facts, the model and the
// pro baselines it was shown against (by content). A change to any of them makes a new key, so a stale
// record is rebuilt instead of read.
import type { FileEntry } from "../host/host";
import { DERIVE_VERSION } from "../stats/facts";

/** Bump when MatchEntry's shape or what entryOf computes into it changes, so cached entries are rebuilt. */
// 2: MatchEntry.kills, 3: MatchEntry.activity, 4: a pro demo's entry has no recording player (you and
// line null); a version-3 store holds a NoEntry record for every pro map, which must not stand
export const ENTRY_VERSION = 4;

// A Valve match's facts are derived from the user's point of view (FileEntry.pov), so a different user is a
// different key; a pro map's come from the library it was listed from (FileEntry.library), so another
// library's map at the same path, size and time is too. Adding the library changed every pro map's key,
// which needs no version bump: no older key can match, and a sync deletes records no listed file names.
// The model left the facts key, and records gained their rating inputs (derive-file.ts Cached), without a
// DERIVE_VERSION bump: every older key holds the model after the version, so none is read as one of these.
export const factsKey = (e: FileEntry) => `${e.file}|${e.size}|${e.mtime}|v${DERIVE_VERSION}${e.pov ? `|pov${e.pov}` : ""}${e.library ? `|lib${e.library}` : ""}`;
export const entryKey = (factsKey: string, model: string, baselinesHash: string) => `${factsKey}|m${model}|e${ENTRY_VERSION}|b${baselinesHash}`;

/** Whether a match entry held in memory is still the one these keys name: same facts and same baselines. */
export const sameEntry = (held: { key: string; ekey: string } | undefined, key: string, ekey: string) => held?.key === key && held.ekey === ekey;
