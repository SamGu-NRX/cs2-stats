// The Leetify import's bridge to the desktop host (src-tauri/src/leetify.rs). Requests, the API key and
// the session's copy of Leetify's data all live on the Rust side; the page sees whether a key is saved,
// never the key. Nothing from Leetify is written to disk.
//
// In `vite dev` with ?leetify=synthetic (or synthetic-new, starting disconnected), a stand-in bridge
// serves synthetic data (ui/data/leetify/synthetic.ts), labelled as such wherever it shows; a plain web
// build has no bridge.

export type LeetifyErrorKind =
  | "bad_key" | "not_found" | "private" | "rate_limited" | "network" | "server" | "bad_response" | "bad_input" | "key_store" | "storage";

/** A failure as the host reports it; `retryAfterS` only for rate_limited. */
export interface LeetifyFailure { kind: LeetifyErrorKind; message: string; retryAfterS: number | null }

/** Whose data to fetch: a SteamID64 or a Leetify user id. */
export interface LeetifyPlayer { kind: "steam" | "leetify"; id: string }

export interface LeetifyStatus {
  player: LeetifyPlayer | null;
  hasKey: boolean;
  /** the machine can keep a key (Windows Credential Manager) */
  keyStore: boolean;
  /** why the saved key could not be read */
  keyError: string | null;
  /** seconds left in a pause Leetify asked for */
  cooldownS: number | null;
  /** the data is the dev build's synthetic stand-in */
  synthetic?: boolean;
}

/** The host's in-memory copy: the two replies as Leetify sent them, unchecked (ui/data/leetify/api.ts checks them). */
export interface LeetifyPayload { player: LeetifyPlayer; fetchedAt: number; profile: unknown; matches: unknown }

export interface LeetifyBridge {
  status(): Promise<LeetifyStatus>;
  /** checks the key with Leetify, then saves it in the key store */
  saveKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  connect(player: string): Promise<LeetifyPlayer>;
  /** forgets the player, drops the data from memory and removes the key */
  disconnect(): Promise<void>;
  /** the copy in memory, or with refresh a new fetch; null when no player is connected or nothing was fetched this session */
  load(refresh: boolean): Promise<LeetifyPayload | null>;
  /** drops the host's copy, which the page could not read, so the next load fetches */
  discard(): Promise<void>;
  /** Leetify's "Data provided by" badge as PNG bytes, fetched by the host (src-tauri/src/leetify.rs, "the badge"); null when it has none */
  badge(): Promise<ArrayBuffer | null>;
}

const KINDS = new Set<string>(["bad_key", "not_found", "private", "rate_limited", "network", "server", "bad_response", "bad_input", "key_store", "storage"]);

/** Whatever a bridge call rejected with, as a failure: the host's own error object, or anything else as a storage failure carrying its text. */
export function toFailure(e: unknown): LeetifyFailure {
  if (e && typeof e === "object" && "kind" in e && typeof e.kind === "string" && KINDS.has(e.kind)) {
    const o = e as { kind: LeetifyErrorKind; message?: unknown; retryAfterS?: unknown };
    return { kind: o.kind, message: typeof o.message === "string" ? o.message : "", retryAfterS: typeof o.retryAfterS === "number" ? o.retryAfterS : null };
  }
  return { kind: "storage", message: e instanceof Error ? e.message : String(e), retryAfterS: null };
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The desktop bridge: one Tauri command per method. */
export function tauriLeetify(invoke: Invoke): LeetifyBridge {
  return {
    status: () => invoke("leetify_status"),
    saveKey: (key) => invoke("leetify_save_key", { key }),
    clearKey: () => invoke("leetify_clear_key"),
    connect: (player) => invoke("leetify_connect", { player }),
    disconnect: () => invoke("leetify_disconnect"),
    load: (refresh) => invoke("leetify_load", { refresh }),
    discard: () => invoke("leetify_discard"),
    badge: async () => {
      const b = await invoke<ArrayBuffer>("leetify_badge");
      return b.byteLength ? b : null;
    },
  };
}
