// TRANSITIONAL (see adapter.ts): whose body a player acted in. After dying, a human in a bot match can
// take over a living teammate bot. What he does in that body, and what is done to it, belongs to the
// bot: the game's own per-round stats count it so, as CS Demo Manager does, and the plugin's kills
// already name the body (kills.kBody, kills.vBody). Every table the adapter writes asks this one lookup.
import { KILL_FLAG, type MatchFile, type Takeovers } from "./schema";

/**
 * The player whose body `pi` acted in at `tick` of round `ri`: pi itself, the bot it drove, or null
 * when pi's own body was already dead and the file names no other.
 */
export type BodyAt = (pi: number, ri: number, tick: number) => number | null;

/**
 * Plugin 1.3.0 files say when each takeover starts and ends (takeovers); older files name a body only
 * on kills, so it is inferred from them. So is a file whose takeover rows overflowed the plugin's
 * per-round buffer (recon.dropped.takeovers), since a lost end row would leave a body in use too long.
 * Files with neither keep every row with its player.
 */
export function bodyLookup(m: MatchFile): BodyAt {
  if (m.takeovers && !m.recon?.dropped?.takeovers) return fromTakeovers(m.takeovers);
  if (m.kills.kBody || m.kills.vBody) return fromKills(m);
  return (pi) => pi;
}

/**
 * A takeovers row holds from its tick until the player's next row in the round; before any row the
 * player is in its own body. The plugin stamps a body's end row at its death tick + 1, so rows on the
 * death tick (a same-tick trade) stay with the body.
 */
function fromTakeovers(t: Takeovers): BodyAt {
  const rows = new Map<string, [number, number | null][]>();
  for (let i = 0; i < t.ri.length; i++) {
    const key = `${t.ri[i]}:${t.pi[i]}`;
    const l = rows.get(key);
    if (l) l.push([t.tick[i], t.body[i]]); else rows.set(key, [[t.tick[i], t.body[i]]]);
  }
  for (const l of rows.values()) l.sort((a, b) => a[0] - b[0]);
  return (pi, ri, tick) => {
    let body: number | null = null;
    for (const [from, b] of rows.get(`${ri}:${pi}`) ?? []) {
      if (from > tick) break;
      body = b;
    }
    return body ?? pi;
  };
}

/**
 * Bodies inferred from kills, per human and round, as a timeline of segments that only the file's
 * evidence bounds. Kills rows are the only rows that name a body: kBody for his kill in a bot's body,
 * vBody for the death of a bot he drove, and neither for his own body. Damage, blinds and grenades
 * name only the controller, so they cannot bound a segment.
 *
 * - Own body: from round start when he was alive at freeze end (rounds.alive0), through his own death,
 *   death tick included. Without a recorded own death, it ends at his last kill made in his own body
 *   before any bot-body kill or death; a gap follows.
 * - Each bot body, in the order the kills name them: it starts on the tick after the previous segment
 *   when that segment ended at a recorded death, else at the body's first kills row. It ends at its
 *   death, the row with that vBody, death tick included; without one, at its last kills row when
 *   another body follows, else at round end.
 *
 * A tick in no segment (a gap, or after the last body) has no known body and the lookup returns null.
 * The adapter then leaves out a row he made there and keeps him as the victim of a row done to him.
 *
 * Kills during freeze time are left out, as the adapter leaves them out of the kills table: a player
 * who dies then and respawns plays the live round in his own body. A round in which he died in his
 * own body more than once respawned him (the deathmatch-like sessions the plugin also records), so
 * every row stays his; so does a round he started alive in which no kills row names a body or his
 * death. Bots never take over a body.
 */
function fromKills(m: MatchFile): BodyAt {
  const K = m.kills;
  const live = K.ri.map((_, i) => i).filter((i) => (K.flags[i] & KILL_FLAG.freeze) === 0).sort((a, b) => K.tick[a] - K.tick[b] || a - b);
  const rowsOf = new Map<number, number[]>();
  for (const i of live) rowsOf.set(K.ri[i], [...(rowsOf.get(K.ri[i]) ?? []), i]);
  /** per "ri:pi": segments [from, to] (ticks, inclusive) and the body used in each */
  const plan = new Map<string, { body: number; from: number; to: number }[]>();
  for (const [ri, rows] of rowsOf) {
    m.players.isBot.forEach((bot, pi) => {
      if (bot) return;
      const segments = timeline(m, rows, ri, pi);
      if (segments) plan.set(`${ri}:${pi}`, segments);
    });
  }
  m.rounds.winSide.forEach((_, ri) => m.players.isBot.forEach((bot, pi) => {
    // dead at freeze end and named nowhere: no body at all in the live round
    if (!bot && m.rounds.alive0?.[ri]?.[pi] === 0 && !plan.has(`${ri}:${pi}`)) plan.set(`${ri}:${pi}`, []);
  }));
  return (pi, ri, tick) => {
    const segments = plan.get(`${ri}:${pi}`);
    if (!segments) return pi;
    return segments.find((s) => tick >= s.from && tick <= s.to)?.body ?? null;
  };
}

/** One human's segments in one round from its live kills rows (tick order); null keeps every row his. */
function timeline(m: MatchFile, rows: number[], ri: number, pi: number): { body: number; from: number; to: number }[] | null {
  const K = m.kills;
  const own = (i: number) => K.victim[i] === pi && (K.vBody?.[i] ?? null) === null;
  const deaths = rows.filter(own);
  if (deaths.length > 1) return null;
  /** bot-body observations: [tick, body, whether the row is that body's death] */
  const seen: [number, number, boolean][] = [];
  for (const i of rows) {
    if (K.killer[i] === pi && (K.kBody?.[i] ?? null) !== null) seen.push([K.tick[i], K.kBody![i]!, false]);
    if (K.victim[i] === pi && (K.vBody?.[i] ?? null) !== null) seen.push([K.tick[i], K.vBody![i]!, true]);
  }
  const alive = m.rounds.alive0?.[ri]?.[pi] !== 0;
  if (!deaths.length && !seen.length) return null;
  if (!alive && deaths.length) return null;
  const out: { body: number; from: number; to: number }[] = [];
  /** the tick of the recorded death that ended the previous segment, if it ended at one */
  let after: number | null = null;
  let ownEnd = -Infinity;
  if (alive) {
    if (deaths.length) {
      ownEnd = K.tick[deaths[0]];
      after = ownEnd;
    } else {
      const firstBody = seen[0][0];
      const ownKills = rows.filter((i) => K.killer[i] === pi && (K.kBody?.[i] ?? null) === null && K.tick[i] < firstBody);
      if (ownKills.length) ownEnd = K.tick[ownKills[ownKills.length - 1]];
    }
    if (ownEnd > -Infinity) out.push({ body: pi, from: -Infinity, to: ownEnd });
  }
  // consecutive observations of one body form one use of it
  const uses: { body: number; first: number; last: number; death: number | null }[] = [];
  for (const [tick, body, death] of seen) {
    if (tick <= ownEnd) continue;
    let u = uses[uses.length - 1];
    if (!u || u.body !== body || u.death !== null) uses.push((u = { body, first: tick, last: tick, death: null }));
    u.last = tick;
    if (death) u.death = tick;
  }
  uses.forEach((u, k) => {
    const from = after === null ? u.first : after + 1;
    const to = u.death ?? (k < uses.length - 1 ? u.last : Infinity);
    out.push({ body: u.body, from, to });
    after = u.death;
  });
  return out;
}
