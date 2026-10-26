// The flash tool: one player's flashbangs in a match, each with where it detonated, whom it blinded
// and for how long, and the enemy kills it led to. Leetify's Map Flash Tool shows the same; its
// attribution is unpublished, so ours is below. Read from the tables (detonations, blinds, positions)
// and the match's facts (kills, sides), like the other per-match views (matchviews.ts).
import type { KillFact, MatchFacts } from "./facts";
import type { MatchTables, Side } from "./tables";
import { FLASHED_MIN_S } from "./utility";

/** One player a flash blinded. `at` is where they stood, from the position sample nearest the blind. */
export interface FlashBlind {
  pi: number;
  secs: number;
  team: boolean;
  /** blind longer than FLASHED_MIN_S, Leetify's cut for "flashed" (utility.ts counts the same) */
  flashed: boolean;
  at: [number, number] | null;
}

/** An enemy kill a flash led to: a flash assist for its thrower, a kill while the victim was blind, or both. */
export interface FlashKill {
  victim: number;
  killer: number | null;
  /** seconds since freeze end */
  t: number | null;
  weapon: string;
  headshot: boolean;
  /** the game credited the thrower with a flash assist on this kill */
  assist: boolean;
  /** the victim was blinded by this flash for over FLASHED_MIN_S and died to the thrower's side before it wore off */
  whileBlind: boolean;
}

export interface FlashRow {
  round: number;
  side: Side;
  /** seconds since freeze end at the detonation; null when the round has no freeze end */
  t: number | null;
  /** detonation point, world [x, y]; null when the file records the detonation without a position */
  at: [number, number] | null;
  /** everyone it blinded but the thrower: enemies first, then longest first */
  blinded: FlashBlind[];
  kills: FlashKill[];
}

export interface FlashTool {
  /** the player's flashbangs in round and tick order */
  flashes: FlashRow[];
  /**
   * the player's flashbang throws in the throw log (grenade_throws), in rounds the player has a row;
   * null when the file has no throw log (Valve and plugin files before 1.0.0 log detonations only)
   */
  thrown: number | null;
  /** what the file does not record, in a sentence each; empty when nothing is missing */
  notes: string[];
}

export const NO_GRENADE_EVENTS = "This file records no grenade or flash events.";

const DETONATE = "flash_detonate";

/**
 * The player's flashes. A blind belongs to the detonation its flash_entity_id names in the same
 * round (the extractor's and the plugin's link; in every file seen so far the blind lands on the
 * detonation's tick). A blind without that link is left out and counted in the notes, never placed by
 * guess. A flash led to a kill when either holds:
 * - assist: the kill carries a flash assist for the thrower, and this flash is the thrower's latest
 *   one to have blinded the victim before the kill;
 * - while blind: an enemy this flash blinded for over FLASHED_MIN_S died to the thrower's side before
 *   the blind ran out, Leetify's flash-to-kill (utility.ts flashKills counts the same kills).
 */
