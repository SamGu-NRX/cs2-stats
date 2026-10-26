// UI-side handle on the replay worker. One worker per host, started on the first request. Rounds are
// kept per file (at most KEEP), so stepping back and forth between rounds does not rebuild them.
import type { Host } from "../host/host";
import type { RoundTimeline } from "../stats/replay";
import type { ReplayFromWorker, ReplayToWorker } from "./replay-protocol";

/** Rounds kept: the open one, its neighbours (prefetched) and a few just left. */
const KEEP = 8;

export interface ReplayClient { round(file: string, round: number): Promise<RoundTimeline> }

const clients = new WeakMap<Host, ReplayClient>();

export function replayClient(host: Host): ReplayClient {
  let c = clients.get(host);
  if (!c) clients.set(host, (c = create(host)));
  return c;
}

function create(host: Host): ReplayClient {
  let worker: Worker | null = null;
  let id = 0;
  const calls = new Map<number, { resolve: (t: RoundTimeline) => void; reject: (e: Error) => void }>();
  const cache = new Map<string, Promise<RoundTimeline>>();
  const send = (m: ReplayToWorker, t: Transferable[] = []) => worker!.postMessage(m, t);
  const fail = (msg: string) => {
    const e = new Error(`Replay worker stopped: ${msg}`);
    for (const c of calls.values()) c.reject(e);
    calls.clear();
    cache.clear();
    worker?.terminate();
    worker = null;
  };
  const start = () => {
    worker = new Worker(new URL("./replay.worker.ts", import.meta.url), { type: "module" });
    worker.onerror = (e) => fail(e.message || "failed to load");
    worker.onmessageerror = () => fail("a message could not be read");
    worker.onmessage = async (ev: MessageEvent<ReplayFromWorker>) => {
      const m = ev.data;
      if ("need" in m) {
        try {
          const bytes = await host.read(m.need);
          send({ rid: m.rid, bytes }, [bytes]);
        } catch (e) {
          send({ rid: m.rid, error: (e as Error).message });
        }
        return;
      }
      const c = calls.get(m.id);
      calls.delete(m.id);
      if (!c) return;
      if (m.error !== undefined || !m.result) c.reject(new Error(m.error ?? "no result"));
      else c.resolve(m.result);
    };
  };
  return {
    round(file, round) {
      const k = `${file}|${round}`;
      const hit = cache.get(k);
      if (hit) { cache.delete(k); cache.set(k, hit); return hit; }
      if (!worker) start();
      const p = new Promise<RoundTimeline>((resolve, reject) => {
        const n = ++id;
        calls.set(n, { resolve, reject });
        send({ id: n, file, round });
      });
      p.catch(() => cache.delete(k));
      cache.set(k, p);
      while (cache.size > KEEP) cache.delete(cache.keys().next().value!);
      return p;
    },
  };
}
