// A player's metrics next to the opponents they faced in the same matches, alongside the pro
// baselines (compare.ts). Opponents share the player's rounds, maps and economy, so this is the
// fairest "how did I do" line for a single match.
import type { MatchFacts } from "./facts";
import { METRICS } from "./metrics";
import { playedMatch } from "./roster";
import { rollup, type Filter, type Summary } from "./rollup";

export interface VsOpponents {
  id: string;
  mine: number | null;
  /** mean over the opponents who have a value */
  opponents: number | null;
  /** 1 = best; null for identity metrics, which have no better or worse */
  rank: number | null;
  of: number;
}

/**
 * The players `me` faced in one match: on the other team, and each played a round of it (roster.ts
 * playedMatch). None when `me` played no round of it.
 */
export function opponentsIn(f: MatchFacts, me: ReadonlySet<string>): string[] {
  const mine = f.players.find((p) => me.has(p.id) && playedMatch(f, p.id));
  return mine ? f.players.filter((p) => p.team !== null && p.team !== mine.team && playedMatch(f, p.id)).map((p) => p.id) : [];
}

/** For one player: each metric against the opponents over the same matches and filter. */
export function vsOpponents(facts: MatchFacts[], filter: Filter): VsOpponents[] {
  const me = new Set(Array.isArray(filter.player) ? filter.player : [filter.player]);
  const opp = new Set(facts.flatMap((f) => opponentsIn(f, me)));
  return vsOpponentsOf(rollup(facts, filter), [...opp].map((id) => rollup(facts, { ...filter, player: id })));
}

/** The same from summaries: the player's, and each opponent's over the same matches and filter. */
export function vsOpponentsOf(mineS: Summary, theirs: Summary[]): VsOpponents[] {
  return METRICS.map((m) => {
    const v = m.value(mineS);
    const o = theirs.map((s) => m.value(s)).filter((x): x is number => x !== null);
    const better = (a: number, b: number) => (m.lowerIsBetter ? a < b : a > b);
    return {
      id: m.id, mine: v, opponents: o.length ? o.reduce((s, x) => s + x, 0) / o.length : null,
      rank: m.kind === "performance" && v !== null ? 1 + o.filter((x) => better(x, v)).length : null, of: o.length + 1,
    };
  });
}