export function flashTool(t: MatchTables, f: MatchFacts, player: string): FlashTool {
  const me = f.players.findIndex((p) => p.id === player);
  if (me < 0) throw new Error(`flashTool: ${player} is not among the match's players`);
  const tr = f.match.tickRate;
  const riOf = new Map(f.rounds.map((r) => [r.number, r.ri]));
  const piOf = new Map(f.players.map((p, i) => [p.id, i]));
  const sideOf = new Map(f.pr.map((r) => [r.ri * 1024 + r.pi, r.side]));
  const ev = t.grenade_events;
  const B = t.blinds;

  const g = t.grenade_throws;
  if (!(ev && ev.n) && !B.n && !(g && g.n)) return { flashes: [], thrown: null, notes: [NO_GRENADE_EVENTS] };
  let thrown: number | null = null;
  if (g) {
    thrown = 0;
    for (let i = 0; i < g.n; i++) {
      const ri = riOf.get(g.round[i]);
      if (g.weapon[i] === "flashbang" && g.steamid[i] === player && ri !== undefined && sideOf.has(ri * 1024 + me)) thrown++;
    }
  }

  interface Work { row: FlashRow; ri: number; tick: number; ticks: number[]; credited: Map<KillFact, FlashKill> }
  const work: Work[] = [];
  const byEntity = new Map<string, Work[]>();
  if (ev) for (let i = 0; i < ev.n; i++) {
    if (ev.event[i] !== DETONATE || ev.steamid[i] !== player) continue;
    const ri = riOf.get(ev.round[i]);
    const side = ri === undefined ? undefined : sideOf.get(ri * 1024 + me);
    if (ri === undefined || !side) continue;
    const fe = f.rounds[ri].freezeEndTick;
    const x = ev.x[i];
    const y = ev.y[i];
    const w: Work = {
      row: { round: ev.round[i], side, t: fe === null ? null : (ev.tick[i] - fe) / tr, at: x === null || y === null ? null : [x, y], blinded: [], kills: [] },
      ri, tick: ev.tick[i], ticks: [], credited: new Map(),
    };
    work.push(w);
    if (ev.entity_id[i] !== null) {
      const k = `${ev.round[i]}|${ev.entity_id[i]}`;
      const same = byEntity.get(k);
      if (same) same.push(w); else byEntity.set(k, [w]);
    }
  }

  const near = positionsNear(t, tr);
  let unlinked = 0;
  for (let i = 0; i < B.n; i++) {
    // another thrower's blind never joins this player's flash, even when its entity id matches one of
    // theirs (the game reuses entity ids); a blind whose attacker is unknown can still be theirs
    const by = B.attacker_steamid[i];
    if (by !== null && by !== player) continue;
    const id = B.flash_entity_id[i];
    const cands = id === null ? undefined : byEntity.get(`${B.round[i]}|${id}`);
    // an entity id can come back later in a round: the latest detonation at or before the blind
    const w = cands?.filter((c) => c.tick <= B.tick[i]).sort((a, b) => b.tick - a.tick)[0];
    if (!w) {
      if (by === player && !B.is_self[i]) unlinked++;
      continue;
    }
    const v = piOf.get(B.victim_steamid[i]);
    if (v === undefined || v === me || B.is_self[i]) continue;
    const secs = B.duration[i];
    w.row.blinded.push({ pi: v, secs, team: B.is_team_flash[i], flashed: secs > FLASHED_MIN_S, at: near(B.round[i], B.victim_steamid[i], B.tick[i]) });
    w.ticks.push(B.tick[i]);
  }

  // kills while blind: each blind over the cut, against the kills of its round
  const killsOf = new Map<number, KillFact[]>();
  for (const k of f.kills) { const l = killsOf.get(k.ri); if (l) l.push(k); else killsOf.set(k.ri, [k]); }
  const credit = (w: Work, k: KillFact, how: "assist" | "whileBlind") => {
    let x = w.credited.get(k);
    if (!x) { x = { victim: k.victim, killer: k.killer, t: k.t, weapon: k.weapon, headshot: k.headshot, assist: false, whileBlind: false }; w.credited.set(k, x); w.row.kills.push(x); }
    x[how] = true;
  };
  for (const w of work) {
    w.row.blinded.forEach((b, j) => {
      if (b.team || !b.flashed) return;
      const from = w.ticks[j];
      const until = from + b.secs * tr;
      for (const k of killsOf.get(w.ri) ?? []) if (k.enemy && k.victim === b.pi && k.killerSide === w.row.side && k.tick >= from && k.tick <= until) credit(w, k, "whileBlind");
    });
  }
  // flash assists: to the thrower's latest flash that blinded the victim before the kill
  for (const k of f.kills) {
    if (!k.flashAssist || k.assister !== me || !k.enemy) continue;
    let best: Work | null = null;
    let bestTick = -Infinity;
    for (const w of work) {
      if (w.ri !== k.ri) continue;
      w.row.blinded.forEach((b, j) => { if (b.pi === k.victim && w.ticks[j] <= k.tick && w.ticks[j] > bestTick) { best = w; bestTick = w.ticks[j]; } });
    }
    if (best) credit(best, k, "assist");
  }

  for (const w of work) {
    w.row.blinded.sort((a, b) => Number(a.team) - Number(b.team) || b.secs - a.secs);
    w.row.kills.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  }
  work.sort((a, b) => a.ri - b.ri || a.tick - b.tick);
  const flashes = work.map((w) => w.row);

  const notes: string[] = [];
  if (thrown !== null && thrown > flashes.length) {
    const lost = thrown - flashes.length;
    notes.push(`${lost} of the ${thrown} flashbangs you threw ${lost === 1 ? "has" : "have"} no detonation in this file, so ${lost === 1 ? "it is" : "they are"} not listed.`);
  }
  const unplaced = flashes.filter((x) => !x.at).length;
  if (unplaced) notes.push(`${unplaced} of ${flashes.length} flashes have no detonation point in this file, so they are not on the map.`);
  // a placed flash draws a line to each player it blinded; without a position sample near the blind there is none
  const onMap = flashes.filter((x) => x.at).flatMap((x) => x.blinded);
  const unseen = onMap.filter((b) => !b.at).length;
  if (unseen) notes.push(`${unseen} of the ${onMap.length} players these flashes blinded on the map have no position sample near the blind, so no line is drawn to them.`);
  if (unlinked) notes.push(`${unlinked} ${unlinked === 1 ? "blind names" : "blinds name"} no detonation in this file, so ${unlinked === 1 ? "it is" : "they are"} left out.`);
  return { flashes, thrown, notes };
}

/** A player's [x, y] at the position sample nearest a tick, within half a second and alive; null otherwise (derive.ts posAt's rule). */
function positionsNear(t: MatchTables, tickRate: number): (round: number, id: string, tick: number) => [number, number] | null {
  const P = t.positions;
  const rows = new Map<string, number[]>();
  if (P) for (let i = 0; i < P.n; i++) {
    const k = `${P.round[i]}|${P.steamid[i]}`;
    let l = rows.get(k);
    if (!l) rows.set(k, (l = []));
    l.push(i);
  }
  for (const l of rows.values()) l.sort((a, b) => P!.tick[a] - P!.tick[b]);
  return (round, id, tick) => {
    const l = rows.get(`${round}|${id}`);
    if (!P || !l?.length) return null;
    let lo = 0, hi = l.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (P.tick[l[mid]] < tick) lo = mid + 1; else hi = mid; }
    let best = lo;
    if (lo > 0 && Math.abs(P.tick[l[lo - 1]] - tick) < Math.abs(P.tick[l[lo]] - tick)) best = lo - 1;
    const i = l[best];
    return Math.abs(P.tick[i] - tick) > tickRate / 2 || !P.is_alive[i] ? null : [P.x[i], P.y[i]];
  };
}
