// The Leetify import's state for the views: whether a player is connected, the last copy of their data,
// what is running, and the last failure. One store per bridge, so Data & settings, Profile, Matches and
// the match page share one copy and one set of requests.
//
// On first use the store reads the host's status and its cached copy, and asks for a refresh when the
// copy is older than FRESH_MS. Leetify's guidelines ask apps to rely on the API's current data rather than
// a stored copy, so a copy is shown as it is only while it is fresh; the host keeps it no longer than a
// day and spaces and limits the requests (src-tauri/src/leetify.rs).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toFailure, type LeetifyBridge, type LeetifyFailure, type LeetifyPayload, type LeetifyStatus } from "../../../host/leetify";
import { useData } from "../provider";
import { hideLeetifyData, hideLeetifyStatus, hideText, useHidePersonal } from "../privacy";
import { LeetifyShapeError, parsePayload, type LeetifyData } from "./api";
import { joinMatches, type Joined } from "./join";

/**
 * A copy younger than this is not refreshed when a view opens. Ten minutes: Leetify analyses a match
 * some minutes after it ends, so refreshing more often finds nothing new; there is no measurement behind
 * the number.
 */
export const FRESH_MS = 10 * 60 * 1000;

export type LeetifyBusy = "connect" | "refresh" | "key" | "disconnect";

export interface LeetifyState {
  /** the first status and cached copy have not arrived yet */
  starting: boolean;
  status: LeetifyStatus | null;
  data: LeetifyData | null;
  busy: LeetifyBusy | null;
  error: LeetifyFailure | null;
}

const INITIAL: LeetifyState = { starting: true, status: null, data: null, busy: null, error: null };

export class LeetifyStore {
  private st: LeetifyState = INITIAL;
  private readonly subs = new Set<() => void>();
  private started = false;
  constructor(private readonly bridge: LeetifyBridge, private readonly now: () => number = Date.now) {}

  get = () => this.st;
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  private set(p: Partial<LeetifyState>) {
    this.st = { ...this.st, ...p };
    for (const fn of this.subs) fn();
  }

  /** Reads the status and the cached copy once, then refreshes a copy that is missing or stale. */
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
      const cached = await this.bridge.load(false);
      this.apply(cached);
      if (!cached || this.now() - cached.fetchedAt >= FRESH_MS) await this.run("refresh", () => this.fetch());
    } catch (e) {
      this.set({ error: toFailure(e) });
    } finally {
      this.set({ starting: false });
    }
  }

  /** Reads a payload; a reply in a shape the app does not read is a bad_response failure, with no data. */
  private apply(p: LeetifyPayload | null) {
    if (!p) { this.set({ data: null }); return; }
    try {
      this.set({ data: parsePayload(p) });
    } catch (e) {
      if (!(e instanceof LeetifyShapeError)) throw e;
      this.set({ data: null, error: { kind: "bad_response", message: e.message, retryAfterS: null } });
    }
  }
  private async fetch() {
    this.apply(await this.bridge.load(true));
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
      const error = toFailure(e);
      // the host deleted its copy: Leetify no longer returns this player
      this.set(error.kind === "not_found" || error.kind === "private" ? { error, data: null } : { error });
    }
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
  disconnect = () => this.run("disconnect", async () => {
    await this.bridge.disconnect();
    this.set({ data: null });
  });
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
 * The Leetify state with personal info hidden when the setting asks (privacy.ts), and its actions; null
 * where the host has no Leetify bridge (a web build without the dev stand-in).
 */
export function useLeetify(): { state: LeetifyState; store: LeetifyStore } | null {
  const { host } = useData();
  const store = host?.leetify ? leetifyStore(host.leetify) : null;
  useEffect(() => { void store?.start(); }, [store]);
  const raw = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.get ?? noState);
  const hide = useHidePersonal();
  const state = useMemo(() => (raw && hide ? {
    ...raw,
    status: raw.status && hideLeetifyStatus(raw.status),
    data: raw.data && hideLeetifyData(raw.data),
    error: raw.error && { ...raw.error, message: hideText(raw.error.message) },
  } : raw), [raw, hide]);
  return store && state ? { state, store } : null;
}

/** The connected player's data joined to the local matches (join.ts); null until there is data. */
export function useLeetifyJoin(): { data: LeetifyData; joined: Joined; synthetic: boolean } | null {
  const l = useLeetify();
  const { matches } = useData();
  const data = l?.state.data ?? null;
  const synthetic = !!l?.state.status?.synthetic;
  return useMemo(() => (data ? { data, joined: joinMatches(data.matches, matches), synthetic } : null), [data, matches, synthetic]);
}
