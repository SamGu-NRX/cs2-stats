// The Valve import's state, kept outside any component so it survives navigation: Settings shows an
// import that is running when it mounts, and the host runs at most one at a time (review of #29).
import type { ValveImport, ValveProgress } from "./host";

export interface ImportStatus {
  running: boolean;
  /** the last progress line of the running (or last) import */
  at: ValveProgress | null;
  /** the last import's end */
  last: ValveImport | null;
  /** why the last import could not start or did not report an end */
  error: string | null;
}

/** What the backend says, for an import this page did not start (one started before a reload). */
export type ImportQuery = () => Promise<{ running: boolean; at: ValveProgress | null; last: ValveImport | null }>;

export interface ImportStore {
  get(): ImportStatus;
  subscribe(listener: () => void): () => void;
  /** Starts an import; rejects, changing nothing, while one is running. */
  start(): Promise<void>;
  /** Adopts the backend's state, and follows a running import to its end. */
  sync(): Promise<void>;
}

const IDLE: ImportStatus = { running: false, at: null, last: null, error: null };

export function importStore(run: (onProgress: (p: ValveProgress) => void) => Promise<ValveImport>, query: ImportQuery, pollMs = 1000): ImportStore {
  let status = IDLE;
  let following = false;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ImportStatus>) => {
    status = { ...status, ...next };
    for (const l of listeners) l();
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return {
    get: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async start() {
      if (status.running) throw new Error("an import is already running");
      set({ running: true, at: null, error: null });
      try {
        set({ last: await run((at) => set({ at })), running: false });
      } catch (e) {
        set({ running: false, error: message(e) });
      }
    },
    async sync() {
      if (status.running || following) return;
      following = true;
      try {
        for (;;) {
          const q = await query();
          if (!q.running) {
            if (status.running) set({ running: false, at: q.at, last: q.last });
            else if (q.last && !status.last) set({ last: q.last, at: q.at });
            return;
          }
          set({ running: true, at: q.at });
          await new Promise((r) => setTimeout(r, pollMs));
        }
      } catch (e) {
        set({ running: false, error: message(e) });
      } finally {
        following = false;
      }
    },
  };
}
