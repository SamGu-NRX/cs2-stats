// Closing: time alive, being the last of your side, clutches, being alive for the post-plant, saves.
// HLTV's "Closing" attribute shows time alive, alive for post-plant, last alive and clutches per 24
// rounds; it publishes no formulas, so each definition is ours and says so in METRICS.md.
import type { Ctx } from "./derive";
import { detectClutches } from "./rules";
import type { Side } from "./tables";

export function closing(c: Ctx): void {
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rf = c.rounds[ri];
    const list = c.kills[ri];
    const rows = c.pr[ri];
    const alive: Record<Side, Set<number>> = { CT: new Set(), T: new Set() };
    rows.forEach((p) => { if (p) alive[p.side].add(p.pi); });

    // last alive: at some moment the player was the only one of their side alive (counted once)
    const live: Record<Side, Set<number>> = { CT: new Set(alive.CT), T: new Set(alive.T) };
    const last = new Set<number>();
    for (const s of ["CT", "T"] as const) if (live[s].size === 1) last.add([...live[s]][0]);
    for (const k of list) {
      if (k.tick > rf.endTick) break;
      for (const s of ["CT", "T"] as const) {
        if (!live[s].delete(k.victim)) continue;
        if (live[s].size === 1) last.add([...live[s]][0]);
      }
    }

    for (const cl of detectClutches(list.filter((k) => k.tick <= rf.endTick), alive, rf.winner)) {
      const m = c.pr[ri][cl.pi]!.m;
      const n = Math.min(5, cl.opponents) as 1 | 2 | 3 | 4 | 5;
      m[`clutch${n}`]++;
      if (cl.won) m[`clutchWon${n}`]++;
    }

    for (const p of rows) {
      if (!p) continue;
      const m = p.m;
      const death = list.find((k) => k.victim === p.pi);
      if (rf.freezeEndTick !== null) {
        const until = death && death.tick < rf.endTick ? death.tick : rf.endTick;
        m.aliveSecs += Math.max(0, until - rf.freezeEndTick) / c.tickRate;
      }
      if (last.has(p.pi)) m.lastAlive = 1;
      if (rf.plantTick !== null) {
        m.postPlantRounds = 1;
        if (!death || death.tick > rf.plantTick) m.aliveAtPlant = 1;
      }
      // a save: alive at the end of a lost round
      if (p.won === false && (!death || death.tick > rf.endTick)) m.saves = 1;
    }
  }
}
