// Additive per-player counters for one match. Profiles and bot careers are sums of these, so every
// ratio is computed from totals rather than averaged per match.
import { assistersOf, sameSide, type MatchCtx } from "./context";
import { BUY_TYPES, teamBuyType, type BuyType } from "./economy";
import type { RatingInputs } from "./rating";
import { emptyHltv, type HltvCounts } from "./hltv";
import { emptyR3, type R3Inputs } from "./rating3";
import { emptyRoleCounts, type RoleCounts } from "./role";
import { aliveAtEnd, detectClutches, isEnemyKill, isSave, kastRound, openingKill, roundKills, type Clutch, type Trades } from "./rules";
import { CT, T, type Side } from "./schema";
import type { KillSwing, SwingResult } from "./swing";
import { countUtility, emptyUtil, type UtilSlice } from "./utility";
import { isSniper, isUtility, weaponClass, type WeaponClass } from "./weapons";

export const WEAPON_CLASSES: WeaponClass[] = ["rifle", "sniper", "smg", "heavy", "pistol", "grenade", "knife", "other"];

/** "Saved a teammate": killing an enemy who had damaged that teammate in the last 2 s, while the teammate lives. */
export const SAVE_WINDOW_S = 2;

export type Slice = RatingInputs;
const slice = (): Slice => ({ rounds: 0, kills: 0, deaths: 0, assists: 0, dmg: 0, kastRounds: 0 });

/**
 * Basic counters (rounds, kills, deaths, assists, damage, KAST, HS, wins, multi-kills, the slices)
 * cover every round with stats, including "lite" rounds that have only the game's round totals.
 * Event counters (openings, trades, clutches, sniping, utility, swing, saves, time alive) need the
 * kill-by-kill log and cover full rounds only; their denominators are the full* fields.
 */
export interface Counters extends RatingInputs {
  matches: number;
  /** rounds with the kill-by-kill log, and the kills, deaths and lost rounds within them */
  fullRounds: number;
  fullKills: number;
  fullDeaths: number;
  fullLost: number;
  roundsWon: number;
  lostRounds: number;
  hsKills: number;
  killsWon: number;
  dmgWon: number;
  roundsWithKill: number;
  multiKillRounds: number;
  /** rounds with exactly 0..5 kills */
  kc: number[];
  openingKills: number;
  openingDeaths: number;
  openingWins: number;
  openingDeathsTraded: number;
  tradeKills: number;
  tradedDeaths: number;
  assistedKills: number;
  savedTeammate: number;
  savedByTeammate: number;
  supportRounds: number;
  sniperKills: number;
  sniperRounds: number;
  sniperMultiRounds: number;
  sniperOpeningKills: number;
  utilDmg: number;
  utilKills: number;
  nadesThrown: number;
  flashesThrown: number;
  flashAssists: number;
  enemyBlindMs: number;
  enemiesFlashed: number;
  clutchPoints: number;
  lastAlive: number;
  /** 1v1..1v5 attempts and wins */
  clutchN: number[];
  clutchW: number[];
  aliveSecs: number;
  aliveRounds: number;
  saves: number;
  swing: number;
  swingRounds: number;
  weaponKills: number[];
  pistol: Slice;
  sideT: Slice;
  sideCT: Slice;
  /** by own team's buy type, in BUY_TYPES order */
  own: Slice[];
  /** by the opponents' buy type */
  opp: Slice[];
  /** utility usage by side */
  util: { t: UtilSlice; ct: UtilSlice };
  /** Rating 3.0 (approx.) inputs over full rounds; filled by deriveMatch (rating3.ts r3Inputs) */
  r3: R3Inputs;
  /** position evidence for the role (role.ts roleCounts); filled by deriveMatch */
  role: RoleCounts;
  /** inputs for the HLTV-named sub-stats (hltv.ts hltvCounts); filled by deriveMatch */
  hl: HltvCounts;
}

