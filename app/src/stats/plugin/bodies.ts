// TRANSITIONAL (see adapter.ts): whose body a player acted in. After dying, a human in a bot match can
// take over a living teammate bot. What he does in that body, and what is done to it, belongs to the
// bot: the game's own per-round stats count it so, as CS Demo Manager does, and the plugin's kills
// already name the body (kills.kBody, kills.vBody). Every table the adapter writes asks this one lookup.
import { GRENADE_WEAPONS, KILL_FLAG, type MatchFile } from "./schema";

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

/** A stretch of the player's own body being alive: from round start or a respawn, to a recorded death or not. */
interface Life { from: number; to: number; died: boolean }

/**
 * A kills.kBody or kills.vBody entry: a body index, null (the player's own body), or undefined when
 * the optional column is absent or shorter than the kills table, which says nothing about the body.
 */
export const bodyEntry = (col: (number | null)[] | undefined, i: number): number | null | undefined => (col && i < col.length ? col[i] : undefined);

/**
 * One timeline per human and round, built from the takeovers table in plugin 1.3.0 files and from
 * the kills before it. Both rest on his own body's lives: from round start if he was alive at freeze
 * end (rounds.alive0 = 1), each ending at his own death (his kills row with vBody null, outside freeze
 * time), and each later one starting at a respawn: his first position row marked alive after that
 * death. The plugin writes his position only while its record of him is alive, which his death clears
 * and only player_spawn sets again (plugin/Core/Recorder.cs Tick, SetAlive); on the 41 recorded files
 * none of his 84,478 position rows falls inside a takeover. So such a row means his own body lives
 * again (a deathmatch-like session the plugin also records). In a takeovers file, a row inside a
 * takeover the table records is not taken as a respawn, since the table names the body. A file whose
 * takeover rows
 * overflowed the plugin's per-round buffer (recon.dropped.takeovers) is read from its kills, since a
 * lost row would leave a body in use too long. Files with neither keep every row with its player, and
 * so does every bot, which never takes over a body.
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
  for (const l of rowsOf.values()) l.sort((a, b) => a[0] - b[0]);
  /** each human's alive position ticks per round, sorted */
  const aliveAt = new Map<string, number[]>();
  const P = m.pos;
  for (let i = 0; i < P.ri.length; i++) {
    if (!P.alive[i] || m.players.isBot[P.pi[i]]) continue;
    const key = `${P.ri[i]}:${P.pi[i]}`;
    aliveAt.set(key, [...(aliveAt.get(key) ?? []), P.tick[i]]);
  }
  for (const l of aliveAt.values()) l.sort((a, b) => a - b);
  const plan = new Map<string, Segment[]>();
  m.rounds.winSide.forEach((_, ri) => m.players.isBot.forEach((bot, pi) => {
    if (bot) return;
    const key = `${ri}:${pi}`;
    const kills = killsOf.get(ri) ?? [];
    const rows = rowsOf.get(key) ?? [];
    const driving = (tick: number) => rows.reduce<number | null>((b, [from, body]) => (from <= tick ? body : b), null) !== null;
    // his own deaths: vBody null, or with the entry missing, a death the takeovers table does not put
    // in a bot (with no table, nothing else names a body, so the event's controller is taken as it)
    const ownDeath = (i: number) => {
      const vb = bodyEntry(K.vBody, i);
      return vb === null || (vb === undefined && !(table && driving(K.tick[i])));
    };
    const deaths = kills.filter((i) => K.victim[i] === pi && ownDeath(i)).map((i) => K.tick[i]);
    const alive = (aliveAt.get(key) ?? []).filter((tick) => !table || !driving(tick));
    // His own body at round start: alive0 when recorded; when missing, from his first explicit own-body
    // observation, a gun or knife kill with kBody null or an alive position row, and unresolved before it.
    const a0 = m.rounds.alive0?.[ri]?.[pi] ?? null;
    const ownKill = kills.find((i) => K.killer[i] === pi && bodyEntry(K.kBody, i) === null && !grenadeKill(m, i));
    const seenOwn = Math.min(ownKill === undefined ? Infinity : K.tick[ownKill], alive[0] ?? Infinity);
    const start = a0 === 1 ? -Infinity : a0 === 0 ? alive[0] : Number.isFinite(seenOwn) ? seenOwn : undefined;
    const own = lives(start, deaths, alive);
    plan.set(key, table ? fromTable(rows, pi, own) : fromKills(m, kills, pi, own, alive));
  }));
  return (pi, ri, tick, o) => {
    const segments = plan.get(`${ri}:${pi}`);
    if (!segments) return pi;
    const s = segments.find((x) => tick >= x.from && tick <= x.to);
    return !s || (o?.observed && tick < s.seen) ? null : s.body;
  };
}

/** A kill by a grenade or its fire: linked to its grenades row, or with a grenade weapon. */
export const grenadeKill = (m: MatchFile, i: number) => (m.kills.nade?.[i] ?? null) !== null || GRENADE_WEAPONS.has(m.weapons[m.kills.weapon[i]] ?? "");

