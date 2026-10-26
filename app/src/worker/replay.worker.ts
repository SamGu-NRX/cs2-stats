/// <reference lib="webworker" />
// The 2D replay's worker: decodes one extracted match's positions and grenade tables and builds a
// round's timeline (stats/replay.ts) on request. It is separate from the stats worker so a replay's
// decoding (positions are most of a match's bytes) never queues behind career questions, and so the
// stats worker's protocol stays unchanged. File bytes come from the UI thread, which owns the host.
import { loadReplayTables, type ReplayTables } from "../stats/replay-load";
import { buildRoundTimeline } from "../stats/replay";
import type { ReplayFromWorker, ReplayToWorker } from "./replay-protocol";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: ReplayFromWorker) => self.postMessage(m);

let rid = 0;
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
function bytes(file: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const id = ++rid;
    pending.set(id, { resolve, reject });
    post({ rid: id, need: file });
  });
}

/** One match's tables at a time: the one the replay has open. */
let open: { file: string; tables: Promise<ReplayTables> } | null = null;
function tablesOf(file: string): Promise<ReplayTables> {
  if (open?.file === file) return open.tables;
  // reading the folder's path lists its table files (host.ts)
  const tables = bytes(file).then(async (b) => {
    const names = new Set(JSON.parse(new TextDecoder().decode(b)) as string[]);
    return loadReplayTables((name) => (names.has(name) ? bytes(`${file}/${name}`) : Promise.resolve(null)));
  });
  open = { file, tables };
  tables.catch(() => { if (open?.tables === tables) open = null; });
  return tables;
}

self.onmessage = async (ev: MessageEvent<ReplayToWorker>) => {
  const m = ev.data;
  if ("rid" in m) {
    const p = pending.get(m.rid);
    pending.delete(m.rid);
    if (!p) return;
    if (m.bytes) p.resolve(m.bytes);
    else p.reject(new Error(m.error ?? "read failed"));
    return;
  }
  try {
    const { tables, paths } = await tablesOf(m.file);
    post({ id: m.id, result: buildRoundTimeline(tables, paths, m.round) });
  } catch (e) {
    post({ id: m.id, error: (e as Error).message });
  }
};
