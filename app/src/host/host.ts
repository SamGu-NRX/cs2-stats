// Where match files come from.
// - Desktop (Tauri): Rust commands list, read and import files in %APPDATA%\BotMatchStats\matches.
// - Browser (vite dev or preview): the same folder through the dev server's /__matches endpoints
//   (vite.config.ts), plus files picked in this session.
// Both also list the converted logs bundled in public/samples unless the user hides them in
// Settings. File paths: "2026/<name>.json.gz" (recorded), "samples/<name>" (bundled),
// "picked/<name>" (picked in the browser this session), and in `vite dev` with CS2_DEV_MATCHES set,
// "dev/<folder>" (an extracted match folder; reading the folder path returns its parquet file names,
// vite.config.ts devMatches). A path not ending in .json.gz is an extracted folder.
// The user's imported Valve matches come from %APPDATA%\BotMatchStats\valve (tools/valve-folder.ts;
// lib.rs on the desktop) as "valve/<demo>/<version folder>", each carrying the user's SteamID64 as pov.
// The pro match library, a folder the user picks in Data & settings (CS2_PRO_LIBRARY for the dev
// server), lists as "pro/<series>/<map>[/<version folder>]" (tools/pro-folder.ts; pro.rs on the
// desktop). The app only reads it.

import { importStore, type ImportQuery, type ImportStore } from "./import-store";
import { tauriLeetify, type LeetifyBridge } from "./leetify";

export interface FileEntry {
  /** path relative to the match folder, e.g. "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz" */
  file: string;
  size: number;
  /** modified time, ms since epoch */
  mtime: number;
  /** the user's SteamID64, for an extracted match whose tables do not say which player recorded it */
  pov?: string;
  /**
   * the pro library a pro map was listed from (its resolved path): two libraries can hold a map at the
   * same path, size and time, and the worker's caches must not take one for the other (keys.ts factsKey)
   */
  library?: string;
}

/** One line of an import's progress: a demo starting or ending (extractor/valve_import.py --progress). */
export interface ValveProgress { event: "start" | "done"; i: number; n: number; demo: string; ok?: boolean; skipped?: boolean }
/** An import's end: the importer's exit code (0 every demo validated, 1 some failed, 2 bad input), its JSON summary, and its error output. */
export interface ValveImport {
  code: number | null;
  summary: { demos: number; ok: number; results: { demo: string; ok: boolean; errors?: string[]; user_in_match: boolean | null }[] } | null;
  error: string | null;
}
/** The Valve folder as last listed: where it is, whose matches they are, and folders without a complete match. */
export interface ValveFolder {
  folder: string | null;
  user: string | null;
  /** why the user file could not be read; its matches are listed without a user */
  userError: string | null;
  /** why the folder could not be listed at all; the other matches are still listed */
  error?: string;
  skipped: { file: string; why: string }[];
}

export const VALVE_FOLDER = String.raw`%APPDATA%\BotMatchStats\valve`;
export const isValve = (f: string) => f.startsWith("valve/");
const isProLibrary = (f: string) => f.startsWith("pro/");

/** The pro match library as last listed. */
export interface ProFolder {
  /** the folder; null when none is set */
  folder: string | null;
  /** why it could not be listed at all; the other matches are still listed */
  error: string | null;
  skipped: { file: string; why: string }[];
  /** how many of the skipped maps are not whole yet: a table missing, empty or short of its listed size */
  incomplete: number;
}
interface ProListing extends ProFolder { files: FileEntry[]; library: string | null }

/** Lists the pro library without letting it fail the whole match list, as listValveSafely does. */
async function listProSafely(list: () => Promise<ProListing | null>): Promise<{ folder: ProFolder | null; files: FileEntry[] }> {
  try {
    const p = await list();
    if (!p) return { folder: null, files: [] };
    const library = p.library ?? undefined;
    return { folder: { folder: p.folder, error: p.error, skipped: p.skipped, incomplete: p.incomplete }, files: p.files.map((f) => ({ ...f, library })) };
  } catch (e) {
    return { folder: { folder: null, error: e instanceof Error ? e.message : String(e), skipped: [], incomplete: 0 }, files: [] };
  }
}

