// Where every player is at any moment of a round timeline (replay.ts). Samples are 4 Hz; between two
// samples a living player moves in a straight line and turns the short way round. With interpolation
// off (reduced motion) a player holds the last sample until the next one.
//
// A kill ends a life at its exact tick, between samples: from then on the player is dead at the
// kill's victim position, or where his last living sample put him when the kill has none. A corpse
// never moves, whatever later samples say. HP drops at each hit's tick for the same reason.
import type { RoundTimeline, Vec3 } from "./replay";
import type { Side } from "./tables";

export interface PlayerState {
  id: string;
  side: Side;
  x: number;
  y: number;
  z: number;
  yaw: number;
  alive: boolean;
  hp: number | null;
  weapon: string | null;
}

/** Index of the last frame at or before t; 0 before the first frame. Frames are in time order. */
export function frameIndex(frames: { t: number }[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  if (hi < 0 || t <= frames[0].t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The angle from a toward b the short way, f of the way (0..1); the result is in (-180, 180]. */
export function lerpYaw(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  const y = a + d * f;
  const w = ((((y + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

/**
 * Each player's death in the round, by roster index: when (the first kill naming him, else his first
 * sample marked dead) and where the body lies (the kill's victim position, else his last living
 * sample at or before it). Null for a player who lives through the round. Cached per timeline.
 */
const deaths = new WeakMap<RoundTimeline, ({ t: number; at: Vec3 } | null)[]>();
export function deathsOf(tl: RoundTimeline): ({ t: number; at: Vec3 } | null)[] {
  let out = deaths.get(tl);
  if (out) return out;
  const killed = new Map<string, { t: number; at: Vec3 | null }>();
  for (const k of tl.kills) if (!killed.has(k.victim)) killed.set(k.victim, { t: k.t, at: k.vpos });
  out = tl.players.map((p, i) => {
    const kill = killed.get(p.id);
    const firstDead = tl.frames.find((f) => !f.players[i].alive);
    const t = kill ? kill.t : firstDead ? firstDead.t : null;
    if (t === null) return null;
    if (kill?.at) return { t, at: kill.at };
    let s = tl.frames[0].players[i];
    for (const f of tl.frames) {
      if (f.t > t) break;
      if (f.players[i].alive) s = f.players[i];
    }
    return { t, at: [s.x, s.y, s.z] };
  });
  deaths.set(tl, out);
  return out;
}

/**
 * Every rostered player's state at time t, in roster order. `smooth` false holds samples instead of
 * interpolating. Pass `out` to reuse its objects across calls (the draw loop does, so playback
 * allocates nothing per frame).
 */
export function playersAt(tl: RoundTimeline, t: number, smooth: boolean, out: PlayerState[] = []): PlayerState[] {
  const frames = tl.frames;
  out.length = tl.players.length;
  if (!frames.length) { out.length = 0; return out; }
  const i0 = frameIndex(frames, t);
  const fa = frames[i0];
  const fb = frames[i0 + 1];
  const f = smooth && fb && t > fa.t ? Math.min(1, (t - fa.t) / (fb.t - fa.t)) : 0;
  const died = deathsOf(tl);
  for (let i = 0; i < tl.players.length; i++) {
    const a = fa.players[i];
    const b = fb?.players[i];
    const s = (out[i] ??= { id: "", side: "T", x: 0, y: 0, z: 0, yaw: 0, alive: true, hp: null, weapon: null });
    const death = died[i];
    s.id = a.id;
    s.side = a.side;
    s.weapon = a.weapon;
    if ((death && t >= death.t) || !a.alive) {
      // a sample marked dead before the death time (a kill row later than the sample) still lies at the body
      const at = death ? death.at : [a.x, a.y, a.z];
      s.x = at[0];
      s.y = at[1];
      s.z = at[2];
      s.yaw = a.yaw;
      s.alive = false;
      s.hp = 0;
      continue;
    }
    if (b && f > 0) {
      s.x = a.x + (b.x - a.x) * f;
      s.y = a.y + (b.y - a.y) * f;
      s.z = a.z + (b.z - a.z) * f;
      s.yaw = lerpYaw(a.yaw, b.yaw, f);
    } else {
      s.x = a.x; s.y = a.y; s.z = a.z; s.yaw = a.yaw;
    }
    s.alive = true;
    // the sample's HP, then every hit since the sample up to t
    let hp = a.hp;
    for (const h of tl.hits) {
      if (h.t > t) break;
      if (h.t > fa.t && h.victim === a.id) hp = h.hp;
    }
    s.hp = hp;
  }
  return out;
}
