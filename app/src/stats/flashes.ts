// The flash tool: one player's flashbangs in a match, each with where it detonated, whom it blinded
// and for how long, and the enemy kills it led to. Leetify's Map Flash Tool shows the same; its
// attribution is unpublished, so ours is below. Read from the tables (detonations, blinds, positions)
// and the match's facts (kills, sides), like the other per-match views (matchviews.ts).
import type { KillFact, MatchFacts } from "./facts";
import type { MatchTables, Side } from "./tables";
import { blindWindows, flashDetonations } from "./blinds";
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
   * null when the file logs no throws. A table with no row for anyone is no log: the Valve imports and
   * one of the two pro demos write an empty table although their players threw flashbangs.
   */
  thrown: number | null;
  /** what the file does not record, in a sentence each; empty when nothing is missing */
  notes: string[];
}

export const NO_GRENADE_EVENTS = "This file records no grenade or flash events.";

/**
 * The player's flashes. A blind belongs to a detonation its flash_entity_id names in the same round
 * (the extractor's and the plugin's link; in every file seen so far the blind lands on the
 * detonation's tick): its recorded attacker's latest such detonation at or before it, or with no
 * attacker recorded, the latest by anyone, which makes it this player's only when that one is theirs.
 * A blind without that link is left out and counted in the notes, never placed by guess. A repeated
 * detonation or throw row counts once, and a blind's repeated rows under one detonation are one window
 * (blinds.ts blindWindows, which every view of blinds reads). A flash led to a kill
 * when either holds:
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

  // a throw table with no row for any player is no log (FlashTool.thrown): it cannot say anyone threw none
  const g = t.grenade_throws && t.grenade_throws.n ? t.grenade_throws : null;
  if (!(ev && ev.n) && !B.n && !g) return { flashes: [], thrown: null, notes: [NO_GRENADE_EVENTS] };
  const mine = (round: number) => { const ri = riOf.get(round); return ri !== undefined && sideOf.has(ri * 1024 + me) ? ri : undefined; };

  // The player's detonations among every player's (blinds.ts flashDetonations, repeated rows left out);
  // the blind windows name the one each blind is linked to
  interface Work { row: FlashRow; ri: number; tick: number; entity: number | null; ticks: number[]; credited: Map<KillFact, FlashKill> }
  const work: Work[] = [];
  const byDet = new Map<string, Work>();
  for (const d of flashDetonations(t)) {
    const ri = d.by === player ? mine(d.round) : undefined;
    if (ri === undefined) continue;
    const fe = f.rounds[ri].freezeEndTick;
    const w: Work = {
      row: { round: d.round, side: sideOf.get(ri * 1024 + me)!, t: fe === null ? null : (d.tick - fe) / tr, at: d.x === null || d.y === null ? null : [d.x, d.y], blinded: [], kills: [] },
      ri, tick: d.tick, entity: d.entity, ticks: [], credited: new Map(),
    };
    work.push(w);
    byDet.set(d.key, w);
  }

  // Throws: the player's flashbangs in the throw log, each paired with one of their detonations, by
  // entity id where the throw has one, else the first unpaired detonation of the round at or after it
  let thrown: number | null = null;
  let undetonated = 0;
  if (g) {
    const throws: { round: number; tick: number; entity: number | null }[] = [];
    const logged = new Set<string>();
    for (let i = 0; i < g.n; i++) {
      if (g.weapon[i] !== "flashbang" || g.steamid[i] !== player || mine(g.round[i]) === undefined) continue;
      // a row repeating a throw (same round, tick and entity id) is the same throw
      const key = `${g.round[i]}|${g.tick[i]}|${g.entity_id[i]}`;
      if (logged.has(key)) continue;
      logged.add(key);
      throws.push({ round: g.round[i], tick: g.tick[i], entity: g.entity_id[i] });
    }
    thrown = throws.length;
    const paired = new Set<Work>();
    const pair = (pick: (w: Work) => boolean, tick: number) => {
      const w = work.filter((x) => !paired.has(x) && pick(x) && x.tick >= tick).sort((a, b) => a.tick - b.tick)[0];
      if (w) paired.add(w);
      return !!w;
    };
    throws.sort((a, b) => Number(a.entity === null) - Number(b.entity === null) || a.tick - b.tick);
    for (const th of throws) {
      const ok = th.entity !== null ? pair((w) => w.row.round === th.round && w.entity === th.entity, th.tick) : pair((w) => w.row.round === th.round, th.tick);
      if (!ok) undetonated++;
    }
  }

  const near = positionsNear(t, tr);
  let unlinked = 0;
  let orphaned = 0;
  // each blind linked to its detonation and deduplicated, as the utility measures count them (blinds.ts)
  for (const l of blindWindows(t).values()) for (const b of l) {
    const by = b.attacker;
    if (by !== null && by !== player) continue;
    // linked to a detonation of someone else's: not this player's (an unknown attacker's blind belongs
    // to the latest detonation of its entity by anyone)
    const w = b.det === null ? null : byDet.get(b.det) ?? null;
    if (!w) {
      if (b.det === null && !b.self) {
        if (by === player) unlinked++;
        // no attacker and no detonation to read one from: it may be this player's, and nothing says
        else orphaned++;
      }
      continue;
    }
    const v = piOf.get(b.victim);
    if (v === undefined || v === me || b.self) continue;
    w.row.blinded.push({ pi: v, secs: b.secs, team: b.team, flashed: b.secs > FLASHED_MIN_S, at: near(b.round, b.victim, b.tick) });
    w.ticks.push(b.tick);
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
  if (undetonated) notes.push(`${undetonated} of the ${thrown} flashbangs you threw ${undetonated === 1 ? "has" : "have"} no detonation in this file, so ${undetonated === 1 ? "it is" : "they are"} not listed.`);
  // without a throw log and without a detonation of theirs, the file cannot say whether they threw one
  if (thrown === null && !flashes.length) notes.push("None of your flashbangs has a recorded detonation in this file, and it logs no throws.");
  const unplaced = flashes.filter((x) => !x.at).length;
  if (unplaced) notes.push(`${unplaced} of ${flashes.length} flashes have no detonation point in this file, so they are not on the map.`);
  // a line runs to a blinded player only from a placed flash to a position sample near the blind
  const blinded = flashes.flatMap((x) => x.blinded);
  const unseen = blinded.filter((b) => !b.at).length;
  if (unseen) notes.push(`${unseen} of the ${blinded.length} players these flashes blinded have no position sample near the blind, so no line can be drawn to them.`);
  if (orphaned) notes.push(`${orphaned} ${orphaned === 1 ? "blind has" : "blinds have"} neither a recorded attacker nor a matching detonation in this file, so ${orphaned === 1 ? "it is" : "they are"} left out.`);
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
