// App-wide data: the host, the stats worker, and the match summaries. Files are re-listed when the
// window regains focus (a new match shows up after you alt-tab back from the game); there is no
// polling, so the app does no work while it sits in the background.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createHost, type Host } from "../../host/host";
import { createClient, type Client } from "../../worker/client";
import type { LightSummary } from "../../worker/protocol";

export interface Data {
  status: "starting" | "syncing" | "ready" | "error";
  error: string | null;
  host: Host | null;
  client: Client | null;
  /** newest first */
  summaries: LightSummary[];
  fileErrors: { file: string; message: string }[];
  progress: { done: number; total: number } | null;
  model: { kind: "stub" | "model"; label: string; error: string | null } | null;
  /** increments after every sync, so views can refetch */
  version: number;
  /** when the folder was last listed, ms since epoch */
  lastSync: number | null;
  refresh: () => void;
}

const Ctx = createContext<Data | null>(null);
export const useData = () => {
  const d = useContext(Ctx);
  if (!d) throw new Error("useData outside DataProvider");
  return d;
};

const MIN_GAP_MS = 2000;
/** Tauri commands reject with the Rust error string, not an Error. */
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<Data, "refresh">>({
    status: "starting", error: null, host: null, client: null, summaries: [], fileErrors: [], progress: null, model: null, version: 0, lastSync: null,
  });
  const ref = useRef<{ host: Host; client: Client } | null>(null);
  const busy = useRef(false);
  const last = useRef(0);

  const sync = useCallback(async () => {
    const r = ref.current;
    if (!r || busy.current || Date.now() - last.current < MIN_GAP_MS) return;
    busy.current = true;
    last.current = Date.now();
    try {
      setState((s) => ({ ...s, status: s.status === "ready" ? "ready" : "syncing" }));
      const entries = await r.host.list();
      const { summaries, errors } = await r.client.sync(entries);
      setState((s) => ({ ...s, status: "ready", summaries, fileErrors: errors, progress: null, version: s.version + 1, lastSync: Date.now() }));
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: errorText(e) }));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const host = await createHost();
        const client = createClient(host);
        client.onProgress((p) => alive && setState((s) => ({ ...s, progress: p })));
        ref.current = { host, client };
        const model = await client.modelInfo();
        if (!alive) return;
        setState((s) => ({ ...s, host, client, model }));
        await sync();
      } catch (e) {
        setState((s) => ({ ...s, status: "error", error: errorText(e) }));
      }
    })();
    const onFocus = () => void sync();
    addEventListener("focus", onFocus);
    return () => {
      alive = false;
      removeEventListener("focus", onFocus);
    };
  }, [sync]);

  const refresh = useCallback(() => {
    last.current = 0;
    void sync();
  }, [sync]);

  return <Ctx.Provider value={{ ...state, refresh }}>{children}</Ctx.Provider>;
}
