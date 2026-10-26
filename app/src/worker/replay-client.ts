// UI-side handle on the replay worker. The worker starts on the first request; rounds are kept per
// file (at most KEEP), so stepping back and forth between rounds does not rebuild them. When the
// Replay tab closes, dispose() rejects what is pending, empties the cache and terminates the worker,
// releasing the decoded match; the next request starts a new one.
import type { Host } from "../host/host";
import type { RoundTimeline } from "../stats/replay";
import type { ReplayFromWorker, ReplayToWorker } from "./replay-protocol";

/** Rounds kept: the open one, its neighbours (prefetched) and a few just left. */
const KEEP = 8;

export interface ReplayClient {
  round(file: string, round: number): Promise<RoundTimeline>;
  dispose(): void;
}

/** The worker's surface the client uses, so tests can stand in for it. */
export type WorkerLike = Pick<Worker, "postMessage" | "terminate"> & {
  onmessage: ((ev: MessageEvent<ReplayFromWorker>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
};

const startWorker = (): WorkerLike => new Worker(new URL("./replay.worker.ts", import.meta.url), { type: "module" });

const clients = new WeakMap<Host, ReplayClient>();

/** The host's client; one per host, its worker started and stopped as the tab opens and closes. */
export function replayClient(host: Host): ReplayClient {
  let c = clients.get(host);
  if (!c) clients.set(host, (c = createReplayClient(host)));
  return c;
}

export function createReplayClient(host: Pick<Host, "read">, start: () => WorkerLike = startWorker): ReplayClient {
  let worker: WorkerLike | null = null;
  let id = 0;
  const calls = new Map<number, { resolve: (t: RoundTimeline) => void; reject: (e: Error) => void }>();
  const cache = new Map<string, Promise<RoundTimeline>>();
  const stop = (why: string) => {
    const e = new Error(why);
    for (const c of calls.values()) c.reject(e);
    calls.clear();
    cache.clear();
    worker?.terminate();
    worker = null;
  };
  const begin = (): WorkerLike => {
    const w = start();
    w.onerror = (e) => stop(`Replay worker stopped: ${e.message || "failed to load"}`);
    w.onmessageerror = () => stop("Replay worker stopped: a message could not be read");
    w.onmessage = async (ev) => {
      const m = ev.data;
      if ("need" in m) {
        try {
          const bytes = await host.read(m.need);
          // the worker may have been disposed while the host read
          if (worker === w) w.postMessage({ rid: m.rid, bytes } satisfies ReplayToWorker, [bytes]);
        } catch (e) {
          if (worker === w) w.postMessage({ rid: m.rid, error: (e as Error).message } satisfies ReplayToWorker);
        }
        return;
      }
      const c = calls.get(m.id);
      calls.delete(m.id);
      if (!c) return;
      if (m.error !== undefined || !m.result) c.reject(new Error(m.error ?? "no result"));
      else c.resolve(m.result);
    };
    return w;
  };
  return {
    round(file, round) {
      const k = `${file}|${round}`;
      const hit = cache.get(k);
      if (hit) { cache.delete(k); cache.set(k, hit); return hit; }
      const w = (worker ??= begin());
      const p = new Promise<RoundTimeline>((resolve, reject) => {
        const n = ++id;
        calls.set(n, { resolve, reject });
        w.postMessage({ id: n, file, round } satisfies ReplayToWorker);
      });
      p.catch(() => { if (cache.get(k) === p) cache.delete(k); });
      cache.set(k, p);
      while (cache.size > KEEP) cache.delete(cache.keys().next().value!);
      return p;
    },
    dispose() {
      stop("The replay closed");
    },
  };
}
