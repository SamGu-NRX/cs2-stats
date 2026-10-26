// The 2D replay's input: one round as a timeline of position frames and the events drawn over them.
// Built from schema v1 tables (positions, kills, damages, grenade_events, bomb, rounds) plus the
// extractor's grenade_paths (replay-load.ts), in the replay worker; the UI only interpolates and draws.
//
// Time is seconds from the round's freeze end (its start for a round recorded already live), the same
// clock as facts' KillFact.t and the killfeed. Positions are world units; z is kept so a map with two
// radar levels can split players by height.
import { classFromDisplay, weaponClass } from "./weapons";
import type { MatchTables, Side } from "./tables";

/** One player in one frame, as the extractor sampled it. `weapon` is an icon id (ak47, knife, …). */
export interface FramePlayer {
  id: string;
  side: Side;
  x: number;
  y: number;
  z: number;
  /** view yaw, degrees: 0 faces +x (east), 90 faces +y (north) */
  yaw: number;
  alive: boolean;
  /** null when the sample has no health */
  hp: number | null;
  weapon: string | null;
}

/** Every rostered player at one sample tick, in roster order (players[i] is RoundTimeline.players[i]). */
export interface Frame { t: number; players: FramePlayer[] }

export interface RosterPlayer { id: string; name: string; side: Side }

export type Vec3 = [number, number, number];

export interface ReplayKill {
  t: number;
  killer: string | null;
  victim: string;
  killerSide: Side | null;
  victimSide: Side | null;
  weapon: string;
  headshot: boolean;
  /** where the killer and the victim stood at the kill */
  kpos: Vec3 | null;
  vpos: Vec3 | null;
}

/** A hit: the victim's HP right after it, so HP can change between the 4 Hz samples. */
export interface ReplayHit { t: number; victim: string; hp: number }

export type GrenadeKind = "smoke" | "flash" | "he" | "molotov" | "decoy";

/** A projectile's flight. `path` is flat [t, x, y, z, t, x, y, z, …] in time order. */
export interface ReplayThrow {
  kind: GrenadeKind;
  thrower: string | null;
  side: Side | null;
  path: number[];
  /** when it detonated (or the last path point when no detonation is linked) */
  end: number;
}

/**
 * What a grenade did where it went off. Smokes and fires last from `t` to `until`; flashes, HEs and
 * decoys are a moment (`until` equals `t`).
 */
export interface ReplayEffect {
  kind: GrenadeKind;
  thrower: string | null;
  side: Side | null;
  t: number;
  until: number;
  at: Vec3;
}

export interface ReplayBomb { t: number; kind: "plant" | "defuse" | "explode"; by: string | null; site: string | null; at: Vec3 | null }

export interface RoundTimeline {
  round: number;
  tickRate: number;
  /** the tick t = 0 stands for */
  zeroTick: number;
  /**
   * Seconds the replay runs: to the round end plus END_TAIL_S, cut at the official end. Players hold
   * their last sample after it, so an event between the last sample and the end is still reached.
   */
  duration: number;
  /** when the round ended (its winner was decided) */
  endT: number;
  winner: Side | null;
  reason: string | null;
  players: RosterPlayer[];
  frames: Frame[];
  kills: ReplayKill[];
  hits: ReplayHit[];
  throws: ReplayThrow[];
  effects: ReplayEffect[];
  bomb: ReplayBomb[];
}

/**
 * Seconds shown after the round's end, so the last kill's line and the end of a bomb round are seen.
 * Ours, no fit: the kill line flashes for 1 s, and 3 s holds the final positions briefly after it.
 */
export const END_TAIL_S = 3;

/**
 * A molotov's flight ends one tick before its fire starts, at the same point; the projectile and the
 * fire are different entities, so the fire is matched by time and place. Measured on the Inferno pro
 * demo (100 Thieves vs Liquid): 113 of 118 molotov paths have an inferno_start 1 tick after their last
 * point within 32 units; the other 5 have no fire (thrown into a smoke, or the round ended).
 */
export const FIRE_LINK_TICKS = 2;
export const FIRE_LINK_UNITS = 32;

/**
 * The longest a smoke or a fire lasts, seconds: an effect whose end the tables do not give stops here
 * rather than running to the round's end. Measured over the two dev pro demos and the six Valve
 * matches: 295 of 296 smokes with an end lasted exactly 22.0625 s (the other, 761 s, ended in a later
 * round), and 277 fires lasted 0.77 to 7.03 s (median 5.5 s).
 */
