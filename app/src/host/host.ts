// Where match files come from. In the desktop app, two Rust commands list and read files in the
// match folder. In a plain browser (dev or preview), the bundled sample matches are listed, and in
// dev a file picker can add local .json.gz files. The desktop app can also show the samples when the
// user asks for them (useful before the first captured match).

export interface FileEntry {
  /** path relative to the match folder, e.g. "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz" */
  file: string;
  size: number;
  /** modified time, ms since epoch */
  mtime: number;
}

export interface Host {
  kind: "tauri" | "web";
  /** match folder shown in the UI, or null in the browser */
  folder: string | null;
  list(): Promise<FileEntry[]>;
  read(file: string): Promise<ArrayBuffer>;
}

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SAMPLES_KEY = "cs2stats.showSamples";
export const samplesShown = () => localStorage.getItem(SAMPLES_KEY) === "1";
export const setSamplesShown = (on: boolean) => (on ? localStorage.setItem(SAMPLES_KEY, "1") : localStorage.removeItem(SAMPLES_KEY));

async function sampleEntries(): Promise<FileEntry[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/index.json`);
  if (!res.ok) throw new Error(`Sample list failed to load (HTTP ${res.status})`);
  const names = (await res.json()) as string[];
  const demo = new URLSearchParams(location.search).get("demo") === "synthetic" ? ["synthetic-demo.json.gz"] : [];
  // ?demo=synthetic adds a generated match with aim and position data (labelled in the UI)
  return [...demo, ...names].map((n) => ({ file: `samples/${n}`, size: 0, mtime: 0 }));
}

async function fetchBytes(file: string): Promise<ArrayBuffer> {
  const res = await fetch(`${import.meta.env.BASE_URL}${file}`);
  if (!res.ok) throw new Error(`${file} failed to load (HTTP ${res.status})`);
  return res.arrayBuffer();
}

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
    read: (file) => (file.startsWith("samples/") ? fetchBytes(file) : invoke<ArrayBuffer>("read_match", { file })),
  };
}

const picked = new Map<string, File>();

/** Dev only: add local match files picked by the user. */
export function addPickedFiles(files: FileList | File[]) {
  for (const f of files) if (f.name.endsWith(".json.gz")) picked.set(`picked/${f.name}`, f);
}

function webHost(): Host {
  return {
    kind: "web",
    folder: null,
    async list() {
      const local = [...picked].map(([file, f]) => ({ file, size: f.size, mtime: f.lastModified }));
      return [...local, ...(await sampleEntries())];
    },
    async read(file) {
      const p = picked.get(file);
      return p ? p.arrayBuffer() : fetchBytes(file);
    },
  };
}

export async function createHost(): Promise<Host> {
  return isTauri() ? tauriHost() : webHost();
}
