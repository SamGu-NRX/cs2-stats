// App-wide data: the host, the stats worker, the match list, the engine's descriptions and what the
// pro baselines cover. Files are re-listed when the window regains focus (a new match shows up after
// you alt-tab back from the game); there is no polling, so the app does no work while it sits in the
// background.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createHost, type Host } from "../../host/host";
import { createClient, type Client } from "../../worker/client";
import type { BaselineInfo } from "../../worker/protocol";
import type { MatchEntry } from "./match";
import { setMeta } from "./meta";

export interface Data {
  status: "starting" | "syncing" | "ready" | "error";
  error: string | null;
  host: Host | null;
  client: Client | null;
  /** the engine's metric, attribute and rating descriptions have arrived (data/meta.ts) */
  meta: boolean;
  /** newest first */
  matches: MatchEntry[];
  /** steamids of the recording player across the matches (one per account) */
  you: string[];
  fileErrors: { file: string; message: string }[];
  progress: { done: number; total: number } | null;
  /** what the anonymous pro percentiles (public/baselines.json, read by the worker) cover */
  baselines: BaselineInfo | null;
  baselinesError: string | null;
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
    status: "starting", error: null, host: null, client: null, meta: false, matches: [], you: [], fileErrors: [], progress: null,
    baselines: null, baselinesError: null, version: 0, lastSync: null,
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
      const { matches, errors } = await r.client.sync(entries);
      const you = [...new Set(matches.map((m) => m.players[m.you].id))];
      setState((s) => ({ ...s, status: "ready", matches, you, fileErrors: errors, progress: null, version: s.version + 1, lastSync: Date.now() }));
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
        client.baselines().then(
          (baselines) => alive && setState((s) => ({ ...s, baselines })),
          (e: Error) => alive && setState((s) => ({ ...s, baselinesError: e.message })),
        );
        setMeta(await client.meta(await host.readPack("winprob-hltv.json")));
        if (!alive) return;
        setState((s) => ({ ...s, host, client, meta: true }));
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
