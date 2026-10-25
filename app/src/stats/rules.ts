// Per-round rules, following CS Demo Manager's analyzer (github.com/akiver/cs-demo-analyzer, MIT):
// pkg/api/kill.go (trades), pkg/api/player.go (KAST, opening duels, multi-kills, rating) and
// pkg/api/analyzer.go (clutch detection). Comments name the place where this code departs from it.
import { assistersOf, sameSide, type KillRow, type MatchCtx } from "./context";
import { CT, T, type Side } from "./schema";

/** CS Demo Manager's tradeKillDelaySeconds. */
export const TRADE_WINDOW_S = 5;

export interface Trades {
  /** By ctx.kills position: the killer killed someone who had made a kill less than 5 s earlier. */
  tradeKill: boolean[];
  /** By ctx.kills position: the victim's killer was killed less than 5 s later. */
  tradeDeath: boolean[];
}

/**
 * A kill is a trade kill when its victim had killed someone in the same round less than 5 s
 * before; every such earlier death becomes a traded death. Like CS Demo Manager there is no side
 * check, and one kill can trade several deaths but counts as one trade kill.
 */
export function computeTrades(ctx: MatchCtx): Trades {
  const n = ctx.kills.length;
  const tradeKill = new Array<boolean>(n).fill(false);
  const tradeDeath = new Array<boolean>(n).fill(false);
  const window = TRADE_WINDOW_S * ctx.tickrate;
  const pos = new Map(ctx.kills.map((k, j) => [k, j]));
  for (const list of ctx.killsByRound.values()) {
    for (let b = 0; b < list.length; b++) {
      const later = list[b];
      // CS Demo Manager: any kill with a killer, a suicide included (its killer is the victim).
      const killer = later.suicide ? later.victim : later.killer;
      if (killer === null) continue;
      for (let a = 0; a < b; a++) {
        const earlier = list[a];
        if (earlier.killer !== null && earlier.killer === later.victim && later.tick - earlier.tick < window) {
          tradeKill[pos.get(later)!] = true;
          tradeDeath[pos.get(earlier)!] = true;
        }
      }
    }
  }
  return { tradeKill, tradeDeath };
}

/** A kill that counts for player stats: not a team kill or suicide. World deaths count as deaths only. */
export const isEnemyKill = (k: KillRow) => k.killer !== null && !sameSide(k);

/**
 * KAST round: a kill, an assist (flash assists included), survival, or a traded death. As in CS
 * Demo Manager, same-side deaths (team kills and suicides) are skipped entirely, so a player who
 * was team-killed or killed themselves still counts as having survived.
 */
export function kastRound(list: KillRow[], pi: number, tradeDeath: (k: KillRow) => boolean): boolean {
  let survived = true;
  let event = false;
  for (const k of list) {
    if (sameSide(k)) continue;
    if (assistersOf(k).includes(pi)) { event = true; continue; }
    if (k.killer === pi && k.victim !== pi) { event = true; continue; }
    if (k.victim === pi) {
      survived = false;
      if (tradeDeath(k)) event = true;
    }
  }
  return event || survived;
}

/**
 * First kill of the round that is not a team kill, a suicide, or made by a player controlling a
 * bot, as in CS Demo Manager's FirstKillCount/FirstDeathCount (it may be a world death with no
 * killer). Freeze-time kills never reach the context.
 */
export function openingKill(list: KillRow[]): KillRow | null {
  for (const k of list) if (!sameSide(k) && !k.killerBot) return k;
  return null;
}

/** Enemy kills by pi in a round, not counting kills made while controlling a bot (CS Demo Manager). */
export const roundKills = (list: KillRow[], pi: number) => list.reduce((n, k) => (k.killer === pi && isEnemyKill(k) && !k.killerBot ? n + 1 : n), 0);

export interface Clutch {
  ri: number;
  player: number;
  side: Side;
  opponents: number;
  won: boolean;
  survived: boolean;
  kills: number;
}

/**
 * Clutch detection as in CS Demo Manager's analyzer: after each kill, the first time a side has one
 * player left, that player starts a 1vX against the enemies still alive. If both sides are later
 * down to one, the other side's last player also gets a 1v1. Won = the clutcher's side won.
 */
