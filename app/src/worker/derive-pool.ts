// Derive workers for a scan that finds many underived files: a first scan, or the first scan after
// DERIVE_VERSION or the model changed, which re-derives every match. Reading and deriving are
// CPU-bound: one thread took 24 minutes for 1,091 pro maps, 1.3 s each. The stats worker hands the
// files to these workers instead and keeps answering the UI; each derives one file at a time with the
// same code (derive-file.ts) and asks the stats worker for the bytes, which it relays from the UI
// thread.
import type { Bytes, Cached } from "./derive-file";

export type ToDeriver =
  | { init: ArrayBuffer | null }
  | { job: number; file: string; pov?: string }
  | { rid: number; bytes?: ArrayBuffer; error?: string };

export type FromDeriver =
  | { job: number; result?: Cached; error?: string }
  | { rid: number; need: string };

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

/** `size` workers deriving with the win-probability pack's bytes (null: the CS2RB model), reading through `bytes`. */
export function derivePool(size: number, winprobPack: ArrayBuffer | null, bytes: Bytes): DerivePool {
  interface Job { id: number; file: string; pov?: string; resolve: (c: Cached) => void; reject: (e: Error) => void }
  interface Slot { w: Worker; job: Job | null; dead: boolean }
  const queue: Job[] = [];
  let id = 0;

  const pump = () => {
    for (const s of slots) {
      if (s.dead || s.job || !queue.length) continue;
      const j = queue.shift()!;
      s.job = j;
      s.w.postMessage({ job: j.id, file: j.file, pov: j.pov } satisfies ToDeriver);
    }
    if (slots.every((s) => s.dead)) for (const j of queue.splice(0)) j.reject(new Error("every derive worker stopped"));
  };

  const slots: Slot[] = Array.from({ length: size }, () => {
    const w = new Worker(new URL("./derive.worker.ts", import.meta.url), { type: "module" });
    const s: Slot = { w, job: null, dead: false };
    // a copy: each worker parses its own
    w.postMessage({ init: winprobPack ? winprobPack.slice(0) : null } satisfies ToDeriver);
    w.onmessage = async (ev: MessageEvent<FromDeriver>) => {
      const m = ev.data;
      if ("need" in m) {
        try {
          const b = await bytes(m.need);
          w.postMessage({ rid: m.rid, bytes: b } satisfies ToDeriver, [b]);
        } catch (e) {
          w.postMessage({ rid: m.rid, error: (e as Error).message } satisfies ToDeriver);
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
    // a worker that fails to load or crashes fails its file and takes no more; the others carry on
    w.onerror = (e) => {
      e.preventDefault();
      s.dead = true;
      s.job?.reject(new Error(`a derive worker stopped: ${e.message || "failed to load"}`));
      s.job = null;
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
      for (const s of slots) s.w.terminate();
      for (const j of queue.splice(0)) j.reject(new Error("the derive pool was closed"));
    },
  };
}
