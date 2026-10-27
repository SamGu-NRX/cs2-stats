/// <reference lib="webworker" />
// All decoding, deriving and rolling up runs here, off the UI thread. A plugin file is decoded,
// turned into tables (plugin/adapter.ts) and derived into MatchFacts, which IndexedDB caches by file,
// size, mtime and DERIVE_VERSION next to the file's MatchEntry. A scan that finds many files to
// derive hands them to derive workers (derive-pool.ts) running the same code.
//
// Memory holds the match index (one MatchEntry per file) and the full facts of at most LRU_FACTS
// matches, the ones the match views have open. A career question streams facts from IndexedDB one
// match at a time: the calls the UI sends together (worker/client.ts batches them) share one pass
// over the files, and each sums its own matches with addMatch as the pass goes by.
import { BUY_CLASSES, BUY_TIERS } from "../stats/economy";
import { addSituations, bombsites, headToHead, mapZones, openingDuels, roundRatings, yourMatch, type Situations } from "../stats/matchviews";
import { rating3Of } from "../stats/rating3";
import { opponentsIn, vsOpponentsOf } from "../stats/opponents";
import type { FileEntry } from "../host/host";
import { matchValues, matchWon, trend, winCorrelationOf } from "../stats/trends";
import type { Baselines, SideKey } from "../stats/compare";
import { flashTool } from "../stats/flashes";
import type { MatchFacts } from "../stats/facts";
import { gunProficiency } from "../stats/guns";
import { contentHash, modelFingerprint, winProbSource, type WinProbSource } from "../stats/model-params";
import { choosePool, type ChosenPool } from "./baselines-pool";
import { entryKey as entryKeyOf, factsKey as factsKeyOf, sameEntry } from "./keys";
import { roundPlaces } from "../stats/positions";
import { addMatch, emptySummary, rollup, type Summary } from "../stats/rollup";
import { rosterTables, type RosterTables } from "../stats/roster";
import { byNewest, type MatchEntry } from "../ui/data/match";
import { idbDelete, idbGet, idbGetMany, idbKeys, idbPut } from "./idb";
import type { Api, Call, FromWorker, Method, PositionsResult, Query, ToWorker } from "./protocol";
import { addCareerMatch, botPopulation, careerScope, compassOf, rankingCalls, sideQuery, type BotPopulation } from "./ranking";
import { matchCalls } from "./matchcalls";
import { deriveFile, fileTables, type Cached } from "./derive-file";
import { derivePool, poolSize, type DerivePool } from "./derive-pool";
import { mapLimit } from "./map-limit";
import { addMapRounds, addPositions, addSpawns, emptySpawns, entryOf, matchBundle, metaOf, ratingsOf, recentFiles, rolled, roundBundle, type SpawnIndex } from "./views";

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

// ---- the pro baselines, loaded once: the local pool when meta() was given a valid one, else the shipped file
/** The packs folder's baselines.local.json, set by meta(); the pool waits for it (baselines-pool.ts). */
let setLocal: (bytes: ArrayBuffer | null) => void = () => {};
const localBytes = new Promise<ArrayBuffer | null>((r) => { setLocal = r; });
let chosen: ChosenPool | null = null;
let baselinesP: Promise<Baselines> | null = null;
function baselines(): Promise<Baselines> {
  baselinesP ??= (async () => {
    const local = await localBytes;
    const c = await choosePool(local === null ? null : new TextDecoder().decode(local), async () => {
      // revalidated on every load, so a rebuilt file is never read from the HTTP cache
      const res = await fetch(new URL(`${import.meta.env.BASE_URL}baselines.json`, self.location.href), { cache: "no-cache" });
      if (!res.ok) throw new Error(`baselines.json failed to load (HTTP ${res.status})`);
      return res.text();
    });
    // the entries are keyed by the content of the pool they were shown against, so switching pools re-ranks them
    baselinesHash = contentHash(c.text);
    chosen = c;
    return c.b;
  })();
  // a failed load is tried again on the next question
  baselinesP.catch(() => { baselinesP = null; });
  return baselinesP;
}

// ---- the index, the facts cache and the passes

/** The round win-probability source, set by meta() before any match is derived; facts depend on it. */
let wp: WinProbSource | null = null;
/** The pack wp was read from, for the derive workers (derive-pool.ts), which read it the same way. */
let wpPack: ArrayBuffer | null = null;
const source = () => {
  if (!wp) throw new Error("the stats worker derived a match before meta() chose the win-probability source");
  return wp;
};
const factsKey = (e: FileEntry) => factsKeyOf(e, modelFingerprint(source()));
/** The content hash of the baselines the entries were shown with; set by sync once they load ("none" when they fail). */
let baselinesHash = "none";
const entryKey = (k: string) => entryKeyOf(k, baselinesHash);

