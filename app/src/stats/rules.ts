// Event rules shared by several families: trades, the opening duel, KAST and clutches, each checked
// against HLTV's per-map scoreboards (hltv-exact.test.ts, VALIDATION.md), and Leetify's cut for a
// flashed player.
import type { KillFact, RoundFact } from "./facts";
import type { Side } from "./tables";

/**
 * A trade: killing the killer within this many seconds. HLTV does not publish its window; 5.4 s
 * reproduces its traded deaths and KAST best on the joined maps (5.4 s: 3,620 traded-death and 3,679
 * KAST exact of 3,950 player-maps; 5 s: 3,349 and 3,576; VALIDATION.md, pnpm scoreboard-variants).
 * CS Demo Manager uses 5 s, and so does the extractor's internal kills.extractor_trade_kill_5s column
 * (for model/rating3's round fit), which the engine does not read.
 *
 * On the 1,610 maps joined to their HLTV pages through their demos (16,100 player-maps), 5.5 s
 * reproduces more of HLTV: traded deaths exact on 14,868 against 14,798, KAST on 15,187 against 15,134
 * (with world deaths not counted), and the swing credit fit finds 5.5 s too. It also moves five
 * player-maps of the pinned gate maps (hltv-exact.test.ts) one KAST round off HLTV, so the window stays
 * until the gate is re-pinned on that evidence (issue #18; VALIDATION.md).
 */
export const TRADE_WINDOW_S = 5.4;

/** Leetify: blind longer than this counts as flashed. */
export const FLASHED_MIN_S = 1.1;

/**
 * Marks trade kills and traded deaths in one round's kills (tick order). A later enemy kill is a trade
 * kill when its victim had killed one of the killer's teammates within TRADE_WINDOW_S. It trades one
 * death, the earliest of those, which matches HLTV better than crediting every such death (CS Demo
 * Manager's rule; VALIDATION.md).
 */
export function markTrades(kills: KillFact[], tickRate: number, rf: Pick<RoundFact, "freezeEndTick">): void {
  const window = TRADE_WINDOW_S * tickRate;
  // A kill before freeze end is no trade and cannot be traded (see onRoster). A kill after the round's
  // end still trades, as HLTV counts it: bounding trades at the round's end moves the engine away from
  // HLTV on the 371 joined pro maps (pnpm hltv-check: traded deaths exact on 3,354 player-maps instead
  // of 3,401, KAST on 3,443 instead of 3,460).
  const counts = (k: KillFact) => k.enemy && afterFreezeEnd(rf, k.tick);
  for (let b = 0; b < kills.length; b++) {
    const later = kills[b];
    if (!counts(later)) continue;
    for (let a = 0; a < b; a++) {
      const earlier = kills[a];
      if (!counts(earlier) || earlier.killer !== later.victim || earlier.victimSide !== later.killerSide) continue;
      if (later.tick - earlier.tick <= window) {
        later.tradeKill = true;
        earlier.traded = true;
        break;
      }
    }
  }
}

/**
 * The opening duel: the live round's first enemy kill. A kill before freeze end or after the round's
 * end (an exit frag) is none (see onRoster); on the pro maps no round's first enemy kill comes after
 * its end, so HLTV's Op.K-D does not tell either way.
 */
export function markOpening(kills: KillFact[], rf: Pick<RoundFact, "freezeEndTick" | "endTick">): void {
  const first = kills.find((k) => k.enemy && liveKill(k, rf));
  if (first) first.opening = true;
}

/**
 * KAST for one player in one round on their roster: an enemy kill, a damage assist on an enemy kill,
 * survival, or a traded death. HLTV leaves flash assists out (VALIDATION.md). Only a live kill is ever
 * traded (markTrades). A player who disconnected in the live round (`left`) did not survive it.
 */
export function kastRound(kills: KillFact[], pi: number, left: boolean): boolean {
  for (const k of kills) {
    if (k.enemy && (k.killer === pi || (k.assister === pi && !k.flashAssist))) return true;
    if (k.victim === pi && k.traded) return true;
  }
  return survives(kills, pi, left);
}

