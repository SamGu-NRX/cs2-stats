// Event rules shared by several families: trades, the opening duel, KAST and clutches. Each one is
// checked against HLTV's per-map scoreboards (hltv-exact.test.ts, VALIDATION.md).
import type { KillFact } from "./facts";
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