export const SMOKE_MAX_S = 22.0625;
export const FIRE_MAX_S = 7.03125;
/** A stop event that names no entity ends the open effect of its kind within this many units of it. */
export const STOP_LINK_UNITS = 32;

/** The extractor's grenade_paths table: one row per projectile per tick it moved (extractor/SCHEMA-v1.md). */
export interface GrenadePaths {
  n: number;
  projectile: number[];
  entity_id: number[];
  round: number[];
  tick: number[];
  type: string[];
  steamid: (string | null)[];
  x: number[];
  y: number[];
  z: number[];
}

/** The pack's icon id for a positions.active_weapon display name: AK-47 → ak47, every knife skin → knife. */
export function weaponId(display: string | null): string | null {
  if (display === null || display === "") return null;
  if (/knife|bayonet|karambit|daggers/i.test(display)) return "knife";
  const id = classFromDisplay(display);
  return weaponClass(id) === "other" && id !== "taser" && id !== "c4" ? display : id;
}

const PATH_KIND: Record<string, GrenadeKind> = { smoke: "smoke", flashbang: "flash", he: "he", molotov: "molotov", incendiary: "molotov", incgrenade: "molotov", decoy: "decoy" };
/** The grenade_events event that starts each kind's effect, and the one that ends a lasting effect. */
const START: Record<string, GrenadeKind> = { smoke_detonate: "smoke", flash_detonate: "flash", he_detonate: "he", inferno_start: "molotov", decoy_start: "decoy" };
const STOP: Record<string, GrenadeKind> = { smoke_expired: "smoke", inferno_expire: "molotov" };
const BOMB: Record<string, ReplayBomb["kind"]> = { planted: "plant", defused: "defuse", exploded: "explode" };

const sideOf = (s: string | null): Side | null => (s === "T" || s === "CT" ? s : null);
const vec = (x: number | null, y: number | null, z: number | null): Vec3 | null => (x === null || y === null ? null : [x, y, z ?? 0]);

/**
 * Round `round` (1-based, rounds.round) as a timeline. Throws when the round is not in the tables or
 * has no position samples: a replay cannot be drawn without them.
 */
