/// <reference lib="webworker" />
// All decoding, deriving and rolling up runs here, off the UI thread. A plugin file is decoded,
// turned into tables (plugin/adapter.ts) and derived into MatchFacts, which IndexedDB caches by file,
// size, mtime and DERIVE_VERSION next to the file's MatchEntry.
//
// Memory holds the match index (one MatchEntry per file) and the full facts of at most LRU_FACTS
// matches, the ones the match views have open. A career question streams facts from IndexedDB one
// match at a time: the calls the UI sends together (worker/client.ts batches them) share one pass
// over the files, and each sums its own matches with addMatch as the pass goes by.
import { BUY_CLASSES } from "../stats/economy";
import { METRIC } from "../stats/metrics";
import { vsOpponentsOf } from "../stats/opponents";
import type { FileEntry } from "../host/host";
import { matchWon, trend, winCorrelationOf } from "../stats/trends";
import type { Baselines, SideKey } from "../stats/compare";
import { derive } from "../stats/derive";
import type { MatchFacts } from "../stats/facts";
import { gunProficiency } from "../stats/guns";
import { loadTables, withPov } from "../stats/load";
import { contentHash, modelFingerprint, winProbSource, type WinProbSource } from "../stats/model-params";
import { entryKey as entryKeyOf, factsKey as factsKeyOf, sameEntry } from "./keys";
import { decodeMatch } from "../stats/plugin/decode";
import { pluginToTables } from "../stats/plugin/adapter";
import { roundPlaces } from "../stats/positions";
import { addMatch, emptySummary, rollup, type Summary } from "../stats/rollup";
import type { MatchTables } from "../stats/tables";
import { byNewest, type MatchEntry } from "../ui/data/match";
import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import type { Api, Call, ClutchRow, MultiKillRow, FromWorker, Method, PositionsResult, Query, ToWorker } from "./protocol";
import { addCareerMatch, botPopulation, careerScope, rankingCalls, sideQuery, type BotPopulation } from "./ranking";
import { addClutchRows, addMapRounds, addMultiKillRows, addPositions, addSpawns, emptySpawns, entryOf, matchBundle, metaOf, ratingsOf, rolled, roundBundle, type SpawnIndex } from "./views";

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

/** Full facts kept in memory: the open match, the last match on Home, and a couple more. */
const LRU_FACTS = 4;
/** Summaries kept for repeated questions (the same card re-rendering, two cards asking the same thing). */
const SUMMARY_CACHE = 48;
/** Bot career baselines kept, one per set of matches the pages ask about (Profile's and Playstyle's filters). */
const CAREER_CACHE = 6;

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
    // revalidated on every load, so a rebuilt file is never read from the HTTP cache
    const res = await fetch(new URL(`${import.meta.env.BASE_URL}baselines.json`, self.location.href), { cache: "no-cache" });
    if (!res.ok) throw new Error(`baselines.json failed to load (HTTP ${res.status})`);
    const text = await res.text();
    const b = JSON.parse(text) as Baselines;
    baselinesHash = contentHash(text);
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

/** The round win-probability source, set by meta() before any match is derived; facts depend on it. */
let wp: WinProbSource | null = null;
const source = () => {
  if (!wp) throw new Error("the stats worker derived a match before meta() chose the win-probability source");
  return wp;
};
const factsKey = (e: FileEntry) => factsKeyOf(e, modelFingerprint(source()));
/** The content hash of the baselines the entries were shown with; set by sync once they load ("none" when they fail). */
let baselinesHash = "none";
const entryKey = (k: string) => entryKeyOf(k, baselinesHash);

let index = new Map<string, { key: string; ekey: string; entry: MatchEntry }>();
/** Increments when the index changes, so cached summaries of the old file set are not reused. */
let gen = 0;
const lru = new Map<string, { key: string; facts: MatchFacts }>();

/** An extracted match folder (host.ts: any path not ending in .json.gz), read table by table; else a plugin file. */
const isFolder = (file: string) => !file.endsWith(".json.gz");

/** The user's SteamID64 for each listed folder that carries one (the user's Valve matches), from the last sync. */
const povs = new Map<string, string>();

async function folderTables(file: string): Promise<MatchTables> {
  const names = new Set(JSON.parse(new TextDecoder().decode(await bytes(file))) as string[]);
  const t = await loadTables((name) => (names.has(name) ? bytes(`${file}/${name}`) : Promise.resolve(null)));
  const pov = povs.get(file);
  return pov ? withPov(t, pov) : t;
}

async function deriveFile(file: string): Promise<Cached> {
  if (isFolder(file)) {
    const t = await folderTables(file);
    return { facts: derive(t, source()), origin: `extracted, ${t.match.extractor_version[0]}` };
  }
  const m = await decodeMatch(await bytes(file), file);
  return { facts: derive(pluginToTables(m), source()), origin: m.env.plugin ?? "" };
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

/** The query's players' rounds per map that its filter keeps. */
async function mapRounds(q: Query): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await stream(q.files, (f) => addMapRounds(out, f, q.filter));
  return out;
}

