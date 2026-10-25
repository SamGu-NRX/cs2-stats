// Buying habits from the team research (cs2-stats-data/research/team/explore.py): how far a player's
// buy sits from the team's, and what equipment a save carries into the next round.
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

/**
 * Round number n (1-based) is the last of a half: regulation halves of maxRounds / 2, then overtime
 * halves of otMaxRounds / 2. Equipment does not carry over such a round.
 */
export function endsHalf(n: number, maxRounds: number, otMaxRounds: number): boolean {
  if (n === maxRounds / 2 || n === maxRounds) return true;
  return n > maxRounds && (n - maxRounds) % (otMaxRounds / 2) === 0;
}

/**
 * Fills buyDevSum and buyDevRounds: your freeze-end equipment value minus the mean of your side's,
 * over rounds where every player on the side has one. And the save measures: saveEvents counts lost
 * rounds you survived (closing.ts saves) that a round on the same side follows within the half;
 * saveCarryKnown those where that round's starting equipment is recorded, and saveCarrySum its value.
 * Runs after closing().
 */
export function buying(c: Ctx, maxRounds: number, otMaxRounds: number): void {
  const pr = c.t.player_rounds;
  const startEquip = new Map<number, number | null>();
  for (let i = 0; i < pr.n; i++) {
    const ri = c.riOf(pr.round[i]);
    if (ri !== undefined) startEquip.set(ri * 1024 + c.pi.get(pr.steamid[i])!, pr.round_start_equip_value[i]);
  }
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rows = c.pr[ri];
    const rf = c.rounds[ri];
    for (const p of rows) {
      if (!p) continue;
      const team = rf.equip[p.side];
      const n = rows.filter((q) => q?.side === p.side).length;
      if (p.equip !== null && team !== null) { p.m.buyDevRounds = 1; p.m.buyDevSum = p.equip - team / n; }

      if (!p.m.saves || endsHalf(rf.number, maxRounds, otMaxRounds)) continue;
      const next = c.rounds[ri + 1];
      if (!next || next.number !== rf.number + 1 || c.pr[ri + 1][p.pi]?.side !== p.side) continue;
      p.m.saveEvents = 1;
      const carried = startEquip.get((ri + 1) * 1024 + p.pi) ?? null;
      if (carried !== null) { p.m.saveCarryKnown = 1; p.m.saveCarrySum = carried; }
    }
  }
}

const per = (a: number, b: number) => (b > 0 ? a / b : null);

export const BUYING_METRICS: Metric[] = [
  { id: "buyDeviation", label: "Buy against the team", kind: "identity", group: "economy", unit: "money", status: "approx",
    def: "Your equipment value minus your team's average, per round.",
    value: (s) => per(s.m.buyDevSum, s.m.buyDevRounds) },
];
