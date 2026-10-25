import type { FileEntry } from "../host/host";
import type { GunProficiency } from "../stats/guns";
import type { MatchFacts } from "../stats/facts";
import type { Rating3 } from "../stats/rating3";
import type { Filter, Summary } from "../stats/rollup";
import type { MatchEntry } from "../ui/data/match";

/** Which matches a question covers (the map and time filters, resolved to files) and whose rounds. */
export interface Query { files: string[]; filter: Filter }

/** Per side, as rating3BySide returns it. */
export type SideRatings = Record<"both" | "CT" | "T", Rating3>;

export interface Api {
  sync(entries: FileEntry[]): { matches: MatchEntry[]; errors: { file: string; message: string }[] };
  facts(file: string): MatchFacts;
  rollup(qs: Query[]): Summary[];
  ratings(qs: Query[]): SideRatings[];
  guns(q: Query): GunProficiency[];
  /** world [x, y] of the players' enemy kills (where the killer stood) and of their deaths */
  positions(q: Query): { kills: [number, number][]; deaths: [number, number][] };
}

export type Method = keyof Api;

export type ToWorker =
  | { id: number; method: Method; args: unknown[] }
  | { rid: number; bytes?: ArrayBuffer; error?: string };

export type FromWorker =
  | { id: number; result?: unknown; error?: string }
  | { rid: number; need: string }
  | { progress: { done: number; total: number } };