export function detectClutches(ctx: MatchCtx, ri: number): Clutch[] {
  // Population: players alive at freeze end when recorded (rounds.alive0), else everyone on a side.
  const alive = new Set<number>();
  const alive0 = ctx.m.rounds.alive0?.[ri];
  for (let pi = 0; pi < ctx.nPlayers; pi++) {
    if (ctx.side(ri, pi) === null) continue;
    if (alive0 && alive0[pi] === 0) continue;
    alive.add(pi);
  }
  const out: Clutch[] = [];
  let c1: Clutch | null = null;
  let c2: Clutch | null = null;
  const winSide = ctx.m.rounds.winSide[ri];
  // A clutch cannot be scored without the round result.
  if (winSide === null) return [];
  const end = ctx.endTick(ri);
  // Kills and mid-round disconnects (leaves) in tick order; leaving removes the player like a death.
  const lv = ctx.m.leaves;
  const events: { tick: number; k?: KillRow; gone?: number }[] = (ctx.killsByRound.get(ri) ?? []).map((k) => ({ tick: k.tick, k }));
  if (lv) for (let j = 0; j < lv.ri.length; j++) if (lv.ri[j] === ri) events.push({ tick: lv.tick[j], gone: lv.pi[j] });
  events.sort((a, b) => a.tick - b.tick);
  for (const e of events) {
    if (e.gone !== undefined) { alive.delete(e.gone); continue; }
    const k = e.k!;
    for (const c of [c1, c2]) {
      if (!c) continue;
      if (c.player === k.victim) c.survived = false;
      else if (c.player === k.killer) c.kills++;
    }
    alive.delete(k.victim);
    // After round end a kill can still end a clutch, but cannot start one.
    if (end !== null && k.tick > end) continue;
    const ct = [...alive].filter((p) => ctx.side(ri, p) === CT);
    const t = [...alive].filter((p) => ctx.side(ri, p) === T);
    if (!c1 && (ct.length === 1 || t.length === 1)) {
      c1 = ct.length === 1
        ? { ri, player: ct[0], side: CT, opponents: t.length, won: false, survived: true, kills: 0 }
        : { ri, player: t[0], side: T, opponents: ct.length, won: false, survived: true, kills: 0 };
      out.push(c1);
    }
    if (c1 && ct.length === 1 && t.length === 1) {
      c2 = c1.side === CT
        ? { ri, player: t[0], side: T, opponents: 1, won: false, survived: true, kills: 0 }
        : { ri, player: ct[0], side: CT, opponents: 1, won: false, survived: true, kills: 0 };
      out.push(c2);
    }
  }
  for (const c of out) c.won = c.side === winSide;
  // CS Demo Manager can record a "1v0" when a side starts the round with one player; it is not a clutch.
  return out.filter((c) => c.opponents > 0);
}

/**
 * Players alive once the round is over, counting post-round deaths too. This matches the game's
 * own AliveCT/AliveT for every round of the 18:09 fixture, including a T killed by their own bomb
 * after round end; a player hunted down after the round also did not save.
 */
export function aliveAtEnd(ctx: MatchCtx, ri: number): Set<number> {
  const alive = new Set<number>();
  for (let pi = 0; pi < ctx.nPlayers; pi++) if (ctx.side(ri, pi) !== null) alive.add(pi);
  for (const k of ctx.killsByRound.get(ri) ?? []) alive.delete(k.victim);
  return alive;
}

/** Equipment above CS Demo Manager's eco cutoff ($1,000 per player): a real weapon was at stake. */
export const SAVE_MIN_EQUIP = 1000;

/**
 * A save: alive at the end of a round the player's side lost, still holding a primary weapon
 * (rounds.survPrimary, recorded by plugin 1.0.0). Older files lack that field; there a save is
 * survival with more than $1,000 of equipment at freeze end, or survival alone when equipment is
 * unknown. CS Demo Manager has no save definition.
 */
export function isSave(ctx: MatchCtx, ri: number, pi: number, alive: Set<number>): boolean {
  const s = ctx.side(ri, pi);
  const win = ctx.m.rounds.winSide[ri];
  if (s === null || win === null || win === s || !alive.has(pi)) return false;
  const primary = ctx.m.rounds.survPrimary?.[ri]?.[pi];
  if (primary !== undefined && primary !== null) return primary === 1;
  const eq = ctx.m.rounds.equip[ri][pi];
  return eq === null || eq > SAVE_MIN_EQUIP;
}
