// Recorded demos paired with the plugin files of the same matches (design/recording.md, "Linking a demo
// to its plugin file"). With recording on, a Bot Mode match is in the list twice: the capture plugin's
// file ("recorded") and the demo CS2 recorded ("local"). Paired, the demo entry is the match: career,
// records and the Matches list drop the plugin entry (engine.ts), and aim views keep whichever of the two
// has the shots (engine.ts aimEntries). Nothing else is merged.
//
// Two rules, in order:
// 1. Rounds. Same map, and the gaps between consecutive freeze-end ticks are equal over the rounds both
//    hold (MatchEntry.freeze, which leaves out the plugin's partial rounds). The two files count ticks
//    from different starts, so only the gaps are compared. At least MIN_GAPS gaps must be shared.
// 2. Time, for what rule 1 left unpaired when too few gaps are shared to tell. Same map; the demo starts
//    before the plugin's match, by at most MAX_LEAD_MS; no other demo of that map starts between them,
//    and no other plugin file of that map starts between them either, so one demo never stands for two
//    matches. A demo and plugin file whose shared gaps disagree are two matches, and never pair by time.
//
// A pairing that rule 1 finds twice over (one demo agreeing with two plugin files, or the reverse) is
// left unpaired: both entries stay listed rather than one being dropped on a guess.
import type { MatchEntry } from "./match";
import { startMs } from "./match";
import { sourceOf } from "./sources";

/**
 * The fewest freeze-end gaps two files must share to pair by rounds. Ours, with no measurement behind it:
 * a round's gap varies with how and when it ended, so one or two equal gaps can happen by chance between
 * different matches of one map, and three are far less likely to.
 */
export const MIN_GAPS = 3;

/**
 * The longest a demo may start before the plugin's match for the two to pair by time. tv_autorecord
 * starts with warmup, minutes before the match; an hour is ours, with no measurement, and keeps a demo
 * from days earlier, whose own plugin file is gone, from standing in for a later match.
 */
export const MAX_LEAD_MS = 60 * 60 * 1000;

export type PairHow = "rounds" | "time";
/** A recorded demo's entry and the plugin entry of the same match, by file. */
export interface Pair { demo: string; plugin: string; how: PairHow }
export interface Pairing { byDemo: Map<string, Pair>; byPlugin: Map<string, Pair> }

type Entry = Pick<MatchEntry, "file" | "origin" | "hasAim" | "hasPos" | "match" | "freeze">;

/** Round number to the gap from its freeze end to the next round's, for rounds whose next round is held too. */
function gapsOf(freeze: [number, number][]): Map<number, number> {
  const at = new Map(freeze);
  const out = new Map<number, number>();
  for (const [round, tick] of freeze) {
    const next = at.get(round + 1);
    if (next !== undefined) out.set(round, next - tick);
  }
  return out;
}

/** How many gaps two files share by round number, and whether every shared one is equal. */
export function compareGaps(a: [number, number][], b: [number, number][]): { shared: number; agree: boolean } {
  const ga = gapsOf(a), gb = gapsOf(b);
  let shared = 0, agree = true;
  for (const [round, gap] of ga) {
    const other = gb.get(round);
    if (other === undefined) continue;
    shared++;
    if (other !== gap) agree = false;
  }
  return { shared, agree };
}

/** The pairs among `all`: every recorded demo matched to at most one plugin file, and the reverse. */
export function pairEntries(all: readonly Entry[]): Pairing {
  const demos = all.filter((e) => sourceOf(e).id === "local");
  const plugins = all.filter((e) => sourceOf(e).id === "recorded");
  const pairs: Pair[] = [];

  // 1. rounds: each side's only agreeing partner
  const agreeing = new Map<string, string[]>();
  const contradicted = new Set<string>();
  for (const d of demos) {
    for (const p of plugins) {
      if (p.match.map !== d.match.map) continue;
      const c = compareGaps(d.freeze, p.freeze);
      if (c.shared < MIN_GAPS) continue;
      if (!c.agree) { contradicted.add(`${d.file}\n${p.file}`); continue; }
      agreeing.set(d.file, [...(agreeing.get(d.file) ?? []), p.file]);
      agreeing.set(p.file, [...(agreeing.get(p.file) ?? []), d.file]);
    }
  }
  for (const d of demos) {
    const ps = agreeing.get(d.file) ?? [];
    if (ps.length === 1 && agreeing.get(ps[0])?.length === 1) pairs.push({ demo: d.file, plugin: ps[0], how: "rounds" });
  }

  // 2. time, among what rule 1 left: neither side agreed with anything (an ambiguous one stays unpaired)
  const open = (e: Entry) => !agreeing.has(e.file);
  const startOf = (e: Entry) => (e.match.startedAt ? startMs(e.match) : null);
  for (const p of plugins.filter(open)) {
    const ps = startOf(p);
    if (ps === null) continue;
    const sameMap = (e: Entry) => e.match.map === p.match.map;
    // the latest demo of the map that starts before the match; a demo between them, paired or not, is the nearer one
    const before = demos.filter((d) => sameMap(d) && (startOf(d) ?? Infinity) < ps);
    if (!before.length) continue;
    const d = before.reduce((a, b) => (startOf(b)! > startOf(a)! ? b : a));
    const ds = startOf(d)!;
    if (!open(d) || ps - ds > MAX_LEAD_MS || contradicted.has(`${d.file}\n${p.file}`)) continue;
    if (before.some((x) => x !== d && startOf(x) === ds)) continue;
    // no other plugin file of the map starts between them, so the demo stands for this match only
    if (plugins.some((x) => x !== p && sameMap(x) && (startOf(x) ?? -Infinity) > ds && startOf(x)! <= ps)) continue;
    pairs.push({ demo: d.file, plugin: p.file, how: "time" });
  }

  return { byDemo: new Map(pairs.map((x) => [x.demo, x])), byPlugin: new Map(pairs.map((x) => [x.plugin, x])) };
}

const cache = new WeakMap<readonly Entry[], Pairing>();
/** pairEntries, computed once per list: the provider hands every view the same array until a rescan. */
export function pairing(all: readonly Entry[]): Pairing {
  let p = cache.get(all);
  if (!p) cache.set(all, (p = pairEntries(all)));
  return p;
}
