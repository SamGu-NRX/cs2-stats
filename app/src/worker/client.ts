// UI-side handle on the stats worker. Requests are promises; the worker asks back for file bytes,
// which this side reads through the host and transfers without copying.
//
// Calls made in the same task (the effects of one render) go out as one message, so the worker can
// answer every career question of a page from a single pass over the stored matches.
import type { Host } from "../host/host";
import type { Api, Call, FromWorker, Method, Result, ToWorker } from "./protocol";
import { spawnDerivers } from "./derive-spawn";

export type Client = { [K in Method]: (...a: Parameters<Api[K]>) => Promise<Result<K>> } & {
  onProgress(fn: (p: { done: number; total: number }) => void): void;
};

/** Every Api method once; the Record type fails to compile when the Api gains or loses one. */
const METHODS = Object.keys({
  meta: 1, baselines: 1, sync: 1, match: 1, rounds: 1, places: 1, rollup: 1, presence: 1, ratings: 1, guns: 1, positions: 1, compare: 1, attributes: 1, style: 1, attributeBlock: 1, buySplits: 1, buyTiers: 1, careerRatings: 1, topStats: 1, focusAreas: 1, periodCompare: 1, personalBests: 1, sessions: 1, opponents: 1, winCorrelation: 1, matchValues: 1, rolesBySpawn: 1, clutches: 1, roles: 1, rolesByMap: 1, multiKills: 1, highlights: 1, moments: 1, flashes: 1, ratingBreakdown: 1, headToHead: 1, mapZones: 1, yourMatch: 1, openingDuels: 1, situations: 1, bombsites: 1, playsLike: 1, compass: 1, trends: 1,
} satisfies Record<Method, 1>) as Method[];

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

  // derive workers the stats worker asked for, by request (derive-spawn.ts)
  const derivers = new Map<number, { stop(): void }>();
  worker.onmessage = async (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    if ("progress" in m) return progress(m.progress);
    if ("spawn" in m) {
      const team = spawnDerivers(m.n, () => new Worker(new URL("./derive.worker.ts", import.meta.url), { type: "module" }), (i, why) => send({ deriverFailed: m.spawn, i, why }));
      derivers.set(m.spawn, team);
      send({ spawned: m.spawn, ports: team.ports }, team.ports);
      return;
    }
    if ("despawn" in m) {
      derivers.get(m.despawn)?.stop();
      derivers.delete(m.despawn);
      return;
    }
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

  let batch: Call[] = [];
  const flush = () => {
    const b = batch;
    batch = [];
    if (b.length) send({ batch: b });
  };
  const call = (method: Method) => (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const n = ++id;
      calls.set(n, { resolve, reject });
      batch.push({ id: n, method, args });
      if (batch.length === 1) queueMicrotask(flush);
    });

  const client = Object.fromEntries(METHODS.map((m) => [m, call(m)])) as unknown as Client;
  client.onProgress = (fn) => { progress = fn; };
  return client;
}
