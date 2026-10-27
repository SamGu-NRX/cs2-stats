/// <reference lib="webworker" />
// A helper of the stats worker during a scan with many underived files: it derives the files it is
// sent, one at a time, with the same code the stats worker uses (derive-file.ts), and asks the stats
// worker for their bytes. See derive-pool.ts.
import { winProbSource, type WinProbSource } from "../stats/model-params";
import { deriveFile } from "./derive-file";
import type { FromDeriver, ToDeriver } from "./derive-pool";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromDeriver) => self.postMessage(m);

let wp: WinProbSource | null = null;
let rid = 0;
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
const bytes = (file: string) => new Promise<ArrayBuffer>((resolve, reject) => {
  const id = ++rid;
  pending.set(id, { resolve, reject });
  post({ rid: id, need: file });
});

self.onmessage = async (ev: MessageEvent<ToDeriver>) => {
  const m = ev.data;
  if ("init" in m) {
    // the stats worker's meta() reads the same pack the same way, so both derive with one model
    wp = winProbSource(m.init === null ? null : JSON.parse(new TextDecoder().decode(m.init)));
    return;
  }
  if ("rid" in m) {
    const p = pending.get(m.rid);
    pending.delete(m.rid);
    if (m.bytes) p?.resolve(m.bytes);
    else p?.reject(new Error(m.error ?? "read failed"));
    return;
  }
  try {
    if (!wp) throw new Error("a derive worker was sent a file before its win-probability source");
    post({ job: m.job, result: await deriveFile(m.file, bytes, m.pov, wp) });
  } catch (e) {
    post({ job: m.job, error: (e as Error).message });
  }
};
