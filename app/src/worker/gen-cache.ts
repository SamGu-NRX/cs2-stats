// Answers kept by question within one generation of the stats worker's match index (stats.worker.ts
// `gen`, raised whenever a sync changes any file's facts key). An answer still being worked out when the
// generation changes may have read facts of both indexes, so it is answered once and not kept.

export interface GenCache<T> {
  /** The kept answer to `question` in this generation, or `run`'s, kept if the generation holds until it settles. */
  get(question: string, run: () => Promise<T>): Promise<T>;
  clear(): void;
}

export function genCache<T>(size: number, gen: () => number): GenCache<T> {
  const kept = new Map<string, Promise<T>>();
  return {
    get(question, run) {
      const at = gen();
      const k = `${at}|${question}`;
      const hit = kept.get(k);
      // most recently asked last, so the oldest goes first when the cache is full
      if (hit) { kept.delete(k); kept.set(k, hit); return hit; }
      const p = run();
      kept.set(k, p);
      while (kept.size > size) kept.delete(kept.keys().next().value!);
      p.then(() => { if (gen() !== at && kept.get(k) === p) kept.delete(k); }, () => { if (kept.get(k) === p) kept.delete(k); });
      return p;
    },
    clear() { kept.clear(); },
  };
}
