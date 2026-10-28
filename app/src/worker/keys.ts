// The worker's IndexedDB keys. Facts depend on the file, DERIVE_VERSION and the model (rating
// parameters and win-probability source, by content: model-params.ts modelFingerprint); match entries
// also on the pro baselines they were shown against (by content). A change to any of them makes a new
// key, so stale facts are re-derived instead of read.
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
export const factsKey = (e: FileEntry, model: string) => `${e.file}|${e.size}|${e.mtime}|v${DERIVE_VERSION}|${model}${e.pov ? `|pov${e.pov}` : ""}${e.library ? `|lib${e.library}` : ""}`;
export const entryKey = (factsKey: string, baselinesHash: string) => `${factsKey}|e${ENTRY_VERSION}|b${baselinesHash}`;

/** Whether a match entry held in memory is still the one these keys name: same facts and same baselines. */
export const sameEntry = (held: { key: string; ekey: string } | undefined, key: string, ekey: string) => held?.key === key && held.ekey === ekey;
