import type { MatchFile, Side } from "./schema";

/** Per-kill facts that several rules share. Index i matches the kills table row. */
export interface KillRow {
  i: number;
  ri: number;
  tick: number;
  killer: number | null;
  victim: number;
  assister: number | null;
  flashAssister: number | null;
  weapon: string;
  flags: number;
  /** Killer and victim on the same side. World deaths and suicides have no killer and are not team kills. */
  teamKill: boolean;
  /** The victim killed themselves (flag 64). CS Demo Manager treats this like a team kill. */
  suicide: boolean;
  /** The killer / victim was controlling a bot's body (kills.kBody / vBody). */
  killerBot: boolean;
  victimBot: boolean;
  /** not recorded by the plugin; kept so the CS Demo Manager rule has a place when it is */
  assisterBot: boolean;
}

/** Same-side death in CS Demo Manager's sense (KillerSide == VictimSide): team kills and suicides. */
export const sameSide = (k: KillRow) => k.teamKill || k.suicide;

/** Players credited with an assist on a kill: the assister and the flash assister, once each. */
export function assistersOf(k: KillRow): number[] {
  if (k.assister === null) return k.flashAssister === null ? [] : [k.flashAssister];
  return k.flashAssister === null || k.flashAssister === k.assister ? [k.assister] : [k.assister, k.flashAssister];
}

/**
 * Indexes a match for the rules. A round is "full" when the kill-by-kill log covers it completely:
 * at or after firstFullRound and not listed in recon.partial (capture interrupted by a reload).
 * Event-based stats use full rounds only.
 */
export interface MatchCtx {
  m: MatchFile;
  nPlayers: number;
  tickrate: number;
  /** Full round indexes, ascending. */
  rounds: number[];
  isFull: (ri: number) => boolean;
  kills: KillRow[];
  killsByRound: Map<number, KillRow[]>;
  side: (ri: number, pi: number) => Side | null;
  /** True when pi plays on the human's team (constant across halves). */
  onHumanTeam: boolean[];
  /** Tick the round ended, or null when unknown. */
  endTick: (ri: number) => number | null;
}

/** Whether the kill log covers round ri completely. Shared by the aim and position aggregates. */
export function fullRoundTest(m: MatchFile): (ri: number) => boolean {
  const partial = new Set(m.recon?.partial ?? []);
  return (ri) => ri >= m.firstFullRound && !partial.has(ri);
}

/** kills.flags bits added by plugin 1.0.0 */
export const FLAG_SUICIDE = 64;
export const FLAG_FREEZE = 128;

export function buildCtx(m: MatchFile): MatchCtx {
  const nPlayers = m.players.key.length;
  const nRounds = m.rounds.winSide.length;
  const isFull = fullRoundTest(m);
  const rounds: number[] = [];
  for (let ri = 0; ri < nRounds; ri++) if (isFull(ri)) rounds.push(ri);
  const side = (ri: number, pi: number) => m.rounds.side[ri]?.[pi] ?? null;

  const onHumanTeam = new Array<boolean>(nPlayers).fill(false);
  for (let pi = 0; pi < nPlayers; pi++) {
    for (let ri = 0; ri < nRounds; ri++) {
      const s = side(ri, pi);
      const h = side(ri, m.human);
      if (s !== null && h !== null) {
        onHumanTeam[pi] = s === h;
        break;
      }
    }
  }

  const k = m.kills;
  const kills: KillRow[] = [];
  const killsByRound = new Map<number, KillRow[]>(rounds.map((ri) => [ri, []]));
  for (let i = 0; i < k.ri.length; i++) {
    const ri = k.ri[i];
    if (!isFull(ri)) continue;
    // CS Demo Manager does not record kills during freeze time at all.
    if (k.flags[i] & FLAG_FREEZE) continue;
    const killer = k.killer[i];
    const row: KillRow = {
      i, ri, tick: k.tick[i], killer, victim: k.victim[i], assister: k.assister[i],
      flashAssister: k.flashAssister[i], weapon: m.weapons[k.weapon[i]] ?? "unknown", flags: k.flags[i],
      teamKill: killer !== null && killer !== k.victim[i] && side(ri, killer) === side(ri, k.victim[i]),
      suicide: (k.flags[i] & FLAG_SUICIDE) !== 0 || killer === k.victim[i],
      // As CS Demo Manager: what a player does in a bot's body does not count for that player.
      killerBot: (k.kBody?.[i] ?? null) !== null, victimBot: (k.vBody?.[i] ?? null) !== null, assisterBot: false,
    };
    kills.push(row);
    killsByRound.get(ri)?.push(row);
  }

  const endTick = (ri: number) => {
    const f = m.rounds.freezeTick[ri];
    const d = m.rounds.durTicks[ri];
    return f !== null && d !== null ? f + d : null;
  };

  return { m, nPlayers, tickrate: m.env.tickrate || 64, rounds, isFull, kills, killsByRound, side, onHumanTeam, endTick };
}
