// Messages between the UI thread and the replay worker (replay.worker.ts). Types only.
import type { RoundTimeline } from "../stats/replay";

export type ReplayToWorker =
  | { id: number; file: string; round: number }
  | { rid: number; bytes?: ArrayBuffer; error?: string };

export type ReplayFromWorker =
  | { id: number; result?: RoundTimeline; error?: string }
  | { rid: number; need: string };