/**
 * A death the world dealt, credited to the player themself: a fall or a map hazard. HLTV's scoreboard
 * does not count it as a death: its D leaves it out on 120 of the 123 joined player-maps that have one
 * (other suicides, by a player's own grenade or fire, it counts on all 37), and its KAST treats the
 * player as alive (VALIDATION.md).
 */
export const worldDeath = (k: KillFact) => k.killer === k.victim && k.weapon === "world";

/**
 * KAST's S: the player was not killed in the round, a world death aside (worldDeath), and did not
 * disconnect in its live part (`left`). The scoreboard's KAST and the eco-adjusted KAST (rating3.ts)
 * both read it.
 */
export const survives = (kills: readonly KillFact[], pi: number, left: boolean) =>
  !left && !kills.some((k) => k.victim === pi && !worldDeath(k));

export interface Clutch {
  pi: number;
  side: Side;
  /** enemies alive when the player became the last of their side */
  opponents: number;
  won: boolean;
  /** the index in `kills` of the last death before the clutch began; -1 when none came before it */
  from: number;
  /** the tick of the death or disconnect that left the player alone; null when the round started that way */
  tick: number | null;
}

// ---------------------------------------------------------------- who took part in a round
//
// One rule for every stat that assumes a player took part, in three parts:
// - on the roster (onRoster): the round counts for the player (rounds played, won and lost, the
//   denominators of every per-round rate and of KAST). Off it when the source marks them dead at freeze
//   end (player_rounds.alive_at_start, plugin files; README.md "Fields the app reads") or when they
//   disconnected at or before freeze end: they never played the round. A player killed at or before
//   freeze end stays on it: the death is that round's, and HLTV counts both the round and the death
//   (astral-vs-iberian-soul m1-cache, a gate map in hltv-exact.test.ts, has one, from the bomb of the
//   round before, and matches HLTV exactly on deaths and KAST).
// - in the live round (roundPopulation): on the roster and not killed at or before freeze end. The
//   clutch, last-alive and man-advantage counts start from these players.
// - the live round's events (afterFreezeEnd, liveKill): kills and disconnects after freeze end, up to
//   the round's end. Only these make an opening duel or start a clutch. A kill before freeze end is
//   not a duel (nobody can shoot then; the ones in the data are suicides and the bomb of the round
//   before), and is no trade either. A kill after the round's end (an exit frag) is no opening, but it
//   can trade, as HLTV counts it (markTrades). Kills outside the live round still count in K, D and
//   assists, as the game and HLTV count them, and so in KAST's kill and assist.
//   A disconnect in the live round ends the player's round alive but not surviving it: no survival,
//   no KAST by survival, and their time alive stops there.
// - events of a player off the roster: roster.ts rosterTables removes every one of them from the
//   match's tables before derive or any view reads them, and counts what it removed by kind in
//   MatchInfo.inputs.offRoster, which the match view shows.
// A round without a freeze end has no such cut: all of its kills and disconnects are live.

/** A tick in the live round's span from freeze end on (any tick for a round without a freeze end). */
export const afterFreezeEnd = (rf: Pick<RoundFact, "freezeEndTick">, tick: number) => rf.freezeEndTick === null || tick > rf.freezeEndTick;

/** A kill in the live round: after freeze end and at or before the round's end. */
export const liveKill = (k: Pick<KillFact, "tick">, rf: Pick<RoundFact, "freezeEndTick" | "endTick">) => afterFreezeEnd(rf, k.tick) && k.tick <= rf.endTick;

/**
 * The round counts for a player with a side: see the rule above. A death of theirs at or before freeze
 * end keeps them on it even when the source also marks them dead at freeze end, as that death is the
 * round's; a disconnect at or before freeze end takes them off it all the same.
 */
export function onRoster(rf: Pick<RoundFact, "freezeEndTick" | "leaves">, pi: number, aliveAtStart: boolean | null, kills: readonly Pick<KillFact, "tick" | "victim">[]): boolean {
  if (rf.leaves.some((l) => l.pi === pi && !afterFreezeEnd(rf, l.tick))) return false;
  return aliveAtStart !== false || kills.some((k) => k.victim === pi && !afterFreezeEnd(rf, k.tick));
}

