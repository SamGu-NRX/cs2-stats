// Tells the host which recorded demos the engine wants kept (design/recording.md, Retention): after
// every sync that has the moments of the recorded matches, the demos with an unrendered moment worth
// a clip go to demos_sweep (data/demos.ts keepDecisions). It sends only when the list changed, so an
// idle app does not sweep. The host also sweeps on its own, at each Bot Mode launch and import, with
// the last list it was sent. Renders nothing.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { clipsHost } from "../../clips/host";
import { keepDecisions } from "../data/demos";
import { useDemosHost, useLocalMoments } from "../data/demos-hooks";
import { useData } from "../data/provider";

// why the last keep update failed, for the Demos card; null after one that worked
let failure: string | null = null;
const listeners = new Set<() => void>();
const setFailure = (f: string | null) => {
  if (f === failure) return;
  failure = f;
  for (const l of listeners) l();
};
/** Why the engine's keeps could not be sent the last time, or null. */
export const useKeepFailure = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => failure);

export function DemoKeeper() {
  const host = useDemosHost();
  const { status, version } = useData();
  const { entries, moments, error } = useLocalMoments();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    // the moments must be the answer for this list: a keep list from a partial answer would let demos go
    if (!host || status !== "ready" || moments === null || error) return;
    let alive = true;
    (async () => {
      const store = await host.status();
      const clips = await clipsHost();
      // an unreadable clips folder counts nothing as rendered (keepDecisions)
      const rendered = clips ? await clips.scan().then((s) => new Set(s.finished.map((f) => f.id)), () => null) : null;
      const keeps = keepDecisions(store.demos, entries, moments, rendered);
      const key = JSON.stringify(keeps);
      if (!alive || key === sent.current) return;
      await host.sweep(keeps);
      sent.current = key;
      setFailure(null);
    })().catch((e: unknown) => {
      // the host may be busy (an import holds its lock at start); the next sync tries again
      setFailure(e instanceof Error ? e.message : String(e));
    });
    return () => { alive = false; };
  }, [host, status, version, entries, moments, error]);
  return null;
}
