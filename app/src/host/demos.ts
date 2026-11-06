// Typed calls to the recorded demos' commands in src-tauri/src/demos.rs; the types mirror the Rust
// structs' JSON. Only the desktop app has them. `vite dev` with ?demos=<scenario> gets the stand-in in
// demos-mock.ts instead, for screenshots; the import is dynamic and DEV-only, so a release build carries
// none of it.
import { isTauri } from "./host";

/** Where a demo is in its life (demos.rs State). */
export type DemoState = "taken" | "extracted" | "failed" | "missing";

/** One demo in the store, as the host keeps it (demos.rs DemoRow). */
export interface DemoRow {
  /** `<yyyymmddThhmmZ>_<map>_<sha8>`: nothing of the file's original name */
  id: string;
  map: string;
  createdUtc: string;
  size: number;
  state: DemoState;
  pinned: boolean;
  /** steam.inf's ClientVersion when it was taken: the build that can play it */
  gameBuild: string | null;
  /** local_import.py's reason for the last failure: "no_rounds" or "extract_failed" */
  failReason: string | null;
  failDetail: string | null;
  /** why the last sweep kept it: "pinned", a keep's reason ("moment"), "recent", "not extracted yet", or the failed-extraction reason */
  kept: string | null;
}

/** The store as the Data & settings card shows it (demos.rs DemoStore). Sizes are bytes. */
export interface DemoStore {
  folder: string;
  used: number;
  cap: number;
  floor: number;
  /** bytes free on the store's disk; null when it could not be read, and `freeError` says why */
  free: number | null;
  freeError: string | null;
  keepLast: number;
  recording: boolean;
  /** newest first */
  demos: DemoRow[];
  lastFailure: { id: string; reason: string | null; detail: string | null } | null;
  /**
   * Over the cap or under the floor with only demos a sweep never deletes left (pinned, not yet
   * extracted, waiting for a newer extractor): the host deletes nothing more, and the floor stops the
   * next recording. Null otherwise.
   */
  held: { overCap: boolean; underFloor: boolean } | null;
}

/** The cap and floor in GB (2^30 bytes) and how many of the newest demos are always kept (settings.rs DemoPolicy). */
export interface DemoPolicy { capGb: number; floorGb: number; keepLast: number }

/** A demo the app's engine wants kept, and why: "moment", an unrendered clip-worthy moment (data/demos.ts keepDecisions). */
export interface Keep { id: string; reason: string }

/** What an import did (demos.rs LocalImport). Demos are counted and named by id, never by their original name. */
export interface LocalImport {
  taken: { taken: string[]; waiting: number; refused: string[] } | null;
  takeError: string | null;
  extracted: string[];
  failed: string[];
  code: number | null;
  error: string | null;
}
/** One line of the importer's progress (extractor/local_import.py --progress). */
export interface LocalProgress { event: "start" | "done"; i: number; n: number; demo: string; ok?: boolean }

export interface DemosHost {
  status(): Promise<DemoStore>;
  /** `seen`: the policy as the card showed it; refused when it has changed since */
  setPolicy(policy: DemoPolicy, seen: DemoPolicy): Promise<DemoStore>;
  pin(id: string, on: boolean): Promise<DemoStore>;
  /** deletes the demo, pinned or not; its tables stay */
  remove(id: string): Promise<DemoStore>;
  /** replaces the engine's keeps and sweeps */
  sweep(keeps: Keep[]): Promise<DemoStore>;
  /** the ?demos= stand-in's own match results and moments for its rows, which have no tables (demos-mock.ts) */
  sample?: Record<string, import("./demos-mock").SampleFill>;
}

async function tauriDemos(): Promise<DemosHost> {
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    status: () => invoke("demos_status"),
    setPolicy: (policy, seen) => invoke("demos_set_policy", { policy, seen }),
    pin: (id, on) => invoke("demos_pin", { id, on }),
    remove: (id) => invoke("demos_delete", { id }),
    sweep: (keeps) => invoke("demos_sweep", { keeps }),
  };
}

let found: Promise<DemosHost | null> | null = null;
/** The desktop app's demos commands, the ?demos= stand-in in `vite dev`, else null. Found once. */
export function demosHost(): Promise<DemosHost | null> {
  found ??= (async () => {
    if (isTauri()) return tauriDemos();
    const scenario = import.meta.env.DEV ? new URLSearchParams(location.search).get("demos") : null;
    if (!scenario) return null;
    const { mockDemosHost } = await import("./demos-mock");
    return mockDemosHost(scenario);
  })();
  return found;
}
