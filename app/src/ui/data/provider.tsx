// App-wide data: the host, the stats worker, the match list, the engine's descriptions and what the
// pro baselines cover. Files are re-listed when the window regains focus (a new match shows up after
// you alt-tab back from the game); there is no polling, so the app does no work while it sits in the
// background.
//
// Data truth lives here: the list arrives newest first by start time (data/match.ts byNewest), with
// the coverage rule applied (engine.ts coverEntry), and `you` names only the user's own accounts, so a
// pro demo's recording player never becomes "you".
import { scanQueue } from "./scan-queue";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createHost, type Host } from "../../host/host";
import { createClient, type Client } from "../../worker/client";
import type { BaselineInfo } from "../../worker/protocol";
import { coverEntry, isOwn } from "./engine";
import type { MatchEntry } from "./match";
import { setMeta } from "./meta";

export interface Data {
  status: "starting" | "syncing" | "ready" | "error";
  error: string | null;
  host: Host | null;
  client: Client | null;
  /** the engine's metric, attribute and rating descriptions have arrived (data/meta.ts) */
  meta: boolean;
  /** every listed match, own and pro, newest first by start time, under the coverage rule (engine.ts coverEntry) */
  matches: MatchEntry[];
  /** steamids of the user across their own matches (one per account); pro demos' recording players are not "you" */
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
  /** Rescans the folder; after a failed start, starts the engine again. */
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
  const last = useRef(0);
  // One scan at a time; a forced rescan (refresh, an import ending) asked for during one runs right after
  // it instead of being dropped (scan-queue.ts).
  const scans = useRef(scanQueue(async () => {
    const r = ref.current;
    if (!r) return;
    last.current = Date.now();
    try {
      setState((s) => ({ ...s, status: s.status === "ready" ? "ready" : "syncing" }));
      const entries = await r.host.list();
      const synced = await r.client.sync(entries);
      const matches = synced.matches.map(coverEntry);
      const you = [...new Set(matches.filter(isOwn).map((m) => m.players[m.you].id))];
      setState((s) => ({ ...s, status: "ready", error: null, matches, you, fileErrors: synced.errors, progress: null, version: s.version + 1, lastSync: Date.now() }));
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: errorText(e) }));
    }
  }));

  // A focus event within MIN_GAP_MS of the last scan does nothing; refresh and an import's end clear `last` first.
  const sync = useCallback(async () => {
    if (!ref.current || Date.now() - last.current < MIN_GAP_MS) return;
    await scans.current();
  }, []);

  // Each start is one run; a newer run (a retry, or StrictMode's second mount) or an unmount makes the
  // older one stop at its next step, so only one client is ever synced and handed to the views.
  const run = useRef(0);
  const stopImports = useRef(() => {});
  const start = useCallback(async () => {
    const mine = ++run.current;
    const live = () => mine === run.current;
    try {
      setState((s) => ({ ...s, status: "starting", error: null }));
      const host = await createHost();
      const client = createClient(host);
      client.onProgress((p) => live() && setState((s) => ({ ...s, progress: p })));
      client.baselines().then(
        (baselines) => live() && setState((s) => ({ ...s, baselines })),
        (e: Error) => live() && setState((s) => ({ ...s, baselinesError: e.message })),
      );
      setMeta(await client.meta(await host.readPack("winprob-hltv.json")));
      if (!live()) return;
      ref.current = { host, client };
      // An import that ends rescans the matches whichever page is open, and one already running when the
      // app opens is followed to its end (review of #29).
      stopImports.current();
      stopImports.current = host.imports.onFinish(() => { last.current = 0; void sync(); });
      void host.imports.sync();
      setState((s) => ({ ...s, host, client, meta: true }));
      await sync();
    } catch (e) {
      if (live()) setState((s) => ({ ...s, status: "error", error: errorText(e) }));
    }
  }, [sync]);

  useEffect(() => {
    void start();
    const onFocus = () => void sync();
    addEventListener("focus", onFocus);
    return () => {
      run.current++;
      stopImports.current();
      removeEventListener("focus", onFocus);
    };
  }, [start, sync]);

  const refresh = useCallback(() => {
    last.current = 0;
    if (ref.current) void sync();
    else void start();
  }, [sync, start]);

  return <Ctx.Provider value={{ ...state, refresh }}>{children}</Ctx.Provider>;
}
