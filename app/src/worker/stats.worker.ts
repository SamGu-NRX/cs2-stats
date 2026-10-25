/// <reference lib="webworker" />
// All decoding and stats run here, off the UI thread. Memory stays bounded: summaries without
// positions live in memory; full match views are kept for the last three matches opened; positions
// stay in IndexedDB until the profile heatmap asks for them.
import type { FileEntry } from "../host/host";
import { decodeMatch } from "../stats/decode";
import { DERIVE_VERSION, deriveMatch, summarize, type MatchSummary, type MatchView } from "../stats/derive";
import { emptyPos, mergePos, type PosAgg } from "../stats/positions";
import { buildProfile, type ProfileFilter } from "../stats/profile";
import { winProbabilityCT } from "@model/winprob";
import { modelFromModule, stubModel, type WinModel } from "../stats/winprob";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import { planSync } from "./plan";
import type { Api, FromWorker, LightSummary, Method, ToWorker } from "./protocol";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

// ---- win-probability model: the model agent's model/export/winprob.ts when it is complete at
// build time (see vite.config.ts and app/README.md); otherwise the placeholder stays.
let model: WinModel = stubModel;
let modelError: string | null = null;
try {
  if (winProbabilityCT !== undefined) model = modelFromModule(winProbabilityCT);
} catch (e) {
  modelError = (e as Error).message;
}
const modelReady = Promise.resolve();

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

const cacheKey = (e: FileEntry) => `${e.file}|${e.size}|${e.mtime}|v${DERIVE_VERSION}|${model.kind}`;
let summaries: LightSummary[] = [];
let keysByFile = new Map<string, string>();
const views = new Map<string, MatchView>(); // insertion order = LRU
const VIEW_CACHE = 3;

function remember(v: MatchView) {
  views.delete(v.file);
  views.set(v.file, v);
  while (views.size > VIEW_CACHE) views.delete(views.keys().next().value!);
}

async function deriveFile(file: string): Promise<MatchView> {
  const m = await decodeMatch(await bytes(file), file);
  const v = deriveMatch(m, file, model);
  remember(v);
  return v;
}

const api: { [K in Method]: (...a: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> } = {
  async sync(entries) {
    await modelReady;
    const next: LightSummary[] = [];
    const errors: { file: string; message: string }[] = [];
    // Compare against the previous sync's keys before replacing them: a changed file must not
    // keep its old summary or match view.
    const plan = planSync(entries.map((e) => ({ file: e.file, key: cacheKey(e) })), keysByFile);
    keysByFile = plan.keys;
    for (const f of plan.changed) views.delete(f);
    const inMemory = new Map(summaries.map((s) => [s.file, s]));
    let done = 0;
    for (const e of entries) {
      const key = cacheKey(e);
      let s: LightSummary | undefined = plan.reuse.has(e.file) ? inMemory.get(e.file) : undefined;
      if (!s) s = await idbGet<LightSummary>("summary", key);
      if (!s) {
        try {
          const full: MatchSummary = summarize(await deriveFile(e.file));
          const { pos, ...light } = full;
          await idbPut("summary", key, light);
          await idbPut("pos", key, pos);
          s = light;
        } catch (err) {
          errors.push({ file: e.file, message: (err as Error).message });
        }
      }
      if (s) next.push(s);
      done++;
      if (done % 5 === 0 || done === entries.length) post({ progress: { done, total: entries.length } });
    }
    summaries = next.sort((a, b) => b.startUtc.localeCompare(a.startUtc));
    // drop cache entries for files that are gone or changed
    const live = new Set(keysByFile.values());
    for (const store of ["summary", "pos"] as const) {
      const stale = (await idbKeys(store)).filter((k) => !live.has(k));
      await idbDelete(store, stale);
    }
    return { summaries, errors };
  },
  async match(file) {
    await modelReady;
    const v = views.get(file);
    if (v) {
      remember(v);
      return v;
    }
    return deriveFile(file);
  },
  async profile(filter: ProfileFilter) {
    return buildProfile(summaries, filter);
  },
  async profilePositions(map) {
    const out: PosAgg = emptyPos(map);
    for (const s of summaries) {
      if (s.map !== map) continue;
      const key = keysByFile.get(s.file);
      const p = key ? await idbGet<PosAgg>("pos", key) : undefined;
      if (p) mergePos(out, p);
    }
    return out;
  },
  async modelInfo() {
    await modelReady;
    return { kind: model.kind, label: model.label, error: modelError };
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
