// The Leetify import's state for the views: whether a player is connected, the last copy of their data,
// what is running, and the last failure. One store per bridge, so Data & settings, Profile, Matches and
// the match page share one copy and one set of requests.
//
// Leetify's guidelines ask apps not to store its data, so nothing from Leetify is saved: the host holds the
// last answer in memory for the app's session (src-tauri/src/leetify.rs). On first use the store reads the
// host's status, takes the host's copy when there is one (the page was reloaded within the session), and
// otherwise fetches. After that it fetches only when the user presses Refresh or connects. The host spaces
// and limits the requests.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toFailure, type LeetifyBridge, type LeetifyFailure, type LeetifyPayload, type LeetifyStatus } from "../../../host/leetify";
import { useData } from "../provider";
import { hideLeetifyData, hideLeetifyStatus, hideText, useHidePersonal } from "../privacy";
import { LeetifyShapeError, parsePayload, type LeetifyData, type LeetifyMatch } from "./api";
import type { MatchEntry } from "../match";
import { joinMatches, type Joined } from "./join";

export type LeetifyBusy = "connect" | "refresh" | "key" | "disconnect";

export interface LeetifyState {
  /** the first status and the host's copy have not arrived yet */
  starting: boolean;
  status: LeetifyStatus | null;
  data: LeetifyData | null;
  busy: LeetifyBusy | null;
  /** the last action's failure */
  error: LeetifyFailure | null;
  /**
   * The last fetch's failure (a refresh, or the fetch after connecting); null once one succeeds. While it
   * is set, `data` is the copy from before and is not current, so no view shows it (leetifyPhase).
   */
  fetchError: LeetifyFailure | null;
}

const INITIAL: LeetifyState = { starting: true, status: null, data: null, busy: null, error: null, fetchError: null };

export class LeetifyStore {
  private st: LeetifyState = INITIAL;
  private readonly subs = new Set<() => void>();
  private started = false;
  constructor(private readonly bridge: LeetifyBridge) {}

  get = () => this.st;
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  private set(p: Partial<LeetifyState>) {
    this.st = { ...this.st, ...p };
    for (const fn of this.subs) fn();
  }

  /** Reads the status and the host's copy once, and fetches when the host has none. */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    return this.boot();
  }
  private async boot() {
    try {
      const status = await this.bridge.status();
      this.set({ status });
      if (!status.player) return;
      const held = await this.bridge.load(false);
      // a copy this page cannot read is dropped by apply, and fetched again here
      const readable = held !== null && (await this.apply(held));
      if (!readable) await this.run("refresh", () => this.fetch());
    } catch (e) {
      this.set({ error: toFailure(e) });
    } finally {
      this.set({ starting: false });
    }
  }

  /**
   * Reads a payload; whether it could be read. A reply in a shape the app does not read is a bad_response
   * failure with no data at all, never part of it, and the host drops its copy so a retry fetches anew.
   */
  private async apply(p: LeetifyPayload | null): Promise<boolean> {
    if (!p) { this.set({ data: null }); return true; }
    try {
      this.set({ data: parsePayload(p) });
      return true;
    } catch (e) {
      if (!(e instanceof LeetifyShapeError)) throw e;
      this.set({ data: null, error: { kind: "bad_response", message: e.message, retryAfterS: null } });
      try { await this.bridge.discard(); } catch { /* the error above already stands */ }
      return false;
    }
  }
  private async fetch() {
    await this.apply(await this.bridge.load(true));
  }

  /** Runs one action at a time; returns whether it succeeded. The status is re-read after each. */
  private async run(busy: LeetifyBusy, f: () => Promise<void>): Promise<boolean> {
    if (this.st.busy) return false;
    this.set({ busy, error: null });
    let ok = false;
    try {
      await f();
      ok = this.st.error === null;
    } catch (e) {
      const raw = toFailure(e);
      const error = raw.kind === "rate_limited" && raw.retryAfterS !== null ? { ...raw, retryAt: Date.now() + raw.retryAfterS * 1000 } : raw;
      // the host dropped its copy: Leetify no longer returns this player
      this.set(error.kind === "not_found" || error.kind === "private" ? { error, data: null } : { error });
    }
    if (busy === "refresh" || busy === "connect") this.set({ fetchError: ok ? null : this.st.error });
    try { this.set({ status: await this.bridge.status() }); } catch { /* the action's own result stands */ }
    this.set({ busy: null });
    return ok;
  }

  refresh = () => this.run("refresh", () => this.fetch());
  /** Saves the key first when one is given (a key Leetify refuses stops here), then connects and fetches. */
  connect = (player: string, key: string | null) => this.run("connect", async () => {
    if (key) await this.bridge.saveKey(key);
    await this.bridge.connect(player);
    this.set({ data: null });
    await this.fetch();
  });
  saveKey = (key: string) => this.run("key", () => this.bridge.saveKey(key));
  clearKey = () => this.run("key", () => this.bridge.clearKey());
  /**
   * The host drops the data before it touches the key store, so the data goes here as soon as Disconnect
   * is attempted, even when removing the key fails; that failure still shows.
   */
  disconnect = () => this.run("disconnect", async () => {
    try {
      await this.bridge.disconnect();
    } finally {
      this.set({ data: null, fetchError: null });
    }
  });
}

