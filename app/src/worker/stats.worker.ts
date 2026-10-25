/// <reference lib="webworker" />
// All decoding, deriving and rolling up runs here, off the UI thread. A plugin file is decoded,
// turned into tables (plugin/adapter.ts) and derived into MatchFacts, which IndexedDB caches by file,
// size, mtime and DERIVE_VERSION next to the file's MatchEntry.
//
// Memory holds the match index (one MatchEntry per file) and the full facts of at most LRU_FACTS
// matches, the ones the match views have open. A career question streams facts from IndexedDB one
// match at a time: the calls the UI sends together (worker/client.ts batches them) share one pass
// over the files, and each sums its own matches with addMatch as the pass goes by.
import type { FileEntry } from "../host/host";
import { trend } from "../stats/trends";
import type { Baselines, SideKey } from "../stats/compare";
import { derive } from "../stats/derive";
import { DERIVE_VERSION, type MatchFacts } from "../stats/facts";
import { gunProficiency } from "../stats/guns";
import { roleBlend } from "../stats/identity";
import { loadTables } from "../stats/load";
import { decodeMatch } from "../stats/plugin/decode";
import { pluginToTables } from "../stats/plugin/adapter";
import { roundPlaces } from "../stats/positions";
import { addMatch, emptySummary, rollup, type Summary } from "../stats/rollup";
import type { MatchTables } from "../stats/tables";
import { byNewest, type MatchEntry } from "../ui/data/match";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import type { Api, Call, FromWorker, Method, PositionsResult, Query, ToWorker } from "./protocol";
import { addCareerMatch, botPopulation, careerScope, rankingCalls, sideQuery, type BotPopulation } from "./ranking";
import { addPositions, entryOf, matchBundle, metaOf, ratedMatches, ratingsOf, rolled, roundBundle } from "./views";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

/** Full facts kept in memory: the open match, the last match on Home, and a couple more. */
const LRU_FACTS = 4;
/** Summaries kept for repeated questions (the same card re-rendering, two cards asking the same thing). */
const SUMMARY_CACHE = 48;
/** Bot career baselines kept, one per set of matches the pages ask about (Profile's and Playstyle's filters). */
const CAREER_CACHE = 6;
/** Bump when MatchEntry's shape or what entryOf computes into it changes, so cached entries are rebuilt. */
const ENTRY_VERSION = 1;

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

// ---- the pro baselines, loaded once
let baselinesP: Promise<Baselines> | null = null;
function baselines(): Promise<Baselines> {
  baselinesP ??= (async () => {
    const res = await fetch(new URL(`${import.meta.env.BASE_URL}baselines.json`, self.location.href));
    if (!res.ok) throw new Error(`baselines.json failed to load (HTTP ${res.status})`);
    const b = (await res.json()) as Baselines;
    if (b.version !== 1) throw new Error(`baselines.json: version is ${JSON.stringify(b.version)}, this app reads version 1`);
    return b;
  })();
  // a failed load is tried again on the next question
  baselinesP.catch(() => { baselinesP = null; });
  return baselinesP;
}

// ---- the index, the facts cache and the passes

/** What IndexedDB keeps per file: the facts and the plugin's own label for the file. */
interface Cached { facts: MatchFacts; origin: string }

const factsKey = (e: FileEntry) => `${e.file}|${e.size}|${e.mtime}|v${DERIVE_VERSION}`;
const entryKey = (factsKey: string) => `${factsKey}|e${ENTRY_VERSION}`;

let index = new Map<string, { key: string; entry: MatchEntry }>();
/** Increments when the index changes, so cached summaries of the old file set are not reused. */
let gen = 0;
const lru = new Map<string, { key: string; facts: MatchFacts }>();

/** An extracted match folder (host.ts "dev/<folder>/"), read table by table; else a plugin file. */
const isFolder = (file: string) => file.endsWith("/");

async function folderTables(file: string): Promise<MatchTables> {
  const names = new Set(JSON.parse(new TextDecoder().decode(await bytes(file))) as string[]);
  return loadTables((name) => (names.has(name) ? bytes(file + name) : Promise.resolve(null)));
}

async function deriveFile(file: string): Promise<Cached> {
  if (isFolder(file)) {
    const t = await folderTables(file);
    return { facts: derive(t), origin: `extracted, ${t.match.extractor_version[0]}` };
  }
  const m = await decodeMatch(await bytes(file), file);
  return { facts: derive(pluginToTables(m)), origin: m.env.plugin ?? "" };
}

/**
 * The open match's tables, for what facts do not keep (one round's places). Decoded again on demand;
 * only one match's tables are held, and they are dropped when another match opens.
 */
