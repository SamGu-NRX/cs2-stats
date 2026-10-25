// Where match files come from.
// - Desktop (Tauri): Rust commands list, read and import files in %APPDATA%\BotMatchStats\matches.
// - Browser (vite dev or preview): the same folder through the dev server's /__matches endpoints
//   (vite.config.ts), plus files picked in this session.
// Both also list the converted logs bundled in public/samples unless the user hides them in
// Settings. File paths: "2026/<name>.json.gz" (recorded), "samples/<name>" (bundled),
// "picked/<name>" (picked in the browser this session), and in `vite dev` with CS2_DEV_MATCHES set,
// "dev/<folder>/" (an extracted match folder; reading the folder path returns its parquet file names,
// vite.config.ts devMatches).

export interface FileEntry {
  /** path relative to the match folder, e.g. "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz" */
  file: string;
  size: number;
  /** modified time, ms since epoch */
  mtime: number;
}

export interface ImportResult { imported: string[]; skipped: { name: string; reason: string }[] }

export interface Host {
  kind: "tauri" | "web";
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
  let folder: string | null = null;
  return {
    kind: "tauri",
    get folder() { return folder; },
    async list() {
      const l = await invoke<{ folder: string; files: FileEntry[] }>("list_matches");
      folder = l.folder;
      return samplesShown() ? [...l.files, ...(await sampleEntries())] : l.files;
    },
    read: (file) => (isSample(file) ? readSample(file) : invoke<ArrayBuffer>("read_match", { file })),
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

function webHost(): Host {
  let folder: string | null = null;
  return {
    kind: "web",
    get folder() { return folder; },
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
      return [...local, ...recorded, ...(await devEntries()), ...(samplesShown() ? await sampleEntries() : [])];
    },
    async read(file) {
      const p = picked.get(file);
      if (p) return p.arrayBuffer();
      if (isSample(file)) return readSample(file);
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
  return isTauri() ? tauriHost() : webHost();
}