/**
 * What a Leetify view may show: "none" (no bridge on this host, or the status is not in yet), "off" (no
 * player connected), "loading" (a fetch is running, the first or a refresh), "failed" (the last fetch
 * failed), or "ready". A view shows Leetify's numbers only when ready: during a refresh and after a failed
 * one the copy it has is not current, so it shows the fetch's progress or its failure instead.
 */
export type LeetifyPhase = "none" | "off" | "loading" | "failed" | "ready";
export function leetifyPhase(state: LeetifyState | null): LeetifyPhase {
  if (!state) return "none";
  if (!state.status) return state.error ? "failed" : "none";
  if (!state.status.player) return "off";
  if (state.starting || state.busy === "refresh" || state.busy === "connect") return "loading";
  if (state.fetchError) return "failed";
  if (state.data) return "ready";
  return state.error ? "failed" : "loading";
}

/**
 * Whose Leetify data this is, against the player whose matches are here (Data.you, the recording player's
 * SteamIDs): "you" when the profile's SteamID is among them, "other" when it is not, "unknown" with no
 * matches here to say. Anyone's public profile can be connected; only "you" (or "unknown", where there
 * is nothing of ours to compare) may sit beside our numbers or join our matches.
 */
export type LeetifyOwner = "you" | "other" | "unknown";
export function leetifyOwner(steam64: string, you: readonly string[]): LeetifyOwner {
  if (!you.length) return "unknown";
  return you.includes(steam64) ? "you" : "other";
}

/**
 * The join, or none for another player's data, whose matches are not the ones here. `data` is the copy
 * before privacy.ts masks it: the join compares each demo's recording player with the profile's SteamID.
 */
export function joinFor(data: LeetifyData, entries: MatchEntry[], owner: LeetifyOwner): Joined {
  return owner === "other" ? { byFile: new Map(), only: [] } : joinMatches(data.matches, entries, data.profile.steam64);
}

/** A join over the unmasked copy, its matches swapped for the same matches (by Leetify id) in `shown`. */
function shownJoin(j: Joined, shown: LeetifyData): Joined {
  const byId = new Map(shown.matches.map((m) => [m.id, m]));
  const swap = (m: LeetifyMatch) => {
    const s = byId.get(m.id);
    if (!s) throw new Error(`Leetify match ${m.id} is in the join but not in the data shown`);
    return s;
  };
  return { byFile: new Map([...j.byFile].map(([f, v]) => [f, { ...v, match: swap(v.match) }])), only: j.only.map(swap) };
}

const stores = new WeakMap<LeetifyBridge, LeetifyStore>();
export function leetifyStore(bridge: LeetifyBridge): LeetifyStore {
  let s = stores.get(bridge);
  if (!s) { s = new LeetifyStore(bridge); stores.set(bridge, s); }
  return s;
}

const noSubscribe = () => () => {};
const noState = () => null;

/**
 * The Leetify state with personal info hidden when the setting asks (privacy.ts), whose data it is (read
 * before hiding, which replaces the SteamID), and its actions; null where the host has no Leetify bridge
 * (a web build without the dev stand-in).
 */
export function useLeetify(): { state: LeetifyState; store: LeetifyStore; owner: LeetifyOwner; joined: Joined | null } | null {
  const { host, you, matches } = useData();
  const store = host?.leetify ? leetifyStore(host.leetify) : null;
  useEffect(() => { void store?.start(); }, [store]);
  const raw = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.get ?? noState);
  const hide = useHidePersonal();
  const owner = raw?.data ? leetifyOwner(raw.data.profile.steam64, you) : "unknown";
  const state = useMemo(() => (raw && hide ? {
    ...raw,
    status: raw.status && hideLeetifyStatus(raw.status),
    data: raw.data && hideLeetifyData(raw.data, owner !== "other"),
    error: raw.error && { ...raw.error, message: hideText(raw.error.message) },
    fetchError: raw.fetchError && { ...raw.fetchError, message: hideText(raw.fetchError.message) },
  } : raw), [raw, hide, owner]);
  // the join reads the real SteamIDs, then hands the views the masked matches
  const rawData = raw?.data ?? null;
  const shown = state?.data ?? null;
  const joined = useMemo(() => (rawData && shown ? shownJoin(joinFor(rawData, matches, owner), shown) : null), [rawData, shown, matches, owner]);
  return store && state ? { state, store, owner, joined } : null;
}

/** The connected player's data joined to the local matches (joinFor); null until there is data. */
export function useLeetifyJoin(): { data: LeetifyData; joined: Joined; synthetic: boolean; owner: LeetifyOwner } | null {
  const l = useLeetify();
  const data = l?.state.data ?? null;
  const joined = l?.joined ?? null;
  const synthetic = !!l?.state.status?.synthetic;
  const owner = l?.owner ?? "unknown";
  return useMemo(() => (data && joined ? { data, joined, synthetic, owner } : null), [data, joined, synthetic, owner]);
}
