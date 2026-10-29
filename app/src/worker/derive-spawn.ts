// The page starts the derive workers (derive-pool.ts) and hands the stats worker a MessagePort to each,
// so no worker starts another. Started by the stats worker, they could not load in the desktop app's
// WebView2, and every file of a first scan failed; started by the page, they load as the stats worker does.
import type { FromPage } from "./derive-pool";

/**
 * Starts `n` derive workers with `start` and returns the stats worker's end of a port to each, in order.
 * A worker that fails to load or crashes, or cannot be started at all, is reported to `onFail` by its
 * index; `stop` ends them all.
 */
export function spawnDerivers(n: number, start: () => Worker, onFail: (i: number, why: string) => void): { ports: MessagePort[]; stop(): void } {
  const workers: Worker[] = [];
  const ports: MessagePort[] = [];
  for (let i = 0; i < n; i++) {
    const ch = new MessageChannel();
    ports.push(ch.port2);
    let w: Worker;
    try {
      w = start();
    } catch (e) {
      // reported after the ports reach the stats worker, which only then knows this index
      setTimeout(() => onFail(i, (e as Error).message || "could not be started"), 0);
      continue;
    }
    w.onerror = (e) => { e.preventDefault(); onFail(i, e.message || "failed to load"); };
    w.postMessage({ port: ch.port1 } satisfies FromPage, [ch.port1]);
    workers.push(w);
  }
  return { ports, stop: () => { for (const w of workers) w.terminate(); } };
}
