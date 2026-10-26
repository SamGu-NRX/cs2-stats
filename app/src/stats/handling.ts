// Weapon handling: reloads and the bullets they throw away. The tables have no reload event, so a
// reload is read from the clip count each shot carries (shots.ammo_clip, the clip before the bullet is
// fired: a full AK shows 30). Between two shots of one gun by one player in a round, the second
// showing more than the first left (its count minus one) is a reload in between; the bullets the first
// left are what the reload threw away, as a share of the clip the second shot fired from.
//
// A gun picked up shows the same rise, and shots carry no weapon entity id that would tell two copies
// of one gun apart. A player ends up with another copy only by buying one or picking one up, and a
// pickup needs a copy on the ground. So a rise counts only when no copy was bought in between and none
// was dropped by a dying player within PICKUP_REACH of the player's path, which the 4 Hz positions
// trace (a hole in them leaves the rise out; without positions no round has a reload to read).
//
// Switching to a knife, grenade or pistol and back does not end the run. Requiring the gun in hand on
// every sample between the shots was tried and ruled out: the game drops only the gun in hand, so a
// switch alone cannot change which copy the player owns, and on 8 pro maps that rule turned down 246
// of the 347 rises between consecutive shots of one gun, mostly knife-outs between fights. A reload with no later
// shot of the gun in the round, and a copy a living player dropped, are not seen.
import type { Ctx } from "./derive";
import { isGun } from "./guns";
import type { Metric } from "./metrics";
import { classFromDisplay } from "./weapons";

/**
 * World units from a dying player's position within which the player could have picked up the gun
 * that player dropped. No measurement backs it: it is set wide (a gun slides when dropped, and a
 * running player covers about 60 units between two 4 Hz samples) so that a doubtful rise is left out
 * rather than counted as a reload.
 */
export const PICKUP_REACH = 256;

/** The longest wait between two position samples, in seconds, over which the player's path still counts as traced: one missed 4 Hz sample. */
const SAMPLE_GAP_S = 0.5;

/**
 * Fills reloads and reloadWaste (the summed share of the clip thrown away per reload) per player-round,
 * and ammoRounds for the rounds whose every gun shot of the player has a clip count and whose path
 * the positions sample.
 */
export function handling(c: Ctx): void {
  const S = c.t.shots, P = c.t.positions, K = c.t.kills;
  if (!S || !P) return;
  const byRow = new Map<number, number[]>();
  for (let i = 0; i < S.n; i++) {
    const ri = c.riOf(S.round[i]), pi = c.idOf(S.steamid[i]);
    if (ri === undefined || pi === null || !c.pr[ri]?.[pi] || !isGun(S.weapon[i])) continue;
    const k = ri * 1024 + pi;
    (byRow.get(k) ?? byRow.set(k, []).get(k)!).push(i);
  }
  const samples = new Map<number, number[]>();
  for (let i = 0; i < P.n; i++) {
    const ri = c.riOf(P.round[i]), pi = c.idOf(P.steamid[i]);
    if (ri === undefined || pi === null || !byRow.has(ri * 1024 + pi)) continue;
    const k = ri * 1024 + pi;
    (samples.get(k) ?? samples.set(k, []).get(k)!).push(i);
  }
  // guns on the ground: each death drops the gun in hand and the best primary
  const drops: { tick: number; victim: number; guns: string[]; x: number | null; y: number | null }[][] = Array.from({ length: c.nRounds }, () => []);
  for (let i = 0; i < K.n; i++) {
    const ri = c.riOf(K.round[i]);
    if (ri === undefined) continue;
    const guns = [K.v_active_weapon[i], K.v_best_primary[i]].filter((w): w is string => w !== null).map(classFromDisplay);
    drops[ri].push({ tick: K.tick[i], victim: c.pi.get(K.victim_steamid[i])!, guns, x: K.v_x[i], y: K.v_y[i] });
  }
  const buys = c.byRound("purchases");
  const gap = SAMPLE_GAP_S * c.tickRate;

  for (const [k, rows] of byRow) {
    const ri = Math.floor(k / 1024), pi = k % 1024;
    const own = samples.get(k);
    const m = c.pr[ri][pi]!.m;
    if (!own || rows.some((i) => S.ammo_clip[i] === null)) continue;
    m.ammoRounds = 1;
    rows.sort((a, b) => S.tick[a] - S.tick[b] || a - b);
    own.sort((a, b) => P.tick[a] - P.tick[b] || a - b);
    const near = (x: number | null, y: number | null, d: { x: number | null; y: number | null }) =>
      x === null || y === null || d.x === null || d.y === null || Math.hypot(x - d.x, y - d.y) <= PICKUP_REACH;

    /** No other copy of `gun` could have reached the player between shots `a` and `b`, as far as the tables can show. */
    const sameCopy = (a: number, b: number, gun: string): boolean => {
      const ta = S.tick[a], tb = S.tick[b];
      const between = own.filter((j) => P.tick[j] > ta && P.tick[j] < tb);
      let last = ta;
      for (const j of between) {
        if (P.tick[j] - last > gap) return false;
        last = P.tick[j];
      }
      if (tb - last > gap) return false;
      const sid = c.players[pi].id;
      if (buys[ri].some((j) => c.t.purchases!.steamid[j] === sid && c.t.purchases!.tick[j] > ta && c.t.purchases!.tick[j] <= tb && classFromDisplay(c.t.purchases!.item[j]) === gun)) return false;
      return !drops[ri].some((d) => d.victim !== pi && d.tick < tb && d.guns.includes(gun) && (
        near(S.x[b], S.y[b], d) || (d.tick <= ta && near(S.x[a], S.y[a], d)) ||
        between.some((j) => P.tick[j] > d.tick && near(P.x[j], P.y[j], d))
      ));
    };

    const last = new Map<string, number>();
    for (const i of rows) {
      const prev = last.get(S.weapon[i]);
      if (prev !== undefined && S.ammo_clip[i]! > S.ammo_clip[prev]! - 1 && S.ammo_clip[i]! > 0 && sameCopy(prev, i, S.weapon[i])) {
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
    def: "Average share of the clip still loaded when you reloaded between shots. A gun a living player dropped and you picked up can read as a reload, and the 256-unit reach for a dying player's gun has no measurement behind it.",
    value: (s) => pct(s.m.reloadWaste, s.m.reloads) },
  { id: "reloadsPR", label: "Reloads per round", kind: "identity", group: "aim", unit: "perRound", status: "approx", needs: ["ammo"],
    tip: "How often you reload between shots, per round.",
    def: "Reloads seen between two shots of one gun, per round with clip counts. A gun a living player dropped and you picked up can read as a reload, and the 256-unit reach for a dying player's gun has no measurement behind it.",
    value: (s) => per(s.m.reloads, s.m.ammoRounds) },
];
