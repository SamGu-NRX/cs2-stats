// An attribute's score against the opponents, apart from opponents.ts so the UI can import it without
// the metrics and the rollup.
import type { VsOpponents } from "./opponents";

/**
 * The mean of the metrics' shares of opponents beaten (VsOpponents.pct), as attributes() scores an
 * attribute against a baseline pool, over the metrics that have one; null when none has. `rows` is
 * the opponents call's answer, which has a row for every metric, so an id without one is a mistake.
 */
export function opponentScore(rows: VsOpponents[], metricIds: string[]): number | null {
  const by = new Map(rows.map((r) => [r.id, r]));
  const pcts = metricIds.map((id) => {
    const r = by.get(id);
    if (!r) throw new Error(`opponentScore: no row for metric "${id}"`);
    return r.pct;
  }).filter((x): x is number => x !== null);
  return pcts.length ? pcts.reduce((s, x) => s + x, 0) / pcts.length : null;
}
