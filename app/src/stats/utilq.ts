// Smoke quality: how often a smoke hid the thrower's team from an enemy whose line of sight to them
// had just opened. Nobody publishes a smoke or molotov quality definition
// (design/research-data-sources.md), so this one is ours. Flash quality stays in utility.ts, on
// Leetify's definitions.
//
// Why this metric, and why no molotov metric: the round-outcome analysis in VALIDATION.md.
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

/** The extractor's smoke model (SCHEMA-v1.md, Visibility; awpy 3.1.1 map_control defaults): a sphere this wide... */
export const SMOKE_RADIUS = 144;
/** ...centred this far above the detonation point, live from detonation to expiry. */
export const SMOKE_HEIGHT = 60;

/** One smoke on a map with mesh visibility. */
export interface UtilQFact {
  ri: number;
  /** the thrower */
  pi: number;
  /** enemy sightlines to the thrower's team that opened through this smoke; a share when several smokes blocked one */
  sights: number;
}

export interface UtilQAgg { smokes: number; sights: number }
export const emptyUtilQ = (): UtilQAgg => ({ smokes: 0, sights: 0 });
export function foldUtilQ(a: UtilQAgg, f: UtilQFact): void { a.smokes++; a.sights += f.sights; }

type V3 = [number, number, number];

/** Whether segment a-b passes strictly within r of c: the extractor's segment_hits_sphere. */
function segmentHitsSphere(a: V3, b: V3, c: V3, r: number): boolean {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const den = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const u = den > 0 ? Math.max(0, Math.min(1, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / den)) : 0;
  const d = [a[0] + u * ab[0] - c[0], a[1] + u * ab[1] - c[1], a[2] + u * ab[2] - c[2]];
  return d[0] * d[0] + d[1] * d[1] + d[2] * d[2] < r * r;
}

/**
 * A sightline is a directed engagement's visibility onset: the first tick its attacker had mesh line of
 * sight to its victim (engagements.first_visible_tick). The extractor's onsets ignore smoke, so an
 * onset with smoke_blocked set is a line that opened through a smoke. The extractor's flag does not say
 * which smoke, so each live smoke whose sphere the eye-to-eye segment crosses takes an equal share, and
 * a share counts only for a smoke thrown by the victim's team: that smoke hid the victim from this
 * enemy. The reverse engagement of the same pair is credited to the other team's smokes, so a pair
 * counts once per team.
 */
export function deriveUtilQ(c: Ctx): UtilQFact[] {
  const S = c.t.smokes, E = c.t.engagements, T = c.t.engagement_ticks;
  if (!S || !E || !T || c.t.match.visibility_status[0] !== "ok") return [];

  const out: (UtilQFact & { start: number; end: number; centre: V3 })[] = [];
  const byRound: number[][] = Array.from({ length: c.nRounds }, () => []);
  for (let i = 0; i < S.n; i++) {
    const ri = c.riOf(S.round[i]);
    const pi = c.idOf(S.steamid[i]);
    if (ri === undefined || pi === null || !c.side[ri][pi]) continue;
    byRound[ri].push(out.length);
    out.push({ ri, pi, sights: 0, start: S.start_tick[i], end: S.end_tick[i] ?? Infinity, centre: [S.x[i], S.y[i], S.z[i] + SMOKE_HEIGHT] });
  }

  const onset = new Map<number, number>();
  for (let e = 0; e < E.n; e++) if (E.first_visible_tick[e] !== null) onset.set(E.engagement_id[e], e);
  for (let i = 0; i < T.n; i++) {
    const e = onset.get(T.engagement_id[i]);
    if (e === undefined || T.tick[i] !== E.first_visible_tick[e] || !T.smoke_blocked[i]) continue;
    const ri = c.riOf(E.round[e]);
    const att = c.idOf(E.attacker_steamid[e]);
    if (ri === undefined || att === null) continue;
    const tick = T.tick[i];
    const ax = T.a_x[i], ay = T.a_y[i], az = T.a_eye_z[i], vx = T.v_x[i], vy = T.v_y[i], vz = T.v_eye_z[i];
    // without both eyes the sightline cannot be placed
    if (ax === null || ay === null || az === null || vx === null || vy === null || vz === null) continue;
    const a: V3 = [ax, ay, az], v: V3 = [vx, vy, vz];
    const blocking = byRound[ri].filter((k) => tick >= out[k].start && tick <= out[k].end && segmentHitsSphere(a, v, out[k].centre, SMOKE_RADIUS));
    for (const k of blocking) if (c.side[ri][out[k].pi] !== c.side[ri][att]) out[k].sights += 1 / blocking.length;
  }
  return out.map(({ ri, pi, sights }) => ({ ri, pi, sights }));
}

export const UTILQ_METRICS: Metric[] = [
  { id: "smokeSights", label: "Enemy sightlines blocked per smoke", kind: "performance", group: "utility", unit: "count", status: "approx",
    def: `Times an enemy's mesh line of sight to your team opened through your smoke (modelled as a sphere of radius ${SMOKE_RADIUS} centred ${SMOKE_HEIGHT} units above the detonation), per smoke. Maps without mesh visibility are left out.`,
    value: (s) => (s.utilq.smokes ? s.utilq.sights / s.utilq.smokes : null) },
];
