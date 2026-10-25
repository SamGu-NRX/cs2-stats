import type { FileEntry } from "../host/host";
import type { PosAgg } from "../stats/positions";
import type { MatchSummary, MatchView } from "../stats/derive";
import type { ProfileFilter, ProfileView } from "../stats/profile";

/** Summary without positions: what the UI and the profile keep in memory. */
export type LightSummary = Omit<MatchSummary, "pos">;

export interface Api {
  sync(entries: FileEntry[]): { summaries: LightSummary[]; errors: { file: string; message: string }[] };
  match(file: string): MatchView;
  profile(filter: ProfileFilter): ProfileView | null;
  profilePositions(map: string): PosAgg;
  modelInfo(): { kind: "stub" | "model"; label: string; error: string | null };
}

export type Method = keyof Api;

export type ToWorker =
  | { id: number; method: Method; args: unknown[] }
  | { rid: number; bytes?: ArrayBuffer; error?: string };

export type FromWorker =
  | { id: number; result?: unknown; error?: string }
  | { rid: number; need: string }
  | { progress: { done: number; total: number } };