export function emptyCounters(): Counters {
  return {
    ...slice(), matches: 0, fullRounds: 0, fullKills: 0, fullDeaths: 0, fullLost: 0, roundsWon: 0, lostRounds: 0, hsKills: 0, killsWon: 0, dmgWon: 0, roundsWithKill: 0,
    multiKillRounds: 0, kc: [0, 0, 0, 0, 0, 0], openingKills: 0, openingDeaths: 0, openingWins: 0,
    openingDeathsTraded: 0, tradeKills: 0, tradedDeaths: 0, assistedKills: 0, savedTeammate: 0, savedByTeammate: 0,
    supportRounds: 0, sniperKills: 0, sniperRounds: 0, sniperMultiRounds: 0, sniperOpeningKills: 0, utilDmg: 0,
    utilKills: 0, nadesThrown: 0, flashesThrown: 0, flashAssists: 0, enemyBlindMs: 0, enemiesFlashed: 0, clutchPoints: 0, lastAlive: 0,
    clutchN: [0, 0, 0, 0, 0], clutchW: [0, 0, 0, 0, 0], aliveSecs: 0, aliveRounds: 0, saves: 0, swing: 0, swingRounds: 0,
    weaponKills: WEAPON_CLASSES.map(() => 0), pistol: slice(), sideT: slice(), sideCT: slice(),
    own: BUY_TYPES.map(slice), opp: BUY_TYPES.map(slice), util: { t: emptyUtil(), ct: emptyUtil() }, r3: emptyR3(),
    role: emptyRoleCounts(), hl: emptyHltv(),
  };
}

type Num = number | number[] | Slice | Slice[];
/** a += b, field by field. */
export function addCounters<C extends object>(a: C, b: C): C {
  const A = a as Record<string, Num>;
  const B = b as Record<string, Num>;
  for (const key of Object.keys(B)) {
    const x = A[key];
    const y = B[key];
    if (typeof y === "number") A[key] = (x as number) + y;
    else if (Array.isArray(y)) {
      (y as (number | Slice)[]).forEach((v, i) => {
        const arr = x as (number | Slice)[];
        if (typeof v === "number") arr[i] = (arr[i] as number) + v;
        else addCounters(arr[i] as Slice, v);
      });
    } else addCounters(x as Slice, y);
  }
  return a;
}

export interface RoundFacts {
  ri: number;
  buy: Record<Side, BuyType | null>;
  clutches: Clutch[];
  alive: Set<number>;
}

interface BasicRound {
  s: Side; win: Side | null; own: BuyType | null; opp: BuyType | null; isPistol: boolean;
  kills: number; deaths: number; assists: number; dmg: number; kast: number; hs: number;
}

/** The counters every round with stats contributes to, full or lite. */
function addBasic(c: Counters, r: BasicRound) {
  const add = (x: Slice) => { x.rounds++; x.kills += r.kills; x.deaths += r.deaths; x.assists += r.assists; x.dmg += r.dmg; x.kastRounds += r.kast; };
  add(c);
  add(r.s === T ? c.sideT : c.sideCT);
  if (r.isPistol) add(c.pistol);
  if (r.own) add(c.own[BUY_TYPES.indexOf(r.own)]);
  if (r.opp) add(c.opp[BUY_TYPES.indexOf(r.opp)]);
  c.hsKills += r.hs;
  const won = r.win === r.s;
  if (won) { c.roundsWon++; c.killsWon += r.kills; c.dmgWon += r.dmg; } else if (r.win !== null) c.lostRounds++;
  if (r.kills > 0) c.roundsWithKill++;
  if (r.kills > 1) c.multiKillRounds++;
  c.kc[Math.min(5, r.kills)]++;
}

