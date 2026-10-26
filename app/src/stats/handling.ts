// Weapon handling: reloads and the bullets they throw away. The tables have no reload event, so a
// reload is read from the clip count each shot carries (shots.ammo_clip, the clip before the bullet is
// fired: a full AK shows 30). Between two shots of one gun by one player in a round, the second
// showing more than the first left (its count minus one) is a reload in between; the bullets the first
// left are what the reload threw away, as a share of the clip the second shot fired from. A reload with
// no later shot in the round, and one of a dropped gun picked up again, are not seen.
import type { Ctx } from "./derive";
import { isGun } from "./guns";
import type { Metric } from "./metrics";

/**
 * Fills reloads and reloadWaste (the summed share of the clip thrown away per reload) per player-round,
 * and ammoRounds for the rounds whose every gun shot of the player has a clip count.
 */
export function handling(c: Ctx): void {
  const S = c.t.shots;
  if (!S) return;
  const byRow = new Map<number, number[]>();
  for (let i = 0; i < S.n; i++) {
    const ri = c.riOf(S.round[i]), pi = c.idOf(S.steamid[i]);
    if (ri === undefined || pi === null || !c.pr[ri]?.[pi] || !isGun(S.weapon[i])) continue;
    const k = ri * 1024 + pi;
    (byRow.get(k) ?? byRow.set(k, []).get(k)!).push(i);
  }
  for (const [k, rows] of byRow) {
    const m = c.pr[Math.floor(k / 1024)][k % 1024]!.m;
    if (rows.some((i) => S.ammo_clip[i] === null)) continue;
    m.ammoRounds = 1;
    rows.sort((a, b) => S.tick[a] - S.tick[b] || a - b);
    const last = new Map<string, number>();
    for (const i of rows) {
      const prev = last.get(S.weapon[i]);
      if (prev !== undefined && S.ammo_clip[i]! > S.ammo_clip[prev]! - 1 && S.ammo_clip[i]! > 0) {
        m.reloads++;
        m.reloadWaste += (S.ammo_clip[prev]! - 1) / S.ammo_clip[i]!;
      }
      last.set(S.weapon[i], i);
    }
  }
}

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const per = (a: number, b: number) => (b > 0 ? a / b : null);

export const HANDLING_METRICS: Metric[] = [
  { id: "wastedMagazine", label: "Wasted magazine", kind: "identity", group: "aim", unit: "pct", status: "approx", needs: ["ammo"],
    tip: "How much of your magazine you throw away when you reload.",
    def: "Average share of the clip still loaded when you reloaded between shots.",
    value: (s) => pct(s.m.reloadWaste, s.m.reloads) },
  { id: "reloadsPR", label: "Reloads per round", kind: "identity", group: "aim", unit: "perRound", status: "approx", needs: ["ammo"],
    tip: "How often you reload between shots, per round.",
    def: "Reloads seen between two shots of one gun, per round with clip counts.",
    value: (s) => per(s.m.reloads, s.m.ammoRounds) },
];
