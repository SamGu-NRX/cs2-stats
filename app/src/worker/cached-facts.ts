// The facts the stats worker reads for a file (stats.worker.ts cached). The IndexedDB record under the
// file's facts key (keys.ts) is used as it is when it was rated with the model in use. A record rated
// with another model is rated again from its own facts and rating inputs (rate.ts), and a file with no
// record is derived. Either result replaces the record, so a refitted model or another win-probability
// source costs one rating per match, not a read and a derive of every file.
import type { MatchFacts } from "../stats/facts";
import type { Cached } from "./derive-file";

export interface FactsSource {
  /** model-params.ts modelFingerprint of the model in use */
  model: string;
  get(key: string): Promise<Cached | undefined>;
  put(key: string, c: Cached): Promise<void>;
  /** the record's facts rated with the model in use (rate.ts rate) */
  rate(c: Cached): MatchFacts;
  /** the file derived and rated with the model in use */
  derive(): Promise<Cached>;
}

export async function cachedFacts(key: string, s: FactsSource): Promise<Cached> {
  const c = await s.get(key);
  if (c && c.facts.match.model === s.model) return c;
  const next = c ? { ...c, facts: s.rate(c) } : await s.derive();
  await s.put(key, next);
  return next;
}