/** Counters for every player in the match, plus per-round facts the match page reuses. */
export function countMatch(ctx: MatchCtx, trades: Trades, swingResult: SwingResult = { swings: [], unknownRounds: new Set(), available: false }): { counters: Counters[]; rounds: RoundFacts[] } {
  const swing: KillSwing[] = swingResult.swings;
  const m = ctx.m;
  const C = Array.from({ length: ctx.nPlayers }, emptyCounters);
  C.forEach((c) => (c.matches = 1));
  const pos = new Map(ctx.kills.map((k, j) => [k, j]));
  const traded = (k: (typeof ctx.kills)[number]) => trades.tradeDeath[pos.get(k)!];
  const tr = ctx.tickrate;

  // damage rows by round
  const dmgByRound = new Map<number, number[]>();
  for (let j = 0; j < m.damage.ri.length; j++) {
    const ri = m.damage.ri[j];
    if (!ctx.isFull(ri)) continue;
    let l = dmgByRound.get(ri);
    if (!l) dmgByRound.set(ri, (l = []));
    l.push(j);
  }
  const swingByRound = new Map<number, KillSwing[]>();
  for (const s of swing) {
    const ri = ctx.kills[s.k].ri;
    let l = swingByRound.get(ri);
    if (!l) swingByRound.set(ri, (l = []));
    l.push(s);
  }

  const facts: RoundFacts[] = [];
  for (const ri of ctx.rounds) {
    const list = ctx.killsByRound.get(ri) ?? [];
    const win = m.rounds.winSide[ri];
    const buy = { [T]: teamBuyType(ctx, ri, T), [CT]: teamBuyType(ctx, ri, CT) } as Record<Side, BuyType | null>;
    const clutches = detectClutches(ctx, ri);
    const alive = aliveAtEnd(ctx, ri);
    facts.push({ ri, buy, clutches, alive });
    const open = openingKill(list);
    const freeze = m.rounds.freezeTick[ri];
    const end = ctx.endTick(ri);
    const isPistol = buy[T] === "pistol";

    // per-player damage this round (enemy damage only, as CS Demo Manager's isValidPlayerDamageEvent)
    const dmg = new Array<number>(ctx.nPlayers).fill(0);
    const util = new Array<number>(ctx.nPlayers).fill(0);
    for (const j of dmgByRound.get(ri) ?? []) {
      const a = m.damage.attacker[j];
      const v = m.damage.victim[j];
      if (a === null || a === v || ctx.side(ri, a) === ctx.side(ri, v)) continue;
      dmg[a] += m.damage.dmg[j];
      if (isUtility(m.weapons[m.damage.weapon[j]] ?? "")) util[a] += m.damage.dmg[j];
    }

    // saved teammate: the victim of this kill had damaged a teammate of the killer in the last 2 s
    const savedBy = new Map<number, Set<number>>(); // killer -> saved teammates
    for (const k of list) {
      if (!isEnemyKill(k)) continue;
      const killerSide = ctx.side(ri, k.killer!);
      for (const j of dmgByRound.get(ri) ?? []) {
        const t = m.damage.tick[j];
        if (m.damage.attacker[j] !== k.victim || t > k.tick || t < k.tick - SAVE_WINDOW_S * tr) continue;
        const mate = m.damage.victim[j];
        if (mate === k.killer || ctx.side(ri, mate) !== killerSide) continue;
        const mateDied = list.some((x) => x.victim === mate && x.tick <= k.tick);
        if (mateDied) continue;
        let s = savedBy.get(k.killer!);
        if (!s) savedBy.set(k.killer!, (s = new Set()));
        s.add(mate);
      }
    }

    for (let pi = 0; pi < ctx.nPlayers; pi++) {
      const s = ctx.side(ri, pi);
      if (s === null) continue;
      const c = C[pi];
      const won = win === s;
      const kills = roundKills(list, pi);
      // As CS Demo Manager: deaths and assists while controlling a bot do not count for the player;
      // an assist is the assister or the flash assister, once per kill, on an enemy victim.
      const deaths = list.filter((k) => k.victim === pi && !k.victimBot).length;
      const assists = list.filter((k) => assistersOf(k).includes(pi) && !k.assisterBot && ctx.side(ri, pi) !== ctx.side(ri, k.victim)).length;
      const kast = kastRound(list, pi, traded) ? 1 : 0;
      const hs = list.filter((k) => k.killer === pi && isEnemyKill(k) && !k.killerBot && (k.flags & 1) !== 0).length;

      addBasic(c, { s, win, own: buy[s], opp: buy[(5 - s) as Side], isPistol, kills, deaths, assists, dmg: dmg[pi], kast, hs });
      c.fullRounds++;
      if (swingResult.available && !swingResult.unknownRounds.has(ri)) c.swingRounds++;
      c.fullKills += kills;
      c.fullDeaths += deaths;
      if (!won && win !== null) c.fullLost++;
      c.utilDmg += util[pi];

      if (open) {
        if (open.killer === pi) {
          c.openingKills++;
          if (won) c.openingWins++;
          if (isSniper(open.weapon)) c.sniperOpeningKills++;
        }
        // a death while controlling a bot is not the player's (as for deaths above)
        if (open.victim === pi && !open.victimBot) {
          c.openingDeaths++;
          if (traded(open)) c.openingDeathsTraded++;
        }
      }
      let sniper = 0;
      for (const k of list) {
        if (k.killer === pi && isEnemyKill(k) && !k.killerBot) {
          if (trades.tradeKill[pos.get(k)!]) c.tradeKills++;
          if (k.assister !== null && k.assister !== pi) c.assistedKills++;
          if (isSniper(k.weapon)) sniper++;
          if (isUtility(k.weapon)) c.utilKills++;
          c.weaponKills[WEAPON_CLASSES.indexOf(weaponClass(k.weapon))]++;
        }
        if (k.victim === pi && !sameSide(k) && !k.victimBot && traded(k)) c.tradedDeaths++;
        if (k.flashAssister === pi && !sameSide(k)) c.flashAssists++;
      }
      c.sniperKills += sniper;
      if (sniper > 0) c.sniperRounds++;
      if (sniper > 1) c.sniperMultiRounds++;
      const flashAssistsHere = list.some((k) => k.flashAssister === pi && !sameSide(k));
      if ((assists > 0 || flashAssistsHere) && kills === 0) c.supportRounds++;
      c.savedTeammate += savedBy.get(pi)?.size ?? 0;
      for (const set of savedBy.values()) if (set.has(pi)) c.savedByTeammate++;

      if (freeze !== null && end !== null) {
        const death = list.find((k) => k.victim === pi);
        const until = death && death.tick < end ? death.tick : end;
        c.aliveSecs += Math.max(0, until - freeze) / tr;
        c.aliveRounds++;
      }
      if (isSave(ctx, ri, pi, alive)) c.saves++;
    }

    for (const cl of clutches) {
      const c = C[cl.player];
      c.lastAlive++;
      c.clutchN[cl.opponents - 1]++;
      if (cl.won) { c.clutchW[cl.opponents - 1]++; c.clutchPoints += cl.opponents; }
    }

    countUtility(ctx, ri, C.map((c) => c.util));

    // grenades and blinds
    const g = m.grenades;
    for (let j = 0; j < g.ri.length; j++) {
      if (g.ri[j] !== ri || g.thrower[j] === null) continue;
      C[g.thrower[j]!].nadesThrown++;
      if (g.type[j] === "flash") C[g.thrower[j]!].flashesThrown++;
    }
    const b = m.blinds;
    for (let j = 0; j < b.ri.length; j++) {
      const a = b.attacker[j];
      if (b.ri[j] !== ri || a === null || b.ms[j] <= 0) continue;
      if (ctx.side(ri, a) === ctx.side(ri, b.victim[j])) continue;
      C[a].enemiesFlashed++;
      C[a].enemyBlindMs += b.ms[j];
    }

    for (const sw of swingByRound.get(ri) ?? []) for (const [p, v] of sw.credits) C[p].swing += v;
  }
  // Lite rounds: not covered by the kill log (before firstFullRound, or partial), but the game's
  // per-round totals exist (rounds.basic). They count for the basic stats; KAST there cannot
  // include traded deaths.
  const basic = m.rounds.basic;
  for (let ri = 0; ri < m.rounds.winSide.length && basic; ri++) {
    if (ctx.isFull(ri)) continue;
    const row = basic[ri];
    const win = m.rounds.winSide[ri];
    if (!row) continue;
    const buy = { [T]: teamBuyType(ctx, ri, T), [CT]: teamBuyType(ctx, ri, CT) } as Record<Side, BuyType | null>;
    for (let pi = 0; pi < ctx.nPlayers; pi++) {
      const s = ctx.side(ri, pi);
      const b = row[pi];
      if (s === null || !b) continue;
      const [kills, deaths, assists, dmg, hs] = b;
      const kast = kills > 0 || assists > 0 || deaths === 0 ? 1 : 0;
      addBasic(C[pi], { s, win, own: buy[s], opp: buy[(5 - s) as Side], isPistol: buy[T] === "pistol", kills, deaths, assists, dmg, kast, hs });
    }
  }

  return { counters: C, rounds: facts };
}