/** The live round's disconnects of living players: after freeze end, up to the round's end. */
export const liveLeaves = (rf: Pick<RoundFact, "freezeEndTick" | "endTick" | "leaves">) => rf.leaves.filter((l) => afterFreezeEnd(rf, l.tick) && l.tick <= rf.endTick);

/**
 * A round's population: the players in the live round, by side (the round's player-rounds, which exist
 * only for players on the roster, less those killed at or before freeze end), with the live round's
 * deaths, up to its end, and disconnects. Clutches, saves and last alive (closing.ts), swing and the
 * man-advantage states (matchviews.ts addSituations) all read this, so no view counts a player, or a
 * death, that another leaves out.
 */
export function roundPopulation(
  rf: Pick<RoundFact, "freezeEndTick" | "endTick" | "leaves">,
  rows: Iterable<{ pi: number; side: Side } | null>,
  kills: readonly KillFact[],
): { alive: Record<Side, Set<number>>; inRound: (pi: number) => boolean; deaths: KillFact[]; leaves: { tick: number; pi: number }[] } {
  const killedEarly = new Set(kills.filter((k) => !afterFreezeEnd(rf, k.tick)).map((k) => k.victim));
  const alive: Record<Side, Set<number>> = { CT: new Set(), T: new Set() };
  for (const r of rows) if (r && !killedEarly.has(r.pi)) alive[r.side].add(r.pi);
  const members = new Set([...alive.CT, ...alive.T]);
  return {
    alive, inRound: (pi) => members.has(pi),
    deaths: kills.filter((k) => afterFreezeEnd(rf, k.tick) && k.tick <= rf.endTick).sort((a, b) => a.tick - b.tick),
    // roster.ts drops an off-roster player's disconnects; this keeps the contract for any input
    leaves: liveLeaves(rf).filter((l) => members.has(l.pi)),
  };
}

/**
 * Clutch situations (CS Demo Manager's analyzer, MIT): the first time a side is down to one player,
 * that player starts a 1vX against the enemies alive. If both sides then reach one player, the other
 * side's last player gets a 1v1 too. `alive` is each side's players. When `atStart` says `alive` is the
 * round-start roster, the counts are read before the first death as well, so a side that starts the
 * round with one player (after a disconnect) is in a clutch before any kill; otherwise only after deaths.
 * `leaves` are living players who disconnected mid-round: each leaves the alive counts at its tick, as
 * a death does (a death first when both fall on one tick), as the man-advantage states read them
 * (matchviews.ts addSituations).
 */
export function detectClutches(kills: KillFact[], alive: Record<Side, Set<number>>, winner: Side | null, atStart: boolean, leaves: readonly { tick: number; pi: number }[] = []): Clutch[] {
  if (winner === null) return [];
  const live: Record<Side, Set<number>> = { CT: new Set(alive.CT), T: new Set(alive.T) };
  const out: Clutch[] = [];
  let first: Clutch | null = null;
  const check = (from: number, tick: number | null) => {
    const ct = live.CT.size;
    const t = live.T.size;
    if (!first && (ct === 1 || t === 1)) {
      const side: Side = ct === 1 ? "CT" : "T";
      first = { pi: [...live[side]][0], side, opponents: side === "CT" ? t : ct, won: side === winner, from, tick };
      if (first.opponents > 0) out.push(first);
    }
    if (first && ct === 1 && t === 1 && out.length < 2) {
      const side: Side = first.side === "CT" ? "T" : "CT";
      out.push({ pi: [...live[side]][0], side, opponents: 1, won: side === winner, from, tick });
    }
  };
  if (atStart) check(-1, null);
  // each death, and each disconnect after the deaths at or before its tick, in tick order
  const gone = [
    ...kills.map((k, i) => ({ tick: k.tick, pi: k.victim, from: i, leave: 0 })),
    ...leaves.map((l) => ({ tick: l.tick, pi: l.pi, from: kills.filter((k) => k.tick <= l.tick).length - 1, leave: 1 })),
  ].sort((a, b) => a.tick - b.tick || a.leave - b.leave || a.from - b.from);
  for (const e of gone) {
    live.CT.delete(e.pi);
    live.T.delete(e.pi);
    check(e.from, e.tick);
  }
  return out;
}
