// Where each moment stands: which demo it needs and whether that demo is on disk, whether HLAE has
// recorded it, and whether a finished clip exists. Real data only: a moment whose match has no demo
// says why rather than offering a render.
import { sourceOf } from "../ui/data/sources";
import type { MatchEntry } from "../ui/data/match";
import type { ClipsScan, DemoOnDisk, Take } from "./host";

/** The demo a match's moments need: a Valve match's demo in CS2's replays folder, or none and why. */
export type DemoSource = { kind: "demo"; name: string } | { kind: "none"; why: string };

const VALVE_DEMO = /^valve\/([A-Za-z0-9_.-]+)\//;

export function demoSource(e: Pick<MatchEntry, "file" | "origin" | "hasAim" | "hasPos" | "match">): DemoSource {
  const valve = VALVE_DEMO.exec(e.file);
  if (valve && e.match.source === "valve") return { kind: "demo", name: `${valve[1]}.dem` };
  switch (sourceOf(e).id) {
    case "recorded": return { kind: "none", why: "The plugin records match data, not a demo, so CS2 has nothing to play. Matches recorded with tv_autorecord on will have one." };
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
  const d = look.demos.get(src.name);
  if (d?.path) return { kind: "ready", demoPath: d.path };
  return { kind: "no-demo", why: `${src.name} is not in CS2's replays folder any more. Download the match's demo again to clip it.` };
}

export const STATE_LABEL: Record<ClipState["kind"], string> = {
  rendered: "Rendered", recorded: "Recorded", ready: "Ready to render", "no-demo": "Needs a demo", unchecked: "Demo not checked",
};