let openTables: { file: string; key: string; tables: MatchTables } | null = null;
async function tablesOf(file: string): Promise<MatchTables> {
  const ix = index.get(file);
  if (!ix) throw new Error(`${file} is not in the match folder; rescan it`);
  if (openTables?.file === file && openTables.key === ix.key) return openTables.tables;
  openTables = null;
  const tables = isFolder(file) ? await folderTables(file) : pluginToTables(await decodeMatch(await bytes(file), file));
  openTables = { file, key: ix.key, tables };
  return tables;
}

async function cached(file: string, key: string): Promise<Cached> {
  const c = await idbGet<Cached>("facts", key);
  if (c) return c;
  const d = await deriveFile(file);
  await idbPut("facts", key, d);
  return d;
}

/** One file's facts. `keep` puts them in the in-memory cache (the match views); a pass does not. */
async function factsOf(file: string, keep: boolean): Promise<MatchFacts> {
  const ix = index.get(file);
  if (!ix) throw new Error(`${file} is not in the match folder; rescan it`);
  const hit = lru.get(file);
  if (hit && hit.key === ix.key) {
    if (keep) { lru.delete(file); lru.set(file, hit); }
    return hit.facts;
  }
  const { facts } = await cached(file, ix.key);
  if (keep) {
    lru.set(file, { key: ix.key, facts });
    while (lru.size > LRU_FACTS) lru.delete(lru.keys().next().value!);
  }
  return facts;
}

interface Job { files: Set<string>; visit: (f: MatchFacts) => void; resolve: () => void; reject: (e: Error) => void; error?: Error }
let waiting: Job[] = [];
let scheduled = false;

/**
 * Visits each of `files` once, in index order. Calls made before the pass starts join it, so a page's
 * questions read every match from IndexedDB once between them.
 */
function stream(files: string[], visit: (f: MatchFacts) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    waiting.push({ files: new Set(files), visit, resolve, reject });
    if (!scheduled) { scheduled = true; setTimeout(() => void pass(), 0); }
  });
}

async function pass() {
  scheduled = false;
  const jobs = waiting;
  waiting = [];
  const wanted = new Set(jobs.flatMap((j) => [...j.files]));
  // files no longer in the index still get visited, so their jobs fail with factsOf's message
  const order = [...index.keys()].filter((f) => wanted.has(f));
  for (const f of wanted) if (!index.has(f)) order.push(f);
  for (const file of order) {
    const live = jobs.filter((j) => !j.error && j.files.has(file));
    if (!live.length) continue;
    try {
      const f = await factsOf(file, false);
      for (const j of live) {
        try { j.visit(f); } catch (e) { j.error = e as Error; }
      }
    } catch (e) {
      for (const j of live) j.error = e as Error;
    }
  }
  for (const j of jobs) {
    if (j.error) j.reject(j.error);
    else j.resolve();
  }
}

const summaries = new Map<string, Promise<Summary>>();

function summaryOf(q: Query): Promise<Summary> {
  const k = `${gen}|${JSON.stringify(q)}`;
  const hit = summaries.get(k);
  if (hit) { summaries.delete(k); summaries.set(k, hit); return hit; }
  const s = emptySummary();
  const p = stream(q.files, (f) => addMatch(s, f, q.filter)).then(() => s);
  p.catch(() => summaries.delete(k));
  summaries.set(k, p);
  while (summaries.size > SUMMARY_CACHE) summaries.delete(summaries.keys().next().value!);
  return p;
}

const careerSets = new Map<string, Promise<BotPopulation>>();

/**
 * The bot careers in a query's matches, as the user's style population (ranking.ts). One pass sums
 * every bot of every match on both sides and on each; the result is kept per file set and scope.
 */
function careersOf(q: Query): Promise<BotPopulation> {
  const scope = careerScope(q.filter);
  const k = `${gen}|${JSON.stringify([q.files, scope])}`;
  const hit = careerSets.get(k);
  if (hit) { careerSets.delete(k); careerSets.set(k, hit); return hit; }
  const careers = new Map<string, Record<SideKey, Summary>>();
  const matches: Record<SideKey, Summary>[] = [];
  const p = stream(q.files, (f) => addCareerMatch(careers, matches, f, scope))
    .then(() => botPopulation([...careers.values()], matches, new Date().toISOString().slice(0, 10)));
  p.catch(() => careerSets.delete(k));
  careerSets.set(k, p);
  while (careerSets.size > CAREER_CACHE) careerSets.delete(careerSets.keys().next().value!);
  return p;
}

const ranking = rankingCalls({ summary: summaryOf, pros: baselines, careers: careersOf });

/** The matches a query keeps by its map and date filters, for the coverage rule. */
function keptMatches(q: Query) {
  const { maps, from, to } = q.filter;
  return q.files.map((f) => index.get(f)?.entry.match).filter((m): m is MatchEntry["match"] => !!m
    && (!maps || maps.includes(m.map)) && (!from || (!!m.date && m.date >= from)) && (!to || (!!m.date && m.date <= to)));
}

