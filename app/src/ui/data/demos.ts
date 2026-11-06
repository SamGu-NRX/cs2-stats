// The recorded demos as the app sees them (design/recording.md): which ones the engine wants kept,
// and each demo's row for the Demos card with what only the app knows, its match and its best moment.
// The host keeps the store and enforces the limits (src-tauri demos.rs); this module decides nothing
// about disk space.
import type { DemoRow, Keep } from "../../host/demos";
import { POINTS } from "../../stats/moments";
import type { MomentRow } from "../../worker/protocol";
import { pairing, type PairHow } from "./local";
import type { MatchEntry } from "./match";
import { isLocalFile } from "./sources";

/** The keep reason demos.rs records for a demo the engine names. */
export const MOMENT_KEEP = "moment";

/** A recorded demo's id from its tables' path, "local/<id>/<version>"; null for any other file. */
export const demoIdOf = (file: string): string | null => (isLocalFile(file) ? file.split("/")[1] ?? null : null);

/**
 * The demos the engine wants kept: each with an unrendered moment scoring at least a 3K (POINTS.k3),
 * for demos_sweep. `rendered` holds the clip ids already rendered; null when the clips folder could not
 * be read, and then no moment counts as rendered, so nothing is let go on a guess. A demo whose tables
 * are not in `entries` (they failed to load) keeps the keep it had: its moments are unknown, not gone.
 *
 * The host replaces its whole list with this one, so it names every such demo, not only new ones.
 */
export function keepDecisions(demos: Pick<DemoRow, "id" | "state" | "kept">[], entries: Pick<MatchEntry, "file">[], moments: Pick<MomentRow, "file" | "id" | "score">[], rendered: Set<string> | null): Keep[] {
  const loaded = new Set(entries.flatMap((e) => { const id = demoIdOf(e.file); return id ? [id] : []; }));
  const worth = new Set(moments.filter((m) => m.score >= POINTS.k3 && !rendered?.has(m.id)).flatMap((m) => { const id = demoIdOf(m.file); return id ? [id] : []; }));
  return demos
    .filter((d) => d.state !== "missing")
    .filter((d) => (loaded.has(d.id) ? worth.has(d.id) : d.kept === MOMENT_KEEP))
    .map((d) => ({ id: d.id, reason: MOMENT_KEEP }));
}

/** Why a demo is kept, as the card groups them. */
export type KeptAs = "pinned" | "moment" | "recent" | "waiting" | "retry" | "unswept" | "missing";
export const KEPT_LABEL: Record<KeptAs, string> = {
  pinned: "Pinned", moment: "Clips to render", recent: "Newest", waiting: "Waiting to extract", retry: "Failed, kept for a retry", unswept: "Not swept yet", missing: "Deleted outside the app",
};
/** The order the card lists the groups in: what the user chose, then what the engine and the limits keep. */
export const KEPT_ORDER: KeptAs[] = ["pinned", "moment", "recent", "waiting", "retry", "unswept", "missing"];

/** A demo's group, from its pin, state and the reason the last sweep recorded (demos.rs plan_sweep). */
export function keptAs(d: Pick<DemoRow, "pinned" | "state" | "kept">): KeptAs {
  if (d.state === "missing") return "missing";
  if (d.pinned) return "pinned";
  if (d.kept === MOMENT_KEEP) return "moment";
  if (d.kept === "recent") return "recent";
  if (d.state === "taken") return "waiting";
  if (d.state === "failed") return "retry";
  return "unswept";
}

/** What the card shows for one demo, with the app's part filled in. */
export interface DemoView extends DemoRow {
  as: KeptAs;
  /** the match these tables are: its entry's file, result and score, and how its plugin file paired with it; null before extraction or when the tables are not listed */
  pairedMatch: { file: string; result: MatchEntry["result"]; score: MatchEntry["score"]; plugin: PairHow | null } | null;
  /** the best moment's score (stats/moments.ts POINTS) and reason; null without moments */
  bestMomentScore: number | null;
  bestMoment: string | null;
}

/** The card's rows: the host's, newest first, each with its match and best moment from the app's own lists. */
export function demoViews(demos: DemoRow[], all: MatchEntry[], moments: MomentRow[]): DemoView[] {
  const pairs = pairing(all);
  const byId = new Map(all.flatMap((e) => { const id = demoIdOf(e.file); return id ? [[id, e] as const] : []; }));
  const best = new Map<string, MomentRow>();
  for (const m of moments) {
    const id = demoIdOf(m.file);
    if (id && m.score > (best.get(id)?.score ?? -Infinity)) best.set(id, m);
  }
  return demos.map((d) => {
    const e = byId.get(d.id);
    const b = best.get(d.id);
    return {
      ...d, as: keptAs(d),
      pairedMatch: e ? { file: e.file, result: e.result, score: e.score, plugin: pairs.byDemo.get(e.file)?.how ?? null } : null,
      bestMomentScore: b?.score ?? null, bestMoment: b?.reason ?? null,
    };
  });
}

/** Bytes and count per group, in KEPT_ORDER, leaving out empty groups. A missing demo takes no space. */
export function keptTotals(views: Pick<DemoView, "as" | "size">[]): { as: KeptAs; n: number; bytes: number }[] {
  return KEPT_ORDER.map((as) => {
    const in_ = views.filter((v) => v.as === as);
    return { as, n: in_.length, bytes: as === "missing" ? 0 : in_.reduce((a, v) => a + v.size, 0) };
  }).filter((g) => g.n > 0);
}

/** local_import.py's failure reasons in plain words. */
export function failureText(reason: string | null): string {
  if (reason === "no_rounds") return "The demo holds no finished round, as when recording stopped in warmup.";
  if (reason === "extract_failed") return "The extractor could not read the demo.";
  return "The extractor stopped on it.";
}

/** "1.4 GB", "312 MB": bytes in the GB of the settings (2^30, as Windows counts them), rounded down. */
export function fmtSize(bytes: number): string {
  const GB = 2 ** 30, MB = 2 ** 20;
  if (bytes >= GB) return `${(Math.floor((bytes / GB) * 10) / 10).toFixed(1).replace(/\.0$/, "")} GB`;
  return `${Math.max(bytes ? 1 : 0, Math.floor(bytes / MB))} MB`;
}
