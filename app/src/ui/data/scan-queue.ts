// One match-folder scan at a time, without losing a request made during one (review of #29: an import
// that ended mid-scan asked for a rescan, the busy scan dropped it, and the new matches stayed hidden).

/**
 * Wraps `scan` so that at most one runs at a time. A request made while a scan runs is kept, and one more
 * scan runs after the active one ends, however many requests came in meanwhile. The returned promise
 * settles when the scan it started, or the active one, has finished.
 */
export function scanQueue(scan: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let pending = false;
  const request = (): Promise<void> => {
    if (running) {
      pending = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          pending = false;
          await scan();
        } while (pending);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return request;
}
