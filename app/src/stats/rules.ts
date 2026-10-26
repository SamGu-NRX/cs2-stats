// Event rules shared by several families: trades, the opening duel, KAST and clutches. Each one is
// checked against HLTV's per-map scoreboards (hltv-exact.test.ts, VALIDATION.md).
import type { KillFact, RoundFact } from "./facts";
import type { Side } from "./tables";

/**
 * A trade: killing the killer within this many seconds. HLTV does not publish its window; 5.4 s
 * reproduces its traded deaths and KAST best on the joined maps (5.4 s: 3,620 traded-death and 3,679
 * KAST exact of 3,950 player-maps; 5 s: 3,349 and 3,576; VALIDATION.md, pnpm scoreboard-variants).
 * CS Demo Manager uses 5 s, and so does the extractor's internal kills.extractor_trade_kill_5s column
 * (for model/rating3's round fit), which the engine does not read.
 */
export const TRADE_WINDOW_S = 5.4;

/**
 * Marks trade kills and traded deaths in one round's kills (tick order). A later enemy kill is a trade
 * kill when its victim had killed one of the killer's teammates within TRADE_WINDOW_S. It trades one
 * death, the earliest of those, which matches HLTV better than crediting every such death (CS Demo
 * Manager's rule; VALIDATION.md).
 */
export function markTrades(kills: KillFact[], tickRate: number): void {
  const window = TRADE_WINDOW_S * tickRate;
  for (let b = 0; b < kills.length; b++) {
    const later = kills[b];
    if (!later.enemy) continue;
    for (let a = 0; a < b; a++) {
      const earlier = kills[a];
      if (!earlier.enemy || earlier.killer !== later.victim || earlier.victimSide !== later.killerSide) continue;
      if (later.tick - earlier.tick <= window) {
        later.tradeKill = true;
        earlier.traded = true;
        break;
      }
    }
  }
}

/** The opening duel: the round's first enemy kill. */
export function markOpening(kills: KillFact[]): void {
  const first = kills.find((k) => k.enemy);
  if (first) first.opening = true;
}

/**
 * KAST for one player in one round: an enemy kill, a damage assist on an enemy kill, survival, or a
 * traded death. HLTV leaves flash assists out (VALIDATION.md).
 */
export function kastRound(kills: KillFact[], pi: number): boolean {
  let died = false;
  for (const k of kills) {
    if (k.enemy && (k.killer === pi || (k.assister === pi && !k.flashAssist))) return true;
    if (k.victim === pi) {
      died = true;
      if (k.traded) return true;
    }
  }
  return !died;
}

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

/**
 * A round's population: the players alive at its freeze end, by side, and the deaths and disconnects
 * of the live round, after freeze end and up to its end. A player is left out when the source marks
 * them dead at freeze end (player_rounds.alive_at_start, plugin files; README.md "Fields the app
 * reads"), or when they died or disconnected at or before freeze end, whatever that flag says (it is
 * null in files without it). A round without a freeze end has no such cut: all of its deaths and
 * disconnects up to its end are live. Clutches, saves and last alive (closing.ts) and the
 * man-advantage states (matchviews.ts addSituations) all read this, so no view counts a player, or a
 * death, that another leaves out.
 */
export function roundPopulation(
  rf: Pick<RoundFact, "freezeEndTick" | "endTick" | "leaves">,
  rows: Iterable<{ pi: number; side: Side; aliveAtStart: boolean | null } | null>,
  kills: readonly KillFact[],
): { alive: Record<Side, Set<number>>; inRound: (pi: number) => boolean; deaths: KillFact[]; leaves: { tick: number; pi: number }[] } {
  const fe = rf.freezeEndTick;
  const early = (tick: number) => fe !== null && tick <= fe;
  const live = (tick: number) => !early(tick) && tick <= rf.endTick;
  const gone = new Set([...rf.leaves.filter((l) => early(l.tick)).map((l) => l.pi), ...kills.filter((k) => early(k.tick)).map((k) => k.victim)]);
  const alive: Record<Side, Set<number>> = { CT: new Set(), T: new Set() };
  for (const r of rows) if (r && r.aliveAtStart !== false && !gone.has(r.pi)) alive[r.side].add(r.pi);
  const members = new Set([...alive.CT, ...alive.T]);
  return {
    alive, inRound: (pi) => members.has(pi),
    deaths: kills.filter((k) => live(k.tick)).sort((a, b) => a.tick - b.tick),
    leaves: rf.leaves.filter((l) => live(l.tick)),
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
