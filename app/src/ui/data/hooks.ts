// Loading hooks over the worker. Each returns { data, error, loading } and refetches when a sync
// changes the file list (data.version). Calls made in one render go to the worker together
// (worker/client.ts), so a page's career questions share one pass over the stored matches.
import { useEffect, useMemo, useState } from "react";
import type { Filter } from "../../stats/rollup";
import type { Client } from "../../worker/client";
import type { Api, MatchBundle, Method, Query, Result } from "../../worker/protocol";
import { careerEntries } from "./engine";
import { matchModel, type MatchEntry, type MatchModel } from "./match";
import { useData } from "./provider";

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean }

function useAsync<T>(key: string | null, run: () => Promise<T>): Loaded<T> {
  const [st, setSt] = useState<Loaded<T>>({ data: null, error: null, loading: !!key });
  useEffect(() => {
    if (!key) { setSt({ data: null, error: null, loading: false }); return; }
    let alive = true;
    setSt((s) => ({ data: s.data, error: null, loading: true }));
    run().then(
      (data) => alive && setSt({ data, error: null, loading: false }),
      (e: Error) => alive && setSt({ data: null, error: e.message, loading: false }),
    );
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/** One worker call; null args skip it. Refetches after a sync. */
export function useCall<K extends Method>(method: K, args: Parameters<Api[K]> | null): Loaded<Result<K>> {
  const { client, version } = useData();
  const key = client && args ? `${version}|${method}|${JSON.stringify(args)}` : null;
  return useAsync(key, () => (client![method] as (...a: unknown[]) => Promise<Result<K>>)(...args!));
}

// The open match's bundle, shared by every view that shows it (the Home hero and highlights ask for
// the same match). At most BUNDLES are kept; the worker holds the facts themselves.
const BUNDLES = 3;
const bundles = new Map<string, Promise<MatchBundle>>();
export function bundleOf(client: Client, version: number, file: string): Promise<MatchBundle> {
  const k = `${version}|${file}`;
  let p = bundles.get(k);
  if (p) { bundles.delete(k); bundles.set(k, p); return p; }
  p = client.match(file);
  p.catch(() => bundles.delete(k));
  bundles.set(k, p);
  while (bundles.size > BUNDLES) bundles.delete(bundles.keys().next().value!);
  return p;
}

/** One match shaped for the match views. The entry must be in the match list. */
export function useMatch(file: string | null): Loaded<MatchModel> {
  const { client, version, matches } = useData();
  const entry = file ? matches.find((m) => m.file === file) ?? null : null;
  return useAsync(client && file ? `${version}|m:${file}:${entry ? "" : "missing"}` : null, async () => {
    if (!entry) throw new Error(`${file} is not in the match folder`);
    return matchModel(entry, await bundleOf(client!, version, file!));
  });
}

export const useRollups = (qs: Query[] | null) => useCall("rollup", qs?.length ? [qs] : null);
export const useRatings = (qs: Query[] | null) => useCall("ratings", qs?.length ? [qs] : null);

/** The query for the recording player over a list of matches. */
export function useYourQuery(list: MatchEntry[], extra: Omit<Filter, "player"> = {}): Query | null {
  const { you } = useData();
  const k = JSON.stringify(extra);
  return useMemo(() => (list.length && you.length ? { files: list.map((m) => m.file), filter: { ...extra, player: you } } : null),
    [list, you, k]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Summaries for a query narrowed by each extra filter, in order; null while they load. */
export function useScoped(q: Query, extra: Omit<Filter, "player">[]) {
  const k = JSON.stringify(extra);
  const qs = useMemo(() => extra.map((e) => ({ files: q.files, filter: { ...q.filter, ...e } })), [q, k]); // eslint-disable-line react-hooks/exhaustive-deps
  return useRollups(qs).data;
}

/**
 * The career matches under the title bar's Map and Matches controls (shell/filters.tsx useScope):
 * the user's own finished, logged matches (engine.ts careerEntries), newest first, cut to the last N.
 * Every block on a career view reads this one list, so a filter reaches all of them. `all` is the
 * same set before the last-N cut (what "All 8" counts).
 */
export function useCareer(scope: { map: string | null; n: number | null }): { list: MatchEntry[]; all: MatchEntry[] } {
  const { matches } = useData();
  return useMemo(() => {
    const all = careerEntries(matches, scope.map);
    return { all, list: scope.n ? all.slice(0, scope.n) : all };
  }, [matches, scope.map, scope.n]);
}