export interface ImportResult { imported: string[]; skipped: { name: string; reason: string }[] }

export interface Host {
  kind: "tauri" | "web";
  /** the desktop smoke test is running the app (CS2_STATS_SMOKE=1, lib.rs smoke_test) */
  smoke?: boolean;
  /** the match folder, or null when it is unknown (a browser without the dev server) */
  folder: string | null;
  list(): Promise<FileEntry[]>;
  read(file: string): Promise<ArrayBuffer>;
  /** Copies match files into the match folder (desktop) or adds them for this session (browser). */
  importFiles(files: File[]): Promise<ImportResult>;
  /**
   * Reads a file from the optional packs folder (%APPDATA%\BotMatchStats\packs), e.g. "pros.json" or
   * "agents/t-portrait.png". Resolves null when the file is not there; other failures reject.
   */
  readPack(name: string): Promise<ArrayBuffer | null>;
  /** The Valve folder from the last list(), or null when this host has none. */
  readonly valve: ValveFolder | null;
  /** The pro match library from the last list(), or null when this host has none. */
  readonly pro: ProFolder | null;
  /**
   * Picks the pro match library with the system's folder picker and keeps it for later starts; resolves
   * the folder, or null when the user cancels. Absent where the folder comes from the environment (the
   * dev server's CS2_PRO_LIBRARY).
   */
  chooseProLibrary?(): Promise<string | null>;
  /** Stops reading the pro match library. */
  forgetProLibrary?(): Promise<void>;
  /** The Valve importer over the CS2 replays folder: one import at a time, its state outliving any page. */
  readonly imports: ImportStore;
  /** The optional Leetify import (host/leetify.ts); absent where the host cannot reach Leetify. */
  readonly leetify?: LeetifyBridge;
}

interface ValveListing extends ValveFolder { files: FileEntry[] }
const valveEntries = (l: ValveListing): FileEntry[] => l.files.map((f) => (l.user ? { ...f, pov: l.user } : f));

/**
 * Lists the Valve folder without letting it fail the whole match list: a listing that throws becomes an
 * error the Settings page shows, and the plugin's matches still load (review of #29).
 */
async function listValveSafely(list: () => Promise<ValveListing | null>): Promise<{ folder: ValveFolder | null; files: FileEntry[] }> {
  try {
    const v = await list();
    return v ? { folder: { folder: v.folder, user: v.user, userError: v.userError ?? null, skipped: v.skipped }, files: valveEntries(v) } : { folder: null, files: [] };
  } catch (e) {
    return { folder: { folder: null, user: null, userError: null, error: e instanceof Error ? e.message : String(e), skipped: [] }, files: [] };
  }
}

export const PACKS_FOLDER = String.raw`%APPDATA%\BotMatchStats\packs`;

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Converted logs are shown unless hidden. The old key stored "1" for shown; "0" now means hidden.
const SAMPLES_KEY = "cs2stats.showSamples";
export const samplesShown = () => localStorage.getItem(SAMPLES_KEY) !== "0";
export const setSamplesShown = (on: boolean) => localStorage.setItem(SAMPLES_KEY, on ? "1" : "0");

const isSample = (f: string) => f.startsWith("samples/");
export const isBundled = isSample;

async function sampleEntries(): Promise<FileEntry[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/index.json`);
  if (!res.ok) throw new Error(`Bundled match list failed to load (HTTP ${res.status})`);
  const names = (await res.json()) as string[];
  // ?demo=synthetic adds a generated match with aim and position data (labelled in the UI)
  const demo = new URLSearchParams(location.search).get("demo") === "synthetic" ? ["synthetic-demo.json.gz"] : [];
  return [...demo, ...names].map((n) => ({ file: `samples/${n}`, size: 0, mtime: 0 }));
}

async function fetchBytes(url: string, label: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} failed to load (HTTP ${res.status})`);
  return res.arrayBuffer();
}
const readSample = (file: string) => fetchBytes(`${import.meta.env.BASE_URL}${file}`, file);

