/// <reference lib="webworker" />
// All decoding and deriving runs here, off the UI thread: a plugin file is decoded, turned into
// tables (plugin/adapter.ts) and derived into MatchFacts, which IndexedDB caches by DERIVE_VERSION.
// Facts for every listed match stay in memory, because every profile question is a rollup over them.
import type { FileEntry } from "../host/host";
import { DERIVE_VERSION, type MatchFacts } from "../stats/facts";
import { derive } from "../stats/derive";
import { gunProficiency } from "../stats/guns";
import { decodeMatch } from "../stats/plugin/decode";
import { pluginToTables } from "../stats/plugin/adapter";
import { rating3BySide } from "../stats/rating3";
import { rollup } from "../stats/rollup";
import { byNewest, entryOf, type MatchEntry } from "../ui/data/match";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import { planSync } from "./plan";
import type { Api, FromWorker, Method, Query, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

// ---- bytes come from the UI thread, which owns the Tauri bridge
let rid = 0;
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>();
function bytes(file: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const id = ++rid;
    pending.set(id, { resolve, reject });
    post({ rid: id, need: file });
  });
}

/** What IndexedDB keeps per file: the facts and the plugin's own label for the file. */
interface Cached { facts: MatchFacts; origin: string }

const cacheKey = (e: FileEntry) => `${e.file}|${e.size}|${e.mtime}|v${DERIVE_VERSION}`;
let loaded = new Map<string, Cached & { entry: MatchEntry }>();
let keysByFile = new Map<string, string>();

async function deriveFile(file: string): Promise<Cached> {
  const m = await decodeMatch(await bytes(file), file);
  return { facts: derive(pluginToTables(m)), origin: m.env.plugin ?? "" };
}

const factsOf = (files: string[]) => files.map((f) => {
  const x = loaded.get(f);
  if (!x) throw new Error(`${f} is not loaded; rescan the match folder`);
  return x.facts;
});

const api: { [K in Method]: (...a: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> } = {
  async sync(entries) {
    const errors: { file: string; message: string }[] = [];
    // Compare against the previous sync's keys before replacing them: a changed file must not keep
    // its old facts.
    const plan = planSync(entries.map((e) => ({ file: e.file, key: cacheKey(e) })), keysByFile);
    keysByFile = plan.keys;
    const next = new Map<string, Cached & { entry: MatchEntry }>();
    let done = 0;
    for (const e of entries) {
      const key = cacheKey(e);
      let c: (Cached & { entry?: MatchEntry }) | undefined = plan.reuse.has(e.file) ? loaded.get(e.file) : undefined;
      try {
        if (!c) c = await idbGet<Cached>("facts", key);
        if (!c) {
          c = await deriveFile(e.file);
          await idbPut("facts", key, c);
        }
        next.set(e.file, { ...c, entry: c.entry ?? entryOf(e.file, c.origin, c.facts) });
      } catch (err) {
        errors.push({ file: e.file, message: (err as Error).message });
      }
      done++;
      if (done % 5 === 0 || done === entries.length) post({ progress: { done, total: entries.length } });
    }
    loaded = next;
    // drop cache entries for files that are gone or changed, and those of older derive versions
    const live = new Set(keysByFile.values());
    await idbDelete("facts", (await idbKeys("facts")).filter((k) => !live.has(k)));
    return { matches: [...loaded.values()].map((x) => x.entry).sort(byNewest), errors };
  },
  async facts(file) {
    return factsOf([file])[0];
  },
  async rollup(qs) {
    return qs.map((q) => rollup(factsOf(q.files), q.filter));
  },
  async ratings(qs) {
    return qs.map((q) => rating3BySide(factsOf(q.files), q.filter));
  },
  async guns(q) {
    const fs = factsOf(q.files);
    return gunProficiency(rollup(fs, q.filter), fs.map((f) => rollup([f], q.filter).weapons));
  },
  async positions(q: Query) {
    const ids = new Set(Array.isArray(q.filter.player) ? q.filter.player : [q.filter.player]);
    const kills: [number, number][] = [];
    const deaths: [number, number][] = [];
    for (const f of factsOf(q.files)) {
      if (q.filter.maps && !q.filter.maps.includes(f.match.map)) continue;
      for (const k of f.kills) {
        if (k.enemy && k.killer !== null && k.kpos && ids.has(f.players[k.killer].id)) kills.push(k.kpos);
        if (k.vpos && ids.has(f.players[k.victim].id)) deaths.push(k.vpos);
      }
    }
    return { kills, deaths };
  },
};

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if ("rid" in msg) {
    const p = pending.get(msg.rid);
    pending.delete(msg.rid);
    if (!p) return;
    if (msg.bytes) p.resolve(msg.bytes);
    else p.reject(new Error(msg.error ?? "read failed"));
    return;
  }
  try {
    const fn = api[msg.method] as (...a: unknown[]) => Promise<unknown>;
    post({ id: msg.id, result: await fn(...msg.args) });
  } catch (e) {
    post({ id: msg.id, error: (e as Error).message });
  }
};
