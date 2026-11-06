// TRANSITIONAL (see adapter.ts): whose body a player acted in. After dying, a human in a bot match can
// take over a living teammate bot. What he does in that body, and what is done to it, belongs to the
// bot: the game's own per-round stats count it so, as CS Demo Manager does, and the plugin's kills
// already name the body (kills.kBody, kills.vBody). Every table the adapter writes asks this one lookup.
import { KILL_FLAG, type MatchFile } from "./schema";

/**
 * The body player `pi` was in at `tick` of round `ri`: its own (pi), a bot it drove, or null for none,
 * when the file's evidence puts it in no known body (its own body is dead and no bot is named).
 *
 * What the adapter does with none: a row the player made there (a hit, blind, throw, shot or
 * position) is left out, since the file cannot say whose body made it; a row done to it keeps the
 * player as the victim, since a row must name one and the attacker's credit is right either way; a
 * kill there keeps its row with no attacker, so the victim's death stands; a detonation, smoke or fire
 * keeps its row with no thrower, since the utility was there whoever threw it.
 *
 * `observed` asks only for a body the file has seen by that tick: a bot segment that began right after
 * a death, before the bot's first kills row, counts as none. The adapter asks it for a grenade row whose
 * throw tick is unknown, where the given tick (detonation or hit) may fall after the body changed.
 */
export type BodyAt = (pi: number, ri: number, tick: number, o?: { observed?: boolean }) => number | null;

/** A run of ticks [from, to] in one body; `seen` is the first tick the file names that body there. */
interface Segment { body: number; from: number; to: number; seen: number }

/**
 * One timeline per human and round, built from the takeovers table in plugin 1.3.0 files and from
 * the kills before it. Both start the same way: in his own body if he was alive at freeze end
 * (rounds.alive0 = 1), in none otherwise, and out of it the tick after his own death (his kills row
 * with no vBody, outside freeze time). A file whose takeover rows overflowed the plugin's per-round
 * buffer (recon.dropped.takeovers) is read from its kills, since a lost row would leave a body in use
 * too long. Files with neither keep every row with its player, as does a round in which he died in his
 * own body more than once (a respawn session) and every bot, which never takes over a body.
 */
export function bodyLookup(m: MatchFile): BodyAt {
  const table = m.takeovers && !m.recon?.dropped?.takeovers ? m.takeovers : null;
  if (!table && !m.kills.kBody && !m.kills.vBody) return (pi) => pi;
  const K = m.kills;
  const live = K.ri.map((_, i) => i).filter((i) => (K.flags[i] & KILL_FLAG.freeze) === 0).sort((a, b) => K.tick[a] - K.tick[b] || a - b);
  const killsOf = new Map<number, number[]>();
  for (const i of live) killsOf.set(K.ri[i], [...(killsOf.get(K.ri[i]) ?? []), i]);
  const rowsOf = new Map<string, [number, number | null][]>();
  for (let i = 0; i < (table?.ri.length ?? 0); i++) {
    const key = `${table!.ri[i]}:${table!.pi[i]}`;
    rowsOf.set(key, [...(rowsOf.get(key) ?? []), [table!.tick[i], table!.body[i]]]);
  }
  const plan = new Map<string, Segment[]>();
  m.rounds.winSide.forEach((_, ri) => m.players.isBot.forEach((bot, pi) => {
    if (bot) return;
    const kills = killsOf.get(ri) ?? [];
    const deaths = kills.filter((i) => K.victim[i] === pi && (K.vBody?.[i] ?? null) === null).map((i) => K.tick[i]);
    if (deaths.length > 1) return;
    const alive = m.rounds.alive0?.[ri]?.[pi] === 1;
    const key = `${ri}:${pi}`;
    plan.set(key, table ? fromTable(rowsOf.get(key) ?? [], pi, alive, deaths[0]) : fromKills(m, kills, pi, alive, deaths[0]));
  }));
  return (pi, ri, tick, o) => {
    const segments = plan.get(`${ri}:${pi}`);
    if (!segments) return pi;
    const s = segments.find((x) => tick >= x.from && tick <= x.to);
    return !s || (o?.observed && tick < s.seen) ? null : s.body;
  };
}