const GZIP = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function tauriHost(): Promise<Host> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  let folder: string | null = null;
  let valve: ValveFolder | null = null;
  let pro: ProFolder | null = null;
  const imports = importStore(async (onProgress) => {
    const stop = await listen<ValveProgress>("valve-import-progress", (e) => onProgress(e.payload));
    try {
      return await invoke<ValveImport>("import_valve");
    } finally {
      stop();
    }
  }, () => invoke("valve_import_state"));
  const smoke = await invoke<boolean>("smoke_test");
  return {
    kind: "tauri",
    smoke,
    get folder() { return folder; },
    get valve() { return valve; },
    get pro() { return pro; },
    chooseProLibrary: () => invoke<string | null>("choose_pro_library"),
    forgetProLibrary: () => invoke<void>("forget_pro_library"),
    imports,
    leetify: tauriLeetify(invoke),
    async list() {
      const l = await invoke<{ folder: string; files: FileEntry[] }>("list_matches");
      folder = l.folder;
      const v = await listValveSafely(() => invoke<ValveListing>("list_valve"));
      valve = v.folder;
      const p = await listProSafely(() => invoke<ProListing>("list_pro"));
      pro = p.folder;
      const files = [...l.files, ...v.files, ...p.files];
      return samplesShown() ? [...files, ...(await sampleEntries())] : files;
    },
    read: (file) => (isSample(file) ? readSample(file)
      : isValve(file) ? invoke<ArrayBuffer>("read_valve", { path: file.slice("valve/".length) })
      : isProLibrary(file) ? invoke<ArrayBuffer>("read_pro", { path: file.slice("pro/".length) })
      : invoke<ArrayBuffer>("read_match", { file })),
    async readPack(name) {
      const r = await invoke<ArrayBuffer | null>("read_pack", { name });
      return r && r.byteLength ? r : null;
    },
    async importFiles(files) {
      const out: ImportResult = { imported: [], skipped: [] };
      for (const f of files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (!f.name.endsWith(".json.gz") || !GZIP(bytes)) { out.skipped.push({ name: f.name, reason: "not a .json.gz match file" }); continue; }
        try {
          await invoke("import_match", { name: f.name, data: Array.from(bytes) });
          out.imported.push(f.name);
        } catch (e) {
          out.skipped.push({ name: f.name, reason: String(e) });
        }
      }
      return out;
    },
  };
}

const picked = new Map<string, File>();

/** Extracted match folders from the dev server, when it was started with CS2_DEV_MATCHES; none otherwise. */
async function devEntries(): Promise<FileEntry[]> {
  if (!import.meta.env.DEV) return [];
  const res = await fetch("/__dev-matches/list");
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
  return ((await res.json()) as { files: FileEntry[] }).files;
}

/** The pro library from the dev or preview server; none without the endpoint (a static build). */
async function webPro(): Promise<ProListing | null> {
  let res: Response;
  try { res = await fetch("/__pro/list"); } catch { return null; }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
  return (await res.json()) as ProListing;
}

/** The Valve folder from the dev or preview server; none without one (404) or before any import. */
async function webValve(): Promise<ValveListing | null> {
  let res: Response;
  try { res = await fetch("/__valve/list"); } catch { return null; }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
  return (await res.json()) as ValveListing;
}

