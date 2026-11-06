// Where each moment stands: which demo it needs and whether that demo is on disk, whether HLAE has
// recorded it, and whether a finished clip exists. Real data only: a moment whose match has no demo
// says why rather than offering a render.
import { isLocalFile, sourceOf } from "../ui/data/sources";
import type { MatchEntry } from "../ui/data/match";
import type { ClipsScan, DemoOnDisk, Take } from "./host";

/**
 * The folder a demo is in (src-tauri clips/job.rs DemoRoot): CS2's replays folder for a Valve match,
 * the demos store (%APPDATA%\BotMatchStats\demos) for a Bot Mode match CS2 recorded.
 */
export type DemoRoot = "replays" | "demos";

/** The demo a match's moments need, in its folder, or none and why. */
export type DemoSource = { kind: "demo"; root: DemoRoot; name: string } | { kind: "none"; why: string };

/** One demo as the lookup keys it: two folders can hold the same file name. */
export const demoKey = (d: { root: DemoRoot; name: string }) => `${d.root}/${d.name}`;

const VALVE_DEMO = /^valve\/([A-Za-z0-9_.-]+)\//;
/** A recorded demo's tables are under its id (local/<id>/<version>); the demo is <id>.dem in the store. */
const LOCAL_DEMO = /^local\/([A-Za-z0-9_]+)\//;

/**
 * Why a plugin match has no demo, worded for the Bot Mode matches the plugin records. A match CS2 also
 * recorded pairs with its demo (data/local.ts) and is listed as the demo, so a plugin entry here has none.
 */
export const NO_LOCAL_DEMO = "No demo of this match was recorded. Bot Mode records one when Record demos (GOTV) is on.";

export function demoSource(e: Pick<MatchEntry, "file" | "origin" | "hasAim" | "hasPos" | "match">): DemoSource {
  const valve = VALVE_DEMO.exec(e.file);
  if (valve && e.match.source === "valve") return { kind: "demo", root: "replays", name: `${valve[1]}.dem` };
  const local = isLocalFile(e.file) ? LOCAL_DEMO.exec(e.file) : null;
  if (local && e.match.source === "local") return { kind: "demo", root: "demos", name: `${local[1]}.dem` };
  switch (sourceOf(e).id) {
    case "recorded": return { kind: "none", why: NO_LOCAL_DEMO };
    case "local": return { kind: "none", why: "This recorded demo's folder does not name its demo." };
    case "converted": return { kind: "none", why: "A converted console log has no demo." };
    case "synthetic": return { kind: "none", why: "The generated demo match has no demo file." };
    case "pro": return { kind: "none", why: "The pro-demo pipeline deletes each demo once it is extracted." };
    case "valve": return { kind: "none", why: "This Valve match's folder does not name its demo." };
  }
}

export type ClipState =
  | { kind: "rendered"; path: string }
  | { kind: "recorded"; take: Take }
  | { kind: "ready"; demoPath: string }
  | { kind: "no-demo"; why: string }
  | { kind: "unchecked"; why: string };

/** What the host has said about the demos and the clips folder: null before it answers or without a host, with why. */
export interface Lookup { demos: Map<string, DemoOnDisk> | null; scan: ClipsScan | null; why: string | null }

/**
 * A moment's state, first that applies: a finished clip; a take HLAE recorded (the newest); its demo
 * on disk; else why it cannot be rendered.
 */
export function clipState(id: string, src: DemoSource, look: Lookup): ClipState {
  const done = look.scan?.finished.find((f) => f.id === id);
  if (done) return { kind: "rendered", path: done.path };
  const takes = look.scan?.takes.filter((t) => t.id === id) ?? [];
  if (takes.length) return { kind: "recorded", take: takes.reduce((a, b) => (b.mtime > a.mtime ? b : a)) };
  if (src.kind === "none") return { kind: "no-demo", why: src.why };
  if (!look.demos) return { kind: "unchecked", why: look.why ?? "Demos are checked by the desktop app." };
  const d = look.demos.get(demoKey(src));
  if (d?.path) return { kind: "ready", demoPath: d.path };
  return { kind: "no-demo", why: src.root === "demos"
    ? "This match's demo is no longer kept: it was let go to keep the demos folder under its cap. Pin a demo in Data & settings to keep it."
    : `${src.name} is not in CS2's replays folder any more. Download the match's demo again to clip it.` };
}

/** What "round impact" means, for the tooltip wherever a moment's reason shows. */
export const ROUND_IMPACT_TIP = "Round impact adds up the win-probability credit your kills earned in the round (round swing). It can pass 100% when the round swings back and forth.";

export const STATE_LABEL: Record<ClipState["kind"], string> = {
  rendered: "Rendered", recorded: "Recorded", ready: "Ready to render", "no-demo": "Needs a demo", unchecked: "Demo not checked",
};
