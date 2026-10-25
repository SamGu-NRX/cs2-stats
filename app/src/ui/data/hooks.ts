// Loading hooks over the worker and the host. Each returns { data, error } and refetches when a sync
// changes the file list (data.version).
import { useEffect, useMemo, useState } from "react";
import { emptyR3 } from "../../stats/rating3";
import { addR3, sideInputs, type SideInputs } from "./sideRating";
import { decodeMatch } from "../../stats/decode";
import type { MatchView } from "../../stats/derive";
import type { PosAgg } from "../../stats/positions";
import type { ProfileFilter, ProfileView } from "../../stats/profile";
import type { MatchFile } from "../../stats/schema";
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

export function useMatchView(file: string | null): Loaded<MatchView> {
  const { client, version } = useData();
  return useAsync(client && file ? `m:${file}` : null, () => client!.match(file!), [version, client]);
}

export function useProfile(filter: ProfileFilter): Loaded<ProfileView | null> {
  const { client, version } = useData();
  return useAsync(client ? `p:${filter.map ?? ""}:${filter.lastN ?? ""}` : null, () => client!.profile(filter), [version, client]);
}

// Raw match files, for the interim per-round numbers (data/interim.ts). Two are kept: the match
// open now and the one before it.
const rawCache = new Map<string, Promise<MatchFile>>();
export function useRawMatch(file: string | null): Loaded<MatchFile> {
  const { host, version } = useData();
  return useAsync(host && file ? `r:${file}` : null, () => {
    let p = rawCache.get(file!);
    if (!p) {
      p = host!.read(file!).then((b) => decodeMatch(b, file!));
      rawCache.set(file!, p);
      p.catch(() => rawCache.delete(file!));
      while (rawCache.size > 2) rawCache.delete(rawCache.keys().next().value!);
    }
    return p;
  }, [version, host]);
}

// Position samples merged over every match on a map: the walkable shape used for map art and the
// radar backdrop. Cached per map for the session.
const posCache = new Map<string, Promise<PosAgg>>();
export function useMapPositions(map: string | null): Loaded<PosAgg> {
  const { client, version } = useData();
  return useAsync(client && map ? `pos:${map}:${version}` : null, () => {
    const key = `${map}:${version}`;
    let p = posCache.get(key);
    if (!p) { p = client!.profilePositions(map!); posCache.set(key, p); }
    return p;
  }, [version, client]);
}

/** Several raw match files, decoded in order. A file that fails is skipped (Data & settings lists it). */
export function useRawMatches(files: string[]): Loaded<MatchFile[]> {
  const { host, version } = useData();
  return useAsync(host && files.length ? `rs:${files.join("|")}` : null, async () => {
    const out: MatchFile[] = [];
    for (const f of files) {
      try { out.push(await host!.read(f).then((b) => decodeMatch(b, f))); } catch { /* listed in Data & settings */ }
    }
    return out;
  }, [version, host]);
}

export interface SideTotals {
  /** your Rating 3.0 inputs per side, pooled over the matches */
  you: SideInputs;
  /** every bot in the same matches, per side */
  bots: SideInputs;
  byMap: Map<string, SideInputs>;
}

/** Rating 3.0 inputs per side over a list of matches (data/sideRating.ts), decoded from the raw files. */
export function useSideTotals(files: string[]): SideTotals | null {
  const raws = useRawMatches(files).data;
  return useMemo(() => {
    if (!raws) return null;
    const you: SideInputs = { t: emptyR3(), ct: emptyR3() };
    const bots: SideInputs = { t: emptyR3(), ct: emptyR3() };
    const byMap = new Map<string, SideInputs>();
    for (const m of raws) {
      const s = sideInputs(m);
      const mine = s[m.human];
      you.t = addR3(you.t, mine.t);
      you.ct = addR3(you.ct, mine.ct);
      const mp = byMap.get(m.map) ?? { t: emptyR3(), ct: emptyR3() };
      byMap.set(m.map, { t: addR3(mp.t, mine.t), ct: addR3(mp.ct, mine.ct) });
      s.forEach((x, pi) => { if (m.players.isBot[pi]) { bots.t = addR3(bots.t, x.t); bots.ct = addR3(bots.ct, x.ct); } });
    }
    return { you, bots, byMap };
  }, [raws]);
}