let index = new Map<string, { key: string; ekey: string; entry: MatchEntry }>();
/**
 * What the entries store holds for a file whose facts make no match entry (entryOf throws: the
 * recording player is not among the players, say): the error, under the entry's key. entryOf depends
 * only on the facts, so the next sync reports the error from this record. Without it the file was
 * derived again on every sync, one per window focus.
 */
interface NoEntry { noEntry: string }
/** Whether a sync has returned the match list yet; after that, an unchanged list is not sent again (Api.sync). */
let listSent = false;
/** Increments when the index changes, so cached summaries of the old file set are not reused. */
let gen = 0;
const lru = new Map<string, { key: string; facts: MatchFacts }>();

/** The user's SteamID64 for each listed folder that carries one (the user's Valve matches), from the last sync. */
const povs = new Map<string, string>();

/** Derives one file in this thread. */
const deriveHere = (file: string) => deriveFile(file, bytes, povs.get(file), source());

/**
 * The open match's tables, for what facts do not keep (one round's places). Decoded again on demand;
 * only one match's tables are held, and they are dropped when another match opens. The roster is
 * applied to them as derive applies it to the tables it reads (roster.ts), so a view of them shows the
 * same events as the facts.
 */
let openTables: { file: string; key: string; tables: RosterTables } | null = null;
async function tablesOf(file: string): Promise<RosterTables> {
  const ix = index.get(file);
  if (!ix) throw new Error(`${file} is not in the match folder; rescan it`);
  if (openTables?.file === file && openTables.key === ix.key) return openTables.tables;
  openTables = null;
  const tables = rosterTables(await fileTables(file, bytes, povs.get(file)));
  openTables = { file, key: ix.key, tables };
  return tables;
}

