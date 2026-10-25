// Team spacing, as in Jamie Packer's CS2 playstyle dataset (2024, CC BY 4.0; research-playstyle-viz.md):
// every 3 s from 10 s after freeze end, before the plant, while all five players of the side are alive,
// rank each player within their team by distance to the nearest teammate (ADNT) and by distance to
// the team's centre (ADAT). Ranks run 0.2 (closest) to 1.0 (farthest). The nearest-teammate distance
// itself is summed too (nearestDistSum), for the role card's Lurker signal (identity.ts ROLE_SIGNALS).
//
// Packer ranks the map-level means; we rank each sample and sum the ranks, so the result stays
// additive and rollup's filters work on it. identity.ts compares the two on players in both datasets.
import type { Ctx } from "./derive";
import type { Side } from "./tables";

export const SPACING_START_S = 10;
export const SPACING_STEP_S = 3;

export function positioning(c: Ctx): void {
  if (!c.t.positions) return;
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rf = c.rounds[ri];
    if (rf.freezeEndTick === null) continue;
    const stop = Math.min(rf.plantTick ?? Infinity, rf.endTick);
    const rows = c.pr[ri];
    for (const side of ["CT", "T"] as Side[]) {
      const team = rows.filter((p) => p?.side === side).map((p) => p!.pi);
      if (team.length !== 5) continue;
      for (let tick = rf.freezeEndTick + SPACING_START_S * c.tickRate; tick < stop; tick += SPACING_STEP_S * c.tickRate) {
        const at = team.map((p) => c.posAt(ri, p, tick));
        if (at.some((x) => x === null)) continue;
        const pts = at as [number, number, number][];
        const centre = [0, 1, 2].map((d) => pts.reduce((s, p) => s + p[d], 0) / 5);
        const nearest = pts.map((p, i) => Math.min(...pts.filter((_, j) => j !== i).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))));
        const fromCentre = pts.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]));
        // Two players who are each other's nearest teammate tie; tied values share the mean of their ranks.
        const rank = (v: number[]) => v.map((x) => (1 + v.filter((y) => y < x).length + (v.filter((y) => y === x).length - 1) / 2) / 5);
        const rn = rank(nearest);
        const rc = rank(fromCentre);
        team.forEach((p, i) => {
          const m = rows[p]!.m;
          m.spacingSamples++;
          m.adntRank += rn[i];
          m.adatRank += rc[i];
          m.nearestDistSum += nearest[i];
        });
      }
    }
    for (const p of rows) {
      if (!p) continue;
      const death = c.kills[ri].find((k) => k.victim === p.pi);
      if (death && death.t !== null) p.m.deathTimeSum += death.t;
    }
  }
}
