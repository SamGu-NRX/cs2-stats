// Derive workers for a scan that finds many underived files: a first scan, or the first scan after
// DERIVE_VERSION changed, which re-derives every match (a model change only rates the kept facts again,
// cached-facts.ts). Reading and deriving are
// CPU-bound: one thread took 24 minutes for 1,091 pro maps, 1.3 s each. The stats worker hands the
// files to these workers instead and keeps answering the UI; each derives one file at a time with the
// same code (derive-file.ts) and asks the stats worker for the bytes, which it relays from the UI
// thread. The page starts the workers and hands the stats worker a MessagePort to each (derive-spawn.ts):
// a worker the stats worker started itself could not load in the desktop app's WebView2.
import type { Bytes, Cached } from "./derive-file";

/** What the page sends a derive worker first: the port it talks to the stats worker through. */
export type FromPage = { port: MessagePort };

export type ToDeriver =
  | { init: ArrayBuffer | null }
  | { job: number; file: string; pov?: string }
  | { rid: number; bytes?: ArrayBuffer; error?: string };

export type FromDeriver =
  /** the worker's code loaded and it takes jobs */
  | { ready: true }
  | { job: number; result?: Cached; error?: string }
  | { rid: number; need: string };

/**
 * One derive worker as the pool reaches it: messages both ways (a MessagePort in the app), and word
 * from whoever started it when it fails to load or crashes.
 */
export interface Deriver {
  post(m: ToDeriver, transfer?: Transferable[]): void;
  onmessage: ((m: FromDeriver) => void) | null;
  onfail: ((why: string) => void) | null;
  close(): void;
}

export interface DerivePool {
  derive(file: string, pov: string | undefined): Promise<Cached>;
  /** Stops every worker; files still waiting are rejected. */
  close(): void;
}

/**
 * Workers for a machine with `cores` logical cores and `memoryGB` of memory (navigator.deviceMemory,
 * which Chromium rounds and caps at 8; null when the runtime does not say, read as 4). By cores: half
 * of them less one, so the UI, the game and the rest of the system keep the other half. By memory: one
 * per 2 GB, since a worker holds one match's tables and facts at a time and four of them peaked at
 * 1.1 GB of heap together over the 1,091-map library. At most 4. Under 2 there is no pool, and the
 * stats worker derives in its own thread.
 */
export const poolSize = (cores: number, memoryGB: number | null) =>
  Math.max(0, Math.min(4, Math.floor(cores / 2) - 1, Math.floor((memoryGB ?? 4) / 2)));

/** How the pool reaches its workers, and what it does with a file they cannot take. */
export interface PoolOptions {
  /** slot `i`'s worker as the stats worker reaches it: a port to a worker the page started (portDeriver) */
  deriver: (i: number) => Deriver;
  /**
   * Derives a file in this thread. A file comes here when the pool cannot take it: its worker never
   * started, or every worker stopped before reaching it. Nothing is wrong with the file. A worker that
   * loads in a browser could fail to load in the desktop app's WebView2, where every file then failed
   * and the scan showed no matches. These run one at a time, in the order the files came back.
   */
  here: (file: string) => Promise<Cached>;
  /** called for each file sent to `here` (Data & settings then says matches are read one at a time) */
  fellBack: () => void;
}

/** `size` workers deriving with the win-probability pack's bytes (null: the CS2RB model), reading through `bytes`. */
export function derivePool(size: number, winprobPack: ArrayBuffer | null, bytes: Bytes, o: PoolOptions): DerivePool {
  interface Job { id: number; file: string; pov?: string; resolve: (c: Cached) => void; reject: (e: Error) => void }
  interface Slot { d: Deriver; job: Job | null; dead: boolean; ready: boolean }
  const queue: Job[] = [];
  let id = 0;
  // files the workers cannot take, derived here one after another
  let lane: Promise<unknown> = Promise.resolve();
  const handBack = (j: Job) => {
    o.fellBack();
    const p = lane.then(() => o.here(j.file));
    lane = p.catch(() => {});
    p.then(j.resolve, j.reject);
  };

  const pump = () => {
    for (const s of slots) {
      if (s.dead || s.job || !queue.length) continue;
      const j = queue.shift()!;
      s.job = j;
      s.d.post({ job: j.id, file: j.file, pov: j.pov });
    }
    if (slots.every((s) => s.dead)) for (const j of queue.splice(0)) handBack(j);
  };

  const slots: Slot[] = Array.from({ length: size }, (_, i) => {
    const d = o.deriver(i);
    const s: Slot = { d, job: null, dead: false, ready: false };
    // a copy: each worker parses its own
    d.post({ init: winprobPack ? winprobPack.slice(0) : null });
    d.onmessage = async (m) => {
      if ("ready" in m) { s.ready = true; return; }
      if ("need" in m) {
        try {
          const b = await bytes(m.need);
          d.post({ rid: m.rid, bytes: b }, [b]);
        } catch (e) {
          d.post({ rid: m.rid, error: (e as Error).message });
        }
        return;
      }
      const j = s.job;
      s.job = null;
      if (j && j.id === m.job) {
        if (m.error !== undefined) j.reject(new Error(m.error));
        else j.resolve(m.result!);
      }
      pump();
    };
    // A worker that crashes fails its file and takes no more; the others carry on. One that never
    // loaded hands its file back, since nothing about the file stopped it.
    d.onfail = (why) => {
      if (s.dead) return;
      s.dead = true;
      const j = s.job;
      s.job = null;
      if (j) { if (s.ready) j.reject(new Error(`a derive worker stopped: ${why}`)); else handBack(j); }
      pump();
    };
    return s;
  });

  return {
    derive: (file, pov) => new Promise<Cached>((resolve, reject) => {
      queue.push({ id: ++id, file, pov, resolve, reject });
      pump();
    }),
    close() {
      for (const s of slots) s.d.close();
      for (const j of queue.splice(0)) j.reject(new Error("the derive pool was closed"));
    },
  };
}

/** A deriver reached through a MessagePort from the page (derive-spawn.ts); `fail` passes on the page's word that its worker failed. */
export function portDeriver(port: MessagePort): Deriver & { fail(why: string): void } {
  const d: Deriver & { fail(why: string): void } = {
    onmessage: null,
    onfail: null,
    post: (m, transfer = []) => port.postMessage(m, transfer),
    close: () => port.close(),
    fail: (why) => d.onfail?.(why),
  };
  port.onmessage = (ev: MessageEvent<FromDeriver>) => d.onmessage?.(ev.data);
  return d;
}