export function buildRoundTimeline(t: MatchTables, paths: GrenadePaths | null, round: number): RoundTimeline {
  const R = t.rounds;
  const ri = R.round.indexOf(round);
  if (ri < 0) throw new Error(`round ${round} is not in this match`);
  const P = t.positions;
  if (!P || !P.n) throw new Error("this match has no position samples");
  const rate = t.match.tick_rate[0];
  const zero = R.freeze_end_tick[ri] ?? R.start_tick[ri];
  if (zero === null) throw new Error(`round ${round} has neither a freeze end nor a start tick`);
  const endTick = R.end_tick[ri];
  const stopTick = Math.min(R.official_end_tick[ri] ?? endTick, endTick + Math.round(END_TAIL_S * rate));
  const sec = (tick: number) => (tick - zero) / rate;

  // the round's samples from the last tick at or before zero to stopTick
  const rows: number[] = [];
  let before = -Infinity;
  for (let i = 0; i < P.n; i++) {
    if (P.round[i] !== round) continue;
    if (P.tick[i] <= zero) before = Math.max(before, P.tick[i]);
    rows.push(i);
  }
  const first = Number.isFinite(before) ? before : zero;
  const kept = rows.filter((i) => P.tick[i] >= first && P.tick[i] <= stopTick);
  if (!kept.length) throw new Error(`round ${round} has no position samples`);
  const ticks = [...new Set(kept.map((i) => P.tick[i]))].sort((a, b) => a - b);

  // roster: everyone sampled in the window, T then CT, in the players table's order
  const sideRound = new Map<string, Side>();
  const PR = t.player_rounds;
  for (let i = 0; i < PR.n; i++) if (PR.round[i] === round) { const s = sideOf(PR.side[i]); if (s) sideRound.set(PR.steamid[i], s); }
  const rowAt = new Map<string, Map<number, number>>();
  for (const i of kept) {
    let m = rowAt.get(P.steamid[i]);
    if (!m) rowAt.set(P.steamid[i], (m = new Map()));
    m.set(P.tick[i], i);
  }
  const order = new Map(t.players.steamid.map((id, i) => [id, i]));
  const name = (id: string) => { const i = order.get(id); return i === undefined ? id : t.players.name[i]; };
  const players: RosterPlayer[] = [];
  for (const [id, m] of rowAt) {
    const side = sideRound.get(id) ?? sideOf(P.side[m.values().next().value!]);
    if (side) players.push({ id, name: name(id), side });
  }
  players.sort((a, b) => (a.side === b.side ? (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) : a.side === "T" ? -1 : 1));

  const sample = (i: number, side: Side): FramePlayer => ({
    id: P.steamid[i], side, x: P.x[i], y: P.y[i], z: P.z[i], yaw: P.yaw[i] ?? 0, alive: P.is_alive[i],
    hp: P.health[i], weapon: weaponId(P.active_weapon[i]),
  });
  // a player missing from a tick holds their previous sample; before their first, their first
  const frames: Frame[] = ticks.map((tick) => ({ t: sec(tick), players: [] }));
  players.forEach((p) => {
    const m = rowAt.get(p.id)!;
    const own = [...m.keys()].sort((a, b) => a - b);
    let k = 0;
    ticks.forEach((tick, f) => {
      while (k + 1 < own.length && own[k + 1] <= tick) k++;
      frames[f].players.push(sample(m.get(own[k])!, p.side));
    });
  });

  const inWindow = (tick: number) => tick >= first && tick <= stopTick;
  const K = t.kills;
  const kills: ReplayKill[] = [];
  for (let i = 0; i < K.n; i++) {
    if (K.round[i] !== round || !inWindow(K.tick[i])) continue;
    kills.push({
      t: sec(K.tick[i]), killer: K.attacker_steamid[i], victim: K.victim_steamid[i], killerSide: sideOf(K.a_side[i]), victimSide: sideOf(K.v_side[i]),
      weapon: K.weapon[i], headshot: K.headshot[i], kpos: vec(K.a_x[i], K.a_y[i], K.a_z[i]), vpos: vec(K.v_x[i], K.v_y[i], K.v_z[i]),
    });
  }
  const D = t.damages;
  const hits: ReplayHit[] = [];
  for (let i = 0; i < D.n; i++) {
    const hp = D.health_after[i];
    if (D.round[i] === round && hp !== null && inWindow(D.tick[i])) hits.push({ t: sec(D.tick[i]), victim: D.victim_steamid[i], hp });
  }
  kills.sort((a, b) => a.t - b.t);
  hits.sort((a, b) => a.t - b.t);

  const sideById = new Map(players.map((p) => [p.id, p.side]));
  const sideFor = (id: string | null) => (id === null ? null : sideById.get(id) ?? null);
  const stopT = sec(stopTick);

  // Effects from the detonation events. A smoke or fire ends at, in order: its stop event (by entity,
  // or for a stop naming none, the open effect of its kind nearest it), its row in the smokes or
  // infernos lifetime table, or SMOKE_MAX_S / FIRE_MAX_S after it started; never past the window.
  const E = t.grenade_events;
  const effects: ReplayEffect[] = [];
  const startOf = new Map<number, ReplayEffect>();
  const fires: { tick: number; at: Vec3; thrower: string | null }[] = [];
  const lasting: { e: ReplayEffect; entity: number | null; tick: number; ended: boolean }[] = [];
  if (E) {
    const idx = [...Array(E.n).keys()].filter((i) => E.round[i] === round).sort((a, b) => E.tick[a] - E.tick[b]);
    for (const i of idx) {
      const kind = START[E.event[i]];
      const where = vec(E.x[i], E.y[i], E.z[i]);
      if (kind && where && inWindow(E.tick[i])) {
        const e: ReplayEffect = { kind, thrower: E.steamid[i], side: sideFor(E.steamid[i]), t: sec(E.tick[i]), until: sec(E.tick[i]), at: where };
        effects.push(e);
        if (E.entity_id[i] !== null) startOf.set(E.entity_id[i]!, e);
        if (kind === "smoke" || kind === "molotov") lasting.push({ e, entity: E.entity_id[i], tick: E.tick[i], ended: false });
        if (kind === "molotov") fires.push({ tick: E.tick[i], at: e.at, thrower: E.steamid[i] });
      }
      const stop = STOP[E.event[i]];
      if (!stop) continue;
      const open = lasting.filter((l) => !l.ended && l.e.kind === stop && l.tick <= E.tick[i]);
      const stopAt = vec(E.x[i], E.y[i], E.z[i]);
      const match = E.entity_id[i] !== null
        ? open.find((l) => l.entity === E.entity_id[i])
        : stopAt ? open.filter((l) => Math.hypot(l.e.at[0] - stopAt[0], l.e.at[1] - stopAt[1]) <= STOP_LINK_UNITS)
          .sort((a, b) => Math.hypot(a.e.at[0] - stopAt[0], a.e.at[1] - stopAt[1]) - Math.hypot(b.e.at[0] - stopAt[0], b.e.at[1] - stopAt[1]))[0] : undefined;
      if (match) { match.ended = true; match.e.until = sec(E.tick[i]); }
    }
  }
  const lifetime = (table: MatchTables["smokes"] | MatchTables["infernos"], l: (typeof lasting)[number]): number | null => {
    if (!table) return null;
    for (let i = 0; i < table.n; i++) {
      // the tables' start_tick is the detonation's tick (equal on every smoke and fire of the Inferno pro demo and Valve Dust II)
      if (table.round[i] !== round || table.end_tick[i] === null || table.start_tick[i] !== l.tick) continue;
      if (l.entity !== null && table.entity_id[i] !== null ? table.entity_id[i] === l.entity : Math.hypot(table.x[i] - l.e.at[0], table.y[i] - l.e.at[1]) <= STOP_LINK_UNITS) return sec(table.end_tick[i]!);
    }
    return null;
  };
  for (const l of lasting) {
    const max = l.e.t + (l.e.kind === "smoke" ? SMOKE_MAX_S : FIRE_MAX_S);
    const end = l.ended ? l.e.until : lifetime(l.e.kind === "smoke" ? t.smokes : t.infernos, l) ?? max;
    l.e.until = Math.min(stopT, max, Math.max(l.e.t, end));
  }

  // throws from the projectile paths; the thrower comes from the path row, else from its detonation
  const throws: ReplayThrow[] = [];
  if (paths) {
    const byProj = new Map<number, number[]>();
    for (let i = 0; i < paths.n; i++) {
      if (paths.round[i] !== round || !inWindow(paths.tick[i])) continue;
      let a = byProj.get(paths.projectile[i]);
      if (!a) byProj.set(paths.projectile[i], (a = []));
      a.push(i);
    }
    for (const idx of byProj.values()) {
      idx.sort((a, b) => paths.tick[a] - paths.tick[b]);
      const kind = PATH_KIND[paths.type[idx[0]]];
      if (!kind) continue;
      const last = idx[idx.length - 1];
      let thrower = paths.steamid[idx[0]];
      let end = sec(paths.tick[last]);
      const det = startOf.get(paths.entity_id[idx[0]]);
      if (det && det.kind === kind) { thrower ??= det.thrower; end = det.t; }
      if (kind === "molotov") {
        const fire = fires.find((f) => f.tick >= paths.tick[last] && f.tick - paths.tick[last] <= FIRE_LINK_TICKS && Math.hypot(f.at[0] - paths.x[last], f.at[1] - paths.y[last]) <= FIRE_LINK_UNITS);
        if (fire) { thrower ??= fire.thrower; end = sec(fire.tick); }
      }
      const path: number[] = [];
      for (const i of idx) path.push(sec(paths.tick[i]), paths.x[i], paths.y[i], paths.z[i]);
      throws.push({ kind, thrower, side: sideFor(thrower), path, end });
    }
    throws.sort((a, b) => a.path[0] - b.path[0]);
  }

  // bomb: where the planter and the defuser stood (the bomb table carries no position in the engine's schema)
  const B = t.bomb;
  const bomb: ReplayBomb[] = [];
  let plantAt: Vec3 | null = null;
  const posAt = (id: string | null, tick: number): Vec3 | null => {
    const i = id === null ? -1 : players.findIndex((p) => p.id === id);
    if (i < 0) return null;
    let f = 0;
    while (f + 1 < ticks.length && ticks[f + 1] <= tick) f++;
    const s = frames[f].players[i];
    return [s.x, s.y, s.z];
  };
  for (let i = 0; i < B.n; i++) {
    const kind = BOMB[B.event[i]];
    if (B.round[i] !== round || !kind || !inWindow(B.tick[i])) continue;
    const where: Vec3 | null = kind === "explode" ? plantAt : posAt(B.steamid[i], B.tick[i]);
    if (kind === "plant") plantAt = where;
    bomb.push({ t: sec(B.tick[i]), kind, by: B.steamid[i], site: B.site[i], at: where });
  }
  bomb.sort((a, b) => a.t - b.t);

  return {
    round, tickRate: rate, zeroTick: zero, duration: Math.max(0, stopT), endT: sec(endTick),
    winner: sideOf(R.winner_side[ri]), reason: R.reason[ri], players, frames, kills, hits, throws, effects, bomb,
  };
}
