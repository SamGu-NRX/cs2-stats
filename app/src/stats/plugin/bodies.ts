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
 * Bodies inferred from kills, per human and round. The human is in his own body up to and including
 * his own death (his kills row with no vBody). After it he is in the bodies the kills rows name for
 * him (kBody as killer, vBody as victim), in tick order; each body's use ends at its death, the row
 * with that vBody, death tick included, or at round end. After the last body ends, no body is known:
 * he took over a bot that neither killed nor died, or none, and the lookup returns null.
 *
 * Kills during freeze time are left out, as the adapter leaves them out of the kills table: a player
 * who dies then and respawns plays the live round in his own body. A human dead at freeze end
 * (rounds.alive0 = 0) has no own body in the live round, so only bodies the kills name are his there.
 * A round in which the human died in his own body more than once respawned him (the deathmatch-like
 * sessions the plugin also records), so a death there does not start a takeover and every row stays
 * his; so does a round where he was alive at freeze end and did not die. Bots never take over a body.
 */
function fromKills(m: MatchFile): BodyAt {
  const K = m.kills;
  const order = K.ri.map((_, i) => i).sort((a, b) => K.ri[a] - K.ri[b] || K.tick[a] - K.tick[b] || a - b);
  /** per "ri:pi": the own death tick and the bodies after it, each with the tick its use ends */
  const plan = new Map<string, { death: number; bodies: { body: number; end: number }[] }>();
  const live = order.filter((i) => (K.flags[i] & KILL_FLAG.freeze) === 0);
  const deaths = new Map<string, number[]>();
  for (const i of live) {
    if ((K.vBody?.[i] ?? null) !== null || m.players.isBot[K.victim[i]]) continue;
    const key = `${K.ri[i]}:${K.victim[i]}`;
    deaths.set(key, [...(deaths.get(key) ?? []), K.tick[i]]);
  }
  m.rounds.winSide.forEach((_, ri) => m.players.isBot.forEach((bot, pi) => {
    const own = deaths.get(`${ri}:${pi}`) ?? [];
    const deadAtStart = m.rounds.alive0?.[ri]?.[pi] === 0;
    if (bot) return;
    if (deadAtStart && own.length === 0) plan.set(`${ri}:${pi}`, { death: -Infinity, bodies: [] });
    else if (!deadAtStart && own.length === 1) plan.set(`${ri}:${pi}`, { death: own[0], bodies: [] });
  }));
  for (const i of live) {
    const used: [number, number][] = [];
    if (K.killer[i] !== null && (K.kBody?.[i] ?? null) !== null) used.push([K.killer[i]!, K.kBody![i]!]);
    if ((K.vBody?.[i] ?? null) !== null) used.push([K.victim[i], K.vBody![i]!]);
    for (const [pi, body] of used) {
      const p = plan.get(`${K.ri[i]}:${pi}`);
      if (!p || K.tick[i] <= p.death) continue;
      const last = p.bodies[p.bodies.length - 1];
      if (!last || last.body !== body) p.bodies.push({ body, end: Infinity });
      if (K.victim[i] === pi && K.vBody?.[i] === body) p.bodies[p.bodies.length - 1].end = K.tick[i];
    }
  }
  return (pi, ri, tick) => {
    const p = plan.get(`${ri}:${pi}`);
    if (!p || tick <= p.death) return pi;
    let start = p.death;
    for (const b of p.bodies) {
      if (tick > start && tick <= b.end) return b.body;
      start = b.end;
    }
    return null;
  };
}