async function cached(file: string, key: string, derive: (file: string) => Promise<Cached> = deriveHere): Promise<Cached> {
  const c = await idbGet<Cached>("facts", key);
  if (c) return c;
  const d = await derive(file);
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

interface Job { files: Set<string>; visit: (f: MatchFacts, file: string) => void; resolve: () => void; reject: (e: Error) => void; error?: Error }
let waiting: Job[] = [];
let scheduled = false;

/**
 * Visits each of `files` once, in index order, with its facts and its file name. Calls made before the pass starts join it, so a page's
 * questions read every match from IndexedDB once between them.
 */
function stream(files: string[], visit: (f: MatchFacts, file: string) => void): Promise<void> {
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
        try { j.visit(f, file); } catch (e) { j.error = e as Error; }
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

/** The style population of a query's matches, and its samples over both sides with their names (the compass plots them). */
interface BotSet { pop: BotPopulation; careers: { name: string; s: Summary }[]; matches: { name: string; s: Summary }[] }

const careerSets = new Map<string, Promise<BotSet>>();

/**
 * The bot careers in a query's matches, as the user's style population (ranking.ts). One pass sums
 * every bot of every match on both sides and on each; the result is kept per file set and scope.
 */
function botsOf(q: Query): Promise<BotSet> {
  const scope = careerScope(q.filter);
  const k = `${gen}|${JSON.stringify([q.files, scope])}`;
  const hit = careerSets.get(k);
  if (hit) { careerSets.delete(k); careerSets.set(k, hit); return hit; }
  const careers = new Map<string, Record<SideKey, Summary>>();
  const matches: Record<SideKey, Summary>[] = [];
  // a bot career is one id (addCareerMatch); it is labelled with the name it last played under
  const names = new Map<string, string>();
  const matchNames: string[] = [];
  const p = stream(q.files, (f) => {
    addCareerMatch(careers, matches, f, scope, matchNames);
    for (const pl of f.players) if (pl.bot) names.set(pl.id, pl.name);
  }).then((): BotSet => ({
    pop: botPopulation([...careers.values()], matches, new Date().toISOString().slice(0, 10)),
    careers: [...careers].map(([id, c]) => ({ name: names.get(id) ?? id, s: c.both })),
    matches: matches.map((m, i) => ({ name: matchNames[i], s: m.both })),
  }));
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

const careersOf = (q: Query) => botsOf(q).then((b) => b.pop);

const ranking = rankingCalls({ summary: summaryOf, pros: baselines, careers: careersOf, mapRounds, spawns });
const perMatch = matchCalls(stream, summaryOf);

function entryOfFile(file: string): MatchEntry {
  const e = index.get(file)?.entry;
  if (!e) throw new Error(`${file} is not in the match folder; rescan it`);
  return e;
}

type Impl = { [K in Method]: (...a: Parameters<Api[K]>) => Promise<ReturnType<Api[K]>> };

const api: Impl = {
  async meta(winprobPack, localBaselines) {
    wp = winProbSource(winprobPack === null ? null : JSON.parse(new TextDecoder().decode(winprobPack)));
    wpPack = winprobPack;
    setLocal(localBaselines);
    return metaOf(wp);
  },
  async baselines() {
    const b = await baselines();
    return { source: b.source, built: b.built, n: b.n, model: b.model ?? "", pool: chosen!.pool, localError: chosen!.localError };
  },
  async sync(entries) {
    // entries are keyed by the baselines they were shown against
    await baselines().catch(() => undefined);
    povs.clear();
    for (const e of entries) if (e.pov) povs.set(e.file, e.pov);
    type Row = { key: string; ekey: string; entry: MatchEntry } | { error: string } | null;
    /** entry keys holding a NoEntry record, which the pruning below keeps */
    const noEntryKeys = new Set<string>();
    let done = 0;
    const tick = () => {
      done++;
      if (done % 5 === 0 || done === entries.length) post({ progress: { done, total: entries.length } });
    };
    // first every entry already built, then the files that need one, which may need deriving
    const rows: Row[] = [];
    // entries not held in memory are read in one transaction rather than one read after another; if
    // the batch fails, each file is read and fails on its own
    const keys = entries.map((e) => factsKey(e));
    const held = entries.map((e, i) => sameEntry(index.get(e.file), keys[i], entryKey(keys[i])));
    const toRead = entries.flatMap((_, i) => (held[i] ? [] : [entryKey(keys[i])]));
    const read = await idbGetMany<MatchEntry | NoEntry>("entries", toRead).then((xs) => new Map(toRead.map((k, j) => [k, xs[j]])), () => null);
    for (const [i, e] of entries.entries()) {
      const key = keys[i];
      const ekey = entryKey(key);
      try {
        const entry = held[i] ? index.get(e.file)!.entry : read ? read.get(ekey) : await idbGet<MatchEntry | NoEntry>("entries", ekey);
        if (entry && "noEntry" in entry) { noEntryKeys.add(ekey); rows.push({ error: entry.noEntry }); tick(); }
        else if (entry) { rows.push({ key, ekey, entry }); tick(); }
        else rows.push(null);
      } catch (err) {
        rows.push({ error: (err as Error).message });
        tick();
      }
    }
    const missing = rows.flatMap((r, i) => (r === null ? [i] : []));
    // derive workers only for a scan with more than one file to build (derive-pool.ts)
    const size = missing.length > 1 ? poolSize(navigator.hardwareConcurrency || 1) : 0;
    const pool: DerivePool | null = size >= 2 ? derivePool(size, wpPack, bytes) : null;
    try {
      await mapLimit(missing, pool ? size : 1, async (i) => {
        const e = entries[i];
        const key = factsKey(e);
        const ekey = entryKey(key);
        try {
          const c = await cached(e.file, key, pool ? (file) => pool.derive(file, povs.get(file)) : deriveHere);
          let entry: MatchEntry;
          try {
            entry = entryOf(e.file, c.origin, c.facts);
          } catch (err) {
            // a record that fails to save only costs the next sync a derive
            if (await idbPut("entries", ekey, { noEntry: (err as Error).message } satisfies NoEntry).then(() => true, () => false)) noEntryKeys.add(ekey);
            throw err;
          }
          await idbPut("entries", ekey, entry);
          rows[i] = { key, ekey, entry };
        } catch (err) {
          rows[i] = { error: (err as Error).message };
        }
        tick();
      });
    } finally {
      pool?.close();
    }
    const errors: { file: string; message: string }[] = [];
    const next = new Map<string, { key: string; ekey: string; entry: MatchEntry }>();
    entries.forEach((e, i) => {
      const r = rows[i]!;
      if ("error" in r) errors.push({ file: e.file, message: r.error });
      else next.set(e.file, r);
    });
    const sameList = listSent && next.size === index.size && [...next].every(([f, x]) => index.get(f)?.ekey === x.ekey);
    if (next.size !== index.size || [...next].some(([f, x]) => index.get(f)?.key !== x.key)) {
      gen++;
      summaries.clear();
      careerSets.clear();
    }
    // until this sync returns, the UI has not seen this index: a failure below must not let the next sync call it unchanged
    listSent = false;
    index = next;
    for (const [f, x] of [...lru]) if (index.get(f)?.key !== x.key) lru.delete(f);
    // drop cached facts and entries no listed file needs: gone, changed, or of an older version
    const live = new Set([...index.values()].map((x) => x.key));
    await idbDelete("facts", (await idbKeys("facts")).filter((k) => !live.has(k)));
    const liveEntries = new Set([...[...live].map(entryKey), ...noEntryKeys]);
    await idbDelete("entries", (await idbKeys("entries")).filter((k) => !liveEntries.has(k)));
    listSent = true;
    return { matches: sameList ? null : [...index.values()].map((x) => x.entry).sort(byNewest), errors };
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
  async compass(q) {
    const [you, bots] = await Promise.all([summaryOf(sideQuery(q, "both")), botsOf(q)]);
    return compassOf(you, bots.careers, bots.matches, bots.pop);
  },
  async buySplits(q) {
    const split = (key: "ownBuy" | "oppBuy") => Promise.all(BUY_CLASSES.map(async (b) => [b, rolled(await summaryOf({ files: q.files, filter: { ...q.filter, [key]: [b] } }))] as const))
      .then((xs) => Object.fromEntries(xs.filter(([, s]) => s.m.rounds > 0)));
    const [own, opp] = await Promise.all([split("ownBuy"), split("oppBuy")]);
    return { own, opp };
  },
  async buyTiers(q) {
    const xs = await Promise.all(BUY_TIERS.map(async (b) => [b, rolled(await summaryOf({ files: q.files, filter: { ...q.filter, ownTier: [b] } }))] as const));
    return Object.fromEntries(xs.filter(([, s]) => s.m.rounds > 0));
  },
  careerRatings: ranking.careerRatings,
  topStats: ranking.topStats,
  focusAreas: ranking.focusAreas,
  periodCompare: ranking.periodCompare,
  personalBests: perMatch.personalBests,
  sessions: perMatch.sessions,
  async opponents(q) {
    const me = new Set(Array.isArray(q.filter.player) ? q.filter.player : [q.filter.player]);
    // each opponent over the matches they faced the player in (opponents.ts opponentMatches)
    const opp = new Map<string, Set<string>>();
    await stream(q.files, (f, file) => { for (const id of opponentsIn(f, me)) opp.set(id, (opp.get(id) ?? new Set()).add(file)); });
    const [mine, ...theirs] = await Promise.all([summaryOf(q), ...[...opp].map(([id, fs]) => summaryOf({ files: q.files.filter((x) => fs.has(x)), filter: { ...q.filter, player: id } }))]);
    return vsOpponentsOf(mine, theirs);
  },
  async winCorrelation(q, metricIds) {
    const points: Record<string, { value: number | null; won: boolean | null }[]> = Object.fromEntries(metricIds.map((id) => [id, []]));
    const me = new Set(Array.isArray(q.filter.player) ? q.filter.player : [q.filter.player]);
    await stream(q.files, (f) => {
      const v = matchValues(f, q.filter, metricIds);
      if (!v) return;
      const won = matchWon(f, me);
      for (const id of metricIds) points[id].push({ value: v[id], won });
    });
    return Object.fromEntries(metricIds.map((id) => [id, winCorrelationOf(points[id])]));
  },
  async matchValues(q, metricId) {
    const out: Record<string, number | null> = {};
    await stream(q.files, (f, file) => { out[file] = matchValues(f, q.filter, [metricId])?.[metricId] ?? null; });
    return out;
  },
  rolesBySpawn: ranking.rolesBySpawn,
  clutches: perMatch.clutches,
  multiKills: perMatch.multiKills,
  highlights: perMatch.highlights,
  moments: perMatch.moments,
  async flashes(file, player) {
    const [f, t] = await Promise.all([factsOf(file, true), tablesOf(file)]);
    return flashTool(t, f, player);
  },
  async ratingBreakdown(file, player, reference) {
    const f = await factsOf(file, true);
    const match = rating3Of(rollup([f], { player }));
    const average = reference ? rating3Of(await summaryOf(reference)).value : match.value;
    return { rows: roundRatings(f, player, average), match, average };
  },
  async headToHead(file) {
    const [f, t] = await Promise.all([factsOf(file, true), tablesOf(file)]);
    return headToHead(t, f);
  },
  async mapZones(file, player) {
    return mapZones(await tablesOf(file), player);
  },
  async yourMatch(file, player, n) {
    const recent = recentFiles([...index.values()].map((x) => x.entry), file, player, n);
    const [match, past] = await Promise.all([summaryOf({ files: [file], filter: { player } }), summaryOf({ files: recent, filter: { player } })]);
    return { recent, rows: yourMatch(match, past) };
  },
  async openingDuels(file, player) {
    return openingDuels(await factsOf(file, true), player);
  },
  async situations(q) {
    const out: Situations = {};
    await stream(q.files, (f) => addSituations(out, f, q.filter));
    return out;
  },
  async bombsites(file, player) {
    const [f, t] = await Promise.all([factsOf(file, true), tablesOf(file)]);
    return bombsites(t, f, player);
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