/** His own body's lives in a round, from where the first starts (none: no life), his own deaths and his alive position rows (all sorted). */
function lives(first: number | undefined, deaths: number[], alive: number[]): Life[] {
  const out: Life[] = [];
  let from: number | undefined = first;
  while (from !== undefined) {
    const start: number = from;
    const death: number | undefined = deaths.find((d) => d >= start);
    if (death === undefined) {
      out.push({ from: start, to: Infinity, died: false });
      break;
    }
    out.push({ from: start, to: death, died: true });
    from = alive.find((t) => t > death);
  }
  return out;
}

/**
 * From takeovers rows, each the first tick of its state. A row naming a bot puts him in it; a null row
 * returns him to his own body if it is alive at that tick, else to none. His own body's lives start
 * and end on their own: a death ends it the tick after, a respawn starts it.
 */
function fromTable(rows: [number, number | null][], pi: number, own: Life[]): Segment[] {
  const living = (tick: number) => own.some((l) => tick >= l.from && tick <= l.to);
  const changes: [number, number, number | null | "own" | "dead"][] = [
    ...own.filter((l) => l.died).map((l): [number, number, "dead"] => [l.to + 1, 0, "dead"]),
    ...own.filter((l) => l.from > -Infinity).map((l): [number, number, "own"] => [l.from, 1, "own"]),
    ...rows.map(([tick, body]): [number, number, number | null] => [tick, 2, body]),
  ];
  changes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Segment[] = [];
  let state: number | null = own[0]?.from === -Infinity ? pi : null;
  let from = -Infinity;
  for (const [tick, , change] of changes) {
    const next = change === "dead" ? (state === pi ? null : state) : change === "own" ? pi : change === null ? (living(tick) ? pi : null) : change;
    if (next === state) continue;
    if (state !== null) out.push({ body: state, from, to: tick - 1, seen: from });
    state = next;
    from = tick;
  }
  if (state !== null) out.push({ body: state, from, to: Infinity, seen: from });
  return out;
}

/**
 * From kills, the only rows that name a bot body: kBody for his kill in a bot's body, vBody for the
 * death of a bot he drove. Damage, blinds and grenades name only the controller, so they cannot bound
 * a segment.
 *
 * - Own body: each life. A last life whose end is not recorded but after which the kills name a bot
 *   ends at his last own-body evidence before that bot: a gun or knife kill with kBody null, or an
 *   alive position row (none, and a life from round start, leaves no own segment). A grenade or fire
 *   kill with kBody null is no evidence: the plugin writes null there when he has no pawn at all, as
 *   when the grenade outlives him.
 * - Each bot, in the order the kills name them: it starts the tick after the segment before it if that
 *   segment ended at a recorded death and the bot is new to the round, else at its first kills row (a
 *   bot seen again after another body starts again only at its next row). It ends at its death, death
 *   tick included; without one, at its last kills row when another segment follows, else at round end.
 */
function fromKills(m: MatchFile, kills: number[], pi: number, own: Life[], alive: number[]): Segment[] {
  const K = m.kills;
  /** bot-body observations outside his own body's lives: [tick, body, whether the row is that body's death] */
  const inLife = (tick: number) => own.some((l) => tick >= l.from && tick <= l.to);
  const seen: [number, number, boolean][] = [];
  for (const i of kills) {
    const kb = bodyEntry(K.kBody, i);
    const vb = bodyEntry(K.vBody, i);
    if (K.killer[i] === pi && typeof kb === "number") seen.push([K.tick[i], kb, false]);
    if (K.victim[i] === pi && typeof vb === "number") seen.push([K.tick[i], vb, true]);
  }
  const last = own[own.length - 1];
  if (last && !last.died) {
    const firstBot = seen.find(([tick]) => tick > last.from)?.[0];
    if (firstBot !== undefined) {
      const evidence = [
        ...kills.filter((i) => K.killer[i] === pi && bodyEntry(K.kBody, i) === null && !grenadeKill(m, i)).map((i) => K.tick[i]),
        ...alive,
      ].filter((t) => t >= last.from && t < firstBot);
      if (evidence.length) last.to = Math.max(...evidence);
      else if (last.from > -Infinity) last.to = last.from;
      else own.pop();
    }
  }
  const segments: (Segment & { died: boolean })[] = own.map((l) => ({ body: pi, from: l.from, to: l.to, seen: l.from, died: l.died }));
  // consecutive observations of one body form one use of it
  const uses: { body: number; first: number; last: number; death: number | null }[] = [];
  for (const [tick, body, died] of seen) {
    if (inLife(tick)) continue;
    let u = uses[uses.length - 1];
    if (!u || u.body !== body || u.death !== null) uses.push((u = { body, first: tick, last: tick, death: null }));
    u.last = tick;
    if (died) u.death = tick;
  }
  const used = new Set<number>();
  uses.forEach((u, k) => {
    const before = segments.filter((x) => x.to < u.first).sort((a, b) => b.to - a.to)[0];
    const from = before?.died && !used.has(u.body) ? before.to + 1 : u.first;
    const follows = k < uses.length - 1 || own.some((l) => l.from > u.last);
    segments.push({ body: u.body, from, to: u.death ?? (follows ? u.last : Infinity), seen: u.first, died: u.death !== null });
    used.add(u.body);
  });
  return segments.map(({ died: _, ...x }) => x);
}
