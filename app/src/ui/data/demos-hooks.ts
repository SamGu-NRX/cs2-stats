// The recorded demos for the views: the host's store (src/host/demos.ts) and the moments of the
// user's recorded-demo matches, which only the engine scores. The Demos card and the keeper
// (DemoKeeper.tsx) read the same calls, so the worker answers each once.
import { useEffect, useMemo, useState } from "react";
import { demosHost, type DemosHost } from "../../host/demos";
import type { MomentRow } from "../../worker/protocol";
import { useCall, useYourQuery } from "./hooks";
import type { MatchEntry } from "./match";
import { useData } from "./provider";
import { sourceOf } from "./sources";

/** The demos host once found: undefined while looking, null where there is none (the browser). */
export function useDemosHost(): DemosHost | null | undefined {
  const [host, setHost] = useState<DemosHost | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    demosHost().then((h) => alive && setHost(h), () => alive && setHost(null));
    return () => { alive = false; };
  }, []);
  return host;
}

/** The recorded demos' match entries and the user's moments in them; `moments` is null until the worker answers. */
export function useLocalMoments(): { entries: MatchEntry[]; moments: MomentRow[] | null; error: string | null } {
  const { matches } = useData();
  const entries = useMemo(() => matches.filter((e) => sourceOf(e).id === "local"), [matches]);
  const q = useYourQuery(entries);
  const call = useCall("moments", q ? [q] : null);
  // with no recorded match there is nothing to score, which is an answer, not a wait
  const moments = !q ? [] : call.stale ? null : call.data;
  return { entries, moments, error: q ? call.error : null };
}