function entryOfFile(file: string): MatchEntry {
  const e = index.get(file)?.entry;
  if (!e) throw new Error(`${file} is not in the match folder; rescan it`);
  return e;
}

type Impl = { [K in Method]: (...a: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> };

const api: Impl = {
  async meta() {
    return metaOf();
  },
  async baselines() {
    const b = await baselines();
    return { source: b.source, built: b.built, n: b.n };
  },
  async sync(entries) {
    const errors: { file: string; message: string }[] = [];
    const next = new Map<string, { key: string; entry: MatchEntry }>();
    let done = 0;
    for (const e of entries) {
      const key = factsKey(e);
      try {
        const prev = index.get(e.file);
        let entry = prev?.key === key ? prev.entry : await idbGet<MatchEntry>("entries", entryKey(key));
        if (!entry) {
          const c = await cached(e.file, key);
          entry = entryOf(e.file, c.origin, c.facts);
          await idbPut("entries", entryKey(key), entry);
        }
        next.set(e.file, { key, entry });
      } catch (err) {
        errors.push({ file: e.file, message: (err as Error).message });
      }
      done++;
      if (done % 5 === 0 || done === entries.length) post({ progress: { done, total: entries.length } });
    }
    if (next.size !== index.size || [...next].some(([f, x]) => index.get(f)?.key !== x.key)) {
      gen++;
      summaries.clear();
      careerSets.clear();
    }
    index = next;
    for (const [f, x] of [...lru]) if (index.get(f)?.key !== x.key) lru.delete(f);
    // drop cached facts and entries no listed file needs: gone, changed, or of an older version
    const live = new Set([...index.values()].map((x) => x.key));
    await idbDelete("facts", (await idbKeys("facts")).filter((k) => !live.has(k)));
    const liveEntries = new Set([...live].map(entryKey));
    await idbDelete("entries", (await idbKeys("entries")).filter((k) => !liveEntries.has(k)));
    return { matches: [...index.values()].map((x) => x.entry).sort(byNewest), errors };
  },
  async match(file) {
    if (openTables && openTables.file !== file) openTables = null;
    return matchBundle(entryOfFile(file), await factsOf(file, true));
  },
  async rounds(file) {
    const f = await factsOf(file, true);
    return f.rounds.map((r) => roundBundle(f, r.number));
  },
  async places(file) {
    const e = entryOfFile(file);
    const [f, t] = await Promise.all([factsOf(file, true), tablesOf(file)]);
    return Object.fromEntries(f.rounds.map((r) => [r.number, roundPlaces(t, r.number, e.players[e.you].id)]));
  },
  async rollup(qs) {
    return Promise.all(qs.map(async (q) => rolled(await summaryOf(q))));
  },
  async ratings(qs) {
    return Promise.all(qs.map(async (q) => {
      const [both, T, CT] = await Promise.all([summaryOf(sideQuery(q, "both")), summaryOf(sideQuery(q, "T")), summaryOf(sideQuery(q, "CT"))]);
      return ratingsOf({ both, T, CT }, ratedMatches(keptMatches(q)));
    }));
  },
  async guns(q) {
    const all = emptySummary();
    const perMatch: Summary["weapons"][] = [];
    await stream(q.files, (f) => {
      addMatch(all, f, q.filter);
      const one = rollup([f], q.filter);
      if (one.matches) perMatch.push(one.weapons);
    });
    return gunProficiency(all, perMatch);
  },
  async positions(q) {
    const out: PositionsResult = { kills: [], deaths: [], presence: null };
    const [s] = await Promise.all([summaryOf(q), stream(q.files, (f) => addPositions(out, f, q.filter))]);
    const map = q.filter.maps?.length === 1 ? q.filter.maps[0] : null;
    out.presence = map ? s.presence[map] ?? null : null;
    return out;
  },
  compare: ranking.compare,
  attributes: ranking.attributes,
  style: ranking.style,
  async roles(q) {
    const [t, ct] = await Promise.all([summaryOf(sideQuery(q, "T")), summaryOf(sideQuery(q, "CT"))]);
    return { T: roleBlend(t, "T"), CT: roleBlend(ct, "CT") };
  },
  playsLike: ranking.playsLike,
  async trends(series) {
    return series.map((values) => trend(values.map((value, i) => ({ match: String(i), date: null, value, won: null }))));
  },
};

async function run(c: Call) {
  try {
    const fn = api[c.method] as (...a: unknown[]) => Promise<unknown>;
    post({ id: c.id, result: await fn(...c.args) });
  } catch (e) {
    post({ id: c.id, error: (e as Error).message });
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if ("rid" in msg) {
    const p = pending.get(msg.rid);
    pending.delete(msg.rid);
    if (!p) return;
    if (msg.bytes) p.resolve(msg.bytes);
    else p.reject(new Error(msg.error ?? "read failed"));
    return;
  }
  // start every call of the batch before any awaits, so their streams share one pass
  for (const c of msg.batch) void run(c);
};