/**
 * From takeovers rows, each the first tick of its state. A row naming a bot puts him in it; a null row
 * returns him to his own body if it is still alive (no own death at or before the row's tick - 1),
 * else to none. His own death ends his own body on the tick after it.
 */
function fromTable(rows: [number, number | null][], pi: number, alive: boolean, death: number | undefined): Segment[] {
  const ownAlive = (tick: number) => alive && (death === undefined || tick <= death);
  const changes: [number, number | null | "death"][] = [...(death === undefined ? [] : [[death + 1, "death"] as [number, "death"]]), ...rows];
  changes.sort((a, b) => a[0] - b[0] || (a[1] === "death" ? -1 : b[1] === "death" ? 1 : 0));
  const out: Segment[] = [];
  let state: number | null = alive ? pi : null;
  let from = -Infinity;
  for (const [tick, change] of changes) {
    const next = change === "death" ? (state === pi ? null : state) : change === null ? (ownAlive(tick) ? pi : null) : change;
    if (next === state) continue;
    if (state !== null) out.push({ body: state, from, to: tick - 1, seen: from });
    state = next;
    from = tick;
  }
  if (state !== null) out.push({ body: state, from, to: Infinity, seen: from });
  return out;
}

/**
 * From kills, the only rows that name a body: kBody for his kill in a bot's body, vBody for the death
 * of a bot he drove, and neither for his own body. Damage, blinds and grenades name only the
 * controller, so they cannot bound a segment.
 *
 * - Own body: from round start if alive at freeze end, through his own death, death tick included.
 *   Without a recorded own death it ends at his last own-body kill before any bot is named; with no
 *   bot named at all, it lasts the round.
 * - Each bot, in the order the kills name them: it starts the tick after the previous segment if that
 *   segment ended at a recorded death and the bot is new to the round, else at its first kills row
 *   (a bot seen again after another body starts again only at its next row). It ends at its death,
 *   death tick included; without one, at its last kills row when another body follows, else at round
 *   end.
 */
function fromKills(m: MatchFile, kills: number[], pi: number, alive: boolean, death: number | undefined): Segment[] {
  const K = m.kills;
  /** bot-body observations: [tick, body, whether the row is that body's death] */
  const seen: [number, number, boolean][] = [];
  for (const i of kills) {
    if (K.killer[i] === pi && (K.kBody?.[i] ?? null) !== null) seen.push([K.tick[i], K.kBody![i]!, false]);
    if (K.victim[i] === pi && (K.vBody?.[i] ?? null) !== null) seen.push([K.tick[i], K.vBody![i]!, true]);
  }
  const out: Segment[] = [];
  /** the recorded death that ended the previous segment, if it ended at one */
  let after: number | null = null;
  let ownEnd = -Infinity;
  if (alive) {
    if (death !== undefined) {
      ownEnd = death;
      after = death;
    } else if (!seen.length) {
      ownEnd = Infinity;
    } else {
      const own = kills.filter((i) => K.killer[i] === pi && (K.kBody?.[i] ?? null) === null && K.tick[i] < seen[0][0]);
      if (own.length) ownEnd = K.tick[own[own.length - 1]];
    }
    if (ownEnd > -Infinity) out.push({ body: pi, from: -Infinity, to: ownEnd, seen: -Infinity });
  }
  // consecutive observations of one body form one use of it
  const uses: { body: number; first: number; last: number; death: number | null }[] = [];
  for (const [tick, body, died] of seen) {
    if (tick <= ownEnd) continue;
    let u = uses[uses.length - 1];
    if (!u || u.body !== body || u.death !== null) uses.push((u = { body, first: tick, last: tick, death: null }));
    u.last = tick;
    if (died) u.death = tick;
  }
  const used = new Set<number>();
  uses.forEach((u, k) => {
    const from = after === null || used.has(u.body) ? u.first : after + 1;
    out.push({ body: u.body, from, to: u.death ?? (k < uses.length - 1 ? u.last : Infinity), seen: u.first });
    used.add(u.body);
    after = u.death;
  });
  return out;
}
