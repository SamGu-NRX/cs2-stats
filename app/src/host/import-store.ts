// The Valve import's state, kept outside any component so it survives navigation: Settings shows an
// import that is running when it mounts, the host runs at most one at a time, and the app rescans when
// one ends, whichever page is open (review of #29).
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
  /** Called once each time an import ends (with a result or an error), whether or not a page is subscribed. */
  onFinish(listener: () => void): () => void;
  /** Starts an import; rejects, changing nothing, while one is running. */
  start(): Promise<void>;
  /** Adopts the backend's state, and follows a running import to its end. */
  sync(): Promise<void>;
}

const IDLE: ImportStatus = { running: false, at: null, last: null, error: null };

export function importStore(run: (onProgress: (p: ValveProgress) => void) => Promise<ValveImport>, query: ImportQuery, pollMs = 1000): ImportStore {
  let status = IDLE;
  let following = false;
  // Every start and every sync takes a new operation number; an answer for an older one is dropped, so a
  // state query sent before an import started cannot report it idle (review of #29).
  let op = 0;
  const listeners = new Set<() => void>();
  const finished = new Set<() => void>();
  const set = (next: Partial<ImportStatus>) => {
    status = { ...status, ...next };
    for (const l of listeners) l();
  };
  const finish = (next: Partial<ImportStatus>) => {
    set({ ...next, running: false });
    for (const l of finished) l();
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  return {
    get: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onFinish(listener) {
      finished.add(listener);
      return () => { finished.delete(listener); };
    },
    async start() {
      if (status.running) throw new Error("an import is already running");
      const mine = ++op;
      set({ running: true, at: null, error: null });
      try {
        const last = await run((at) => { if (op === mine) set({ at }); });
        finish({ last });
      } catch (e) {
        finish({ error: message(e) });
      }
    },
    async sync() {
      if (status.running || following) return;
      following = true;
      const mine = ++op;
      try {
        for (;;) {
          const q = await query();
          if (op !== mine) return; // an import started here since: this answer is stale
          if (!q.running) {
            if (status.running) finish({ at: q.at, last: q.last });
            else if (q.last && !status.last) set({ last: q.last, at: q.at });
            return;
          }
          set({ running: true, at: q.at });
          await new Promise((r) => setTimeout(r, pollMs));
          if (op !== mine) return;
        }
      } catch (e) {
        if (op === mine && status.running) finish({ error: message(e) });
      } finally {
        following = false;
      }
    },
  };
}
