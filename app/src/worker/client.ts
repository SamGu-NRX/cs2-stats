// UI-side handle on the stats worker. Requests are promises; the worker asks back for file bytes,
// which this side reads through the host and transfers without copying.
import type { Host } from "../host/host";
import type { Api, FromWorker, Method, ToWorker } from "./protocol";

export type Client = { [K in Method]: (...a: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> } & {
  onProgress(fn: (p: { done: number; total: number }) => void): void;
};

export function createClient(host: Host): Client {
  const worker = new Worker(new URL("./stats.worker.ts", import.meta.url), { type: "module" });
  let id = 0;
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let progress: (p: { done: number; total: number }) => void = () => {};
  const send = (m: ToWorker, t: Transferable[] = []) => worker.postMessage(m, t);
  // A worker that fails to load or crashes must surface, not leave every request pending.
  let dead: Error | null = null;
  const fail = (msg: string) => {
    dead = new Error(`Stats worker stopped: ${msg}`);
    for (const c of calls.values()) c.reject(dead);
    calls.clear();
  };
  worker.onerror = (e) => fail(e.message || "failed to load");
  worker.onmessageerror = () => fail("a message could not be read");

  worker.onmessage = async (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    if ("progress" in m) return progress(m.progress);
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
    if (m.error !== undefined) c.reject(new Error(m.error));
    else c.resolve(m.result);
  };

  const call = (method: Method) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const n = ++id;
      calls.set(n, { resolve, reject });
      send({ id: n, method, args });
    });

  return {
    sync: call("sync"), facts: call("facts"), rollup: call("rollup"), ratings: call("ratings"), guns: call("guns"),
    positions: call("positions"), onProgress: (fn) => (progress = fn),
  } as Client;
}