/** The spawns of the query's matches, with the rows its filter keeps. */
async function spawns(q: Query): Promise<SpawnIndex> {
  const acc = emptySpawns();
  await stream(q.files, (f) => addSpawns(acc, f, q.filter));
  return acc;
}

const ranking = rankingCalls({ summary: summaryOf, pros: baselines, careers: careersOf, mapRounds, spawns });

function entryOfFile(file: string): MatchEntry {
  const e = index.get(file)?.entry;
  if (!e) throw new Error(`${file} is not in the match folder; rescan it`);
  return e;
}

type Impl = { [K in Method]: (...a: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> };

const api: Impl = {
  async meta(winprobPack) {
    wp = winProbSource(winprobPack === null ? null : JSON.parse(new TextDecoder().decode(winprobPack)));
    return metaOf(wp);
  },
  async baselines() {
    const b = await baselines();
    return { source: b.source, built: b.built, n: b.n };
  },
  async sync(entries) {
    // entries are keyed by the baselines they were shown against
    await baselines().catch(() => undefined);
    povs.clear();
    for (const e of entries) if (e.pov) povs.set(e.file, e.pov);
    const errors: { file: string; message: string }[] = [];
    const next = new Map<string, { key: string; ekey: string; entry: MatchEntry }>();
    let done = 0;
    for (const e of entries) {
      const key = factsKey(e);
      try {
        const prev = index.get(e.file);
        const ekey = entryKey(key);
        let entry = sameEntry(prev, key, ekey) ? prev!.entry : await idbGet<MatchEntry>("entries", ekey);
        if (!entry) {
          const c = await cached(e.file, key);
          entry = entryOf(e.file, c.origin, c.facts);
          await idbPut("entries", ekey, entry);
        }
        next.set(e.file, { key, ekey, entry });
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
      return ratingsOf({ both, T, CT });
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
  attributeBlock: ranking.attributeBlock,
  roles: ranking.roles,
  rolesByMap: ranking.rolesByMap,
  playsLike: ranking.playsLike,
  async buySplits(q) {
    const split = (key: "ownBuy" | "oppBuy") => Promise.all(BUY_CLASSES.map(async (b) => [b, rolled(await summaryOf({ files: q.files, filter: { ...q.filter, [key]: [b] } }))] as const))
      .then((xs) => Object.fromEntries(xs.filter(([, s]) => s.m.rounds > 0)));
    const [own, opp] = await Promise.all([split("ownBuy"), split("oppBuy")]);
    return { own, opp };
  },
  async opponents(q) {
    const me = new Set(Array.isArray(q.filter.player) ? q.filter.player : [q.filter.player]);
    const opp = new Set<string>();
    await stream(q.files, (f) => {
      const mine = f.players.find((p) => me.has(p.id));
      if (mine) for (const p of f.players) if (p.team !== null && p.team !== mine.team) opp.add(p.id);
    });
    const [mine, ...theirs] = await Promise.all([summaryOf(q), ...[...opp].map((id) => summaryOf({ files: q.files, filter: { ...q.filter, player: id } }))]);
    return vsOpponentsOf(mine, theirs);
  },
  async winCorrelation(q, metricIds) {
    const points: Record<string, { value: number | null; won: boolean | null }[]> = Object.fromEntries(metricIds.map((id) => [id, []]));
    const me = new Set(Array.isArray(q.filter.player) ? q.filter.player : [q.filter.player]);
    await stream(q.files, (f) => {
      const s = rollup([f], q.filter);
      if (!s.m.rounds) return;
      const won = matchWon(f, me);
      for (const id of metricIds) points[id].push({ value: METRIC[id].value(s), won });
    });
    return Object.fromEntries(metricIds.map((id) => [id, winCorrelationOf(points[id])]));
  },
  rolesBySpawn: ranking.rolesBySpawn,
  async clutches(q) {
    const out: ClutchRow[] = [];
    const fileOf = new Map<string, string>();
    for (const file of q.files) { const e = index.get(file)?.entry; if (e) fileOf.set(e.match.id, file); }
    await stream(q.files, (f) => addClutchRows(out, fileOf.get(f.match.id) ?? f.match.id, f, q.filter));
    return out;
  },
  async multiKills(q) {
    const out: MultiKillRow[] = [];
    const fileOf = new Map<string, string>();
    for (const file of q.files) { const e = index.get(file)?.entry; if (e) fileOf.set(e.match.id, file); }
    await stream(q.files, (f) => addMultiKillRows(out, fileOf.get(f.match.id) ?? f.match.id, f, q.filter));
    return out;
  },
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
