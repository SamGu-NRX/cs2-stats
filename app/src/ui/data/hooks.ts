// Loading hooks over the worker. Each returns { data, error, loading } and refetches when a sync
// changes the file list (data.version).
import { useEffect, useMemo, useState } from "react";
import type { MatchFacts } from "../../stats/facts";
import type { GunProficiency } from "../../stats/guns";
import { rollup, type Filter, type Summary } from "../../stats/rollup";
import type { Query, SideRatings } from "../../worker/protocol";
import { matchModel, type MatchEntry, type MatchModel } from "./match";
import { useData } from "./provider";

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean }

function useAsync<T>(key: string | null, run: () => Promise<T>, deps: unknown[]): Loaded<T> {
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
  }, [key, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}

/** One match's facts shaped for the match views. The entry must be in the match list. */
export function useMatch(file: string | null): Loaded<MatchModel> {
  const { client, version, matches } = useData();
  const entry = file ? matches.find((m) => m.file === file) ?? null : null;
  return useAsync(client && file ? `m:${file}:${entry ? "" : "missing"}` : null, async () => {
    if (!entry) throw new Error(`${file} is not in the match folder`);
    return matchModel(entry, await client!.facts(file!));
  }, [version, client]);
}

const keyOf = (qs: Query[] | Query | null) => (qs === null ? null : JSON.stringify(qs));

export function useRollups(qs: Query[] | null): Loaded<Summary[]> {
  const { client, version } = useData();
  return useAsync(client && qs?.length ? `r:${keyOf(qs)}` : null, () => client!.rollup(qs!), [version, client]);
}

export function useRatings(qs: Query[] | null): Loaded<SideRatings[]> {
  const { client, version } = useData();
  return useAsync(client && qs?.length ? `s:${keyOf(qs)}` : null, () => client!.ratings(qs!), [version, client]);
}

export function useGuns(q: Query | null): Loaded<GunProficiency[]> {
  const { client, version } = useData();
  return useAsync(client && q ? `g:${keyOf(q)}` : null, () => client!.guns(q!), [version, client]);
}

export function usePositions(q: Query | null): Loaded<{ kills: [number, number][]; deaths: [number, number][] }> {
  const { client, version } = useData();
  return useAsync(client && q ? `p:${keyOf(q)}` : null, () => client!.positions(q!), [version, client]);
}

/**
 * Where a view's numbers come from: one match's facts already on this thread (rolled up here), or
 * a set of files the worker holds. Views that serve both (the aim panels) take a scope.
 */
export type Scope = { facts: MatchFacts; player: string } | { query: Query };

/** Summaries for the scope narrowed by each extra filter, in order; null while they load. */
export function useScoped(scope: Scope, extra: Omit<Filter, "player">[]): Summary[] | null {
  const k = JSON.stringify(extra);
  const local = useMemo(() => ("facts" in scope ? extra.map((e) => rollup([scope.facts], { ...e, player: scope.player })) : null),
    [scope, k]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = useMemo(() => ("query" in scope ? extra.map((e) => ({ files: scope.query.files, filter: { ...scope.query.filter, ...e } })) : null),
    [scope, k]); // eslint-disable-line react-hooks/exhaustive-deps
  const remote = useRollups(qs).data;
  return local ?? remote;
}

/** The query for the recording player over a list of matches. */
export function useYourQuery(list: MatchEntry[], extra: Omit<Filter, "player"> = {}): Query | null {
  const { you } = useData();
  const k = JSON.stringify(extra);
  return useMemo(() => (list.length && you.length ? { files: list.map((m) => m.file), filter: { ...extra, player: you } } : null),
    [list, you, k]); // eslint-disable-line react-hooks/exhaustive-deps
}