/** Runs the importer through the dev server, which streams one JSON line per event (vite.config.ts valveFolder). */
async function webImportValve(onProgress: (p: ValveProgress) => void): Promise<ValveImport> {
  const res = await fetch("/__valve/import", { method: "POST" });
  if (!res.ok || !res.body) throw new Error(res.headers.get("Content-Type")?.includes("json") ? ((await res.json()) as { error: string }).error : `The importer could not start (HTTP ${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      const m = JSON.parse(l) as ({ type: "progress" } & ValveProgress) | ({ type: "done" } & ValveImport);
      if (m.type === "progress") onProgress(m);
      else return { code: m.code, summary: m.summary, error: m.error };
    }
  }
  throw new Error("The importer stopped without reporting a result");
}

/** The dev server's import state (vite.config.ts valveFolder), for an import this page did not start. */
async function webImportState(): ReturnType<ImportQuery> {
  const res = await fetch("/__valve/import/state");
  if (!res.ok) throw new Error(`The import state failed to load (HTTP ${res.status})`);
  return res.json();
}

function webHost(): Host {
  let folder: string | null = null;
  let valve: ValveFolder | null = null;
  let pro: ProFolder | null = null;
  const imports = importStore(webImportValve, webImportState);
  return {
    kind: "web",
    get folder() { return folder; },
    get valve() { return valve; },
    get pro() { return pro; },
    imports,
    async list() {
      const local = [...picked].map(([file, f]) => ({ file, size: f.size, mtime: f.lastModified }));
      // The dev and preview servers expose the match folder; a static build has no such endpoint.
      let recorded: FileEntry[] = [];
      let failed: string | null = null;
      try {
        const res = await fetch("/__matches/list");
        if (res.ok) {
          const l = (await res.json()) as { folder: string; files: FileEntry[] };
          folder = l.folder;
          recorded = l.files;
        } else if (res.status === 500) {
          // the dev server could not read the folder; its body names the path and the cause
          failed = ((await res.json()) as { error: string }).error;
        }
      } catch { /* no dev server: bundled and picked files only */ }
      if (failed) throw new Error(failed);
      const v = await listValveSafely(webValve);
      valve = v.folder;
      const p = await listProSafely(webPro);
      pro = p.folder;
      return [...local, ...recorded, ...v.files, ...p.files, ...(await devEntries()), ...(samplesShown() ? await sampleEntries() : [])];
    },
    async read(file) {
      const p = picked.get(file);
      if (p) return p.arrayBuffer();
      if (isSample(file)) return readSample(file);
      if (isValve(file)) return fetchBytes(`/__valve/file?f=${encodeURIComponent(file.slice("valve/".length))}`, file);
      if (isProLibrary(file)) return fetchBytes(`/__pro/file?f=${encodeURIComponent(file.slice("pro/".length))}`, file);
      if (file.startsWith("dev/")) return fetchBytes(`/__dev-matches/file?f=${encodeURIComponent(file.slice(4))}`, file);
      return fetchBytes(`/__matches/file?f=${encodeURIComponent(file)}`, file);
    },
    async readPack(name) {
      const res = await fetch(`/__packs/file?f=${encodeURIComponent(name)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Pack file ${name} failed to load (HTTP ${res.status})`);
      return res.arrayBuffer();
    },
    async importFiles(files) {
      const out: ImportResult = { imported: [], skipped: [] };
      for (const f of files) {
        if (!f.name.endsWith(".json.gz")) { out.skipped.push({ name: f.name, reason: "not a .json.gz match file" }); continue; }
        picked.set(`picked/${f.name}`, f);
        out.imported.push(f.name);
      }
      return out;
    },
  };
}

export async function createHost(): Promise<Host> {
  if (isTauri()) return tauriHost();
  const web = webHost();
  // `vite dev` with ?leetify=synthetic (connected) or ?leetify=synthetic-new (at the connect form):
  // synthetic Leetify data for screenshots, labelled wherever it shows. The import is dynamic and
  // DEV-only, so a release build carries none of it.
  const stand = import.meta.env.DEV ? new URLSearchParams(location.search).get("leetify") : null;
  if (stand === "synthetic" || stand === "synthetic-new") {
    const { syntheticBridge } = await import("../ui/data/leetify/synthetic");
    return Object.defineProperties(web, { leetify: { value: syntheticBridge(stand === "synthetic"), enumerable: true } });
  }
  return web;
}
