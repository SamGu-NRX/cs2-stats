// Per-round, per-player facts for the round inspector and round detail, and the base layer that
// Rating 3.0, roles and the HLTV sub-stats read. Counting rules are the ones in counters.ts (kills
// not made in a bot's body, assists on enemy victims, enemy damage only), so per-round values sum to
// the match totals; rounds.test.ts checks that on every fixture.
import { segmentBursts, GUN_CLASSES, SPRAY_MAX_IDX } from "./aim";
import { assistersOf, buildCtx, sameSide, type KillRow, type MatchCtx } from "./context";
import { classifyBuy, isPistolRound, teamBuyClass, teamEquip, type BuyClass } from "./economy";
import { aliveAtEnd, computeTrades, detectClutches, isEnemyKill, isSave, kastRound, openingKill, type Trades } from "./rules";
import { CT, KILL_FLAG, T, type MatchFile, type RoundHow, type Side } from "./schema";
import { computeSwing, type SwingResult } from "./swing";
import { stubModel, type RoundState, type WinModel } from "./winprob";
import { isUtility, weaponClass, PRICE } from "./weapons";

export type TeamId = "us" | "them";

export interface KillEvent {
  /** position in the match's kill list (ctx.kills) */
  k: number;
  tick: number;
  /** seconds since freeze end, null when the freeze tick is unknown */
  secs: number | null;
  killer: number | null;
  victim: number;
  assister: number | null;
  flashAssister: number | null;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  throughSmoke: boolean;
  noscope: boolean;
  killerBlind: boolean;
  inAir: boolean;
  teamKill: boolean;
  suicide: boolean;
  /** the killer killed someone who had made a kill less than 5 s earlier */
  tradeKill: boolean;
  /** the victim's killer died less than 5 s later */
  traded: boolean;
  /** first kill of the round (team kills and suicides skipped) */
  opening: boolean;
}

export interface UtilThrown { he: number; flash: number; smoke: number; molotov: number; decoy: number }

export interface PlayerRound {
  pi: number;
  side: Side;
  team: TeamId;
  /** enemy kills, deaths, assists (flash assists included, as the game counts them) */
  k: number;
  d: number;
  a: number;
  hsKills: number;
  /** enemy kills with details; empty in lite rounds */
  kills: KillEvent[];
  death: KillEvent | null;
  flashAssists: number;
  /** health damage to enemies, taken from enemies, and dealt to teammates */
  dmg: number;
  dmgTaken: number;
  teamDmg: number;
  utilDmg: number;
  /** this player's round swing in win-probability points (0.05 = 5 %), null when unknown */
  swing: number | null;
  equip: number | null;
  money: number | null;
  /** equipment value kept at round end (0 when dead), plugin 1.0.0 */
  equipEnd: number | null;
  /**
   * Money spent this round, estimated as freeze-end equipment minus what the player carried in: the
   * previous round's round-end equipment, or the $200 starting pistol after a death or a half start.
   * Weapons dropped for teammates move value between players, so team totals are firmer than
   * per-player values. Null without round-end equipment (files before plugin 1.0.0).
   */
  spent: number | null;
  /** money spent on grenades, from the plugin's purchase log */
  utilSpent: number | null;
  buy: BuyClass | null;
  utilThrown: UtilThrown;
  enemiesFlashed: number;
  enemyBlindSecs: number;
  /** seconds this player's flashes blinded teammates */
  teamFlashSecs: number;
  survived: boolean;
  /** died and the death was traded */
  traded: boolean;
  kast: boolean;
  /** survived a lost round still holding a primary (rules.isSave) */
  saved: boolean;
  clutch: { opponents: number; won: boolean } | null;
}

export interface TeamRound {
  side: Side;
  team: TeamId;
  players: number[];
  equip: number | null;
  money: number | null;
  spent: number | null;
  buy: BuyClass | null;
  won: boolean | null;
  aliveEnd: number | null;
  saves: number[];
}

export interface WinProbPoint {
  tick: number;
  secs: number | null;
  /** P(CT wins) after the event */
  pCT: number;
  /** P(CT wins) just before a kill or plant */
  before: number | null;
  event: "start" | "kill" | "plant" | "end";
  /** ctx.kills position for kill points */
  k?: number;
}

export interface HumanRoundAim {
  shots: number;
  hits: number;
  headHits: number;
  accuracy: number | null;
  /** first bullets of a burst with an enemy within 10° of the aim, and how many hit */
  firstOnTarget: number;
  firstHits: number;
  firstAccuracy: number | null;
  /** ms from the visibility signal to first damage / aim reaction, and crosshair angle (°) then; gated like aim.validated */
  ttdMs: number[];
  reactMs: number[];
  xhairDeg: number[];
  /** bursts of 2+ bullets: impact and aim error per bullet in degrees [yaw, pitch] */
  spray: { weapon: string; points: { idx: number; impact: [number, number] | null; aimErr: [number, number] | null; hit: number | null }[] }[];
}

export interface RoundDetail {
  ri: number;
  /** the kill-by-kill log covers this round */
  captured: boolean;
  /** only the game's round totals exist */
  lite: boolean;
  winSide: Side | null;
  how: RoundHow | null;
  winner: TeamId | null;
  usSide: Side;
  scoreBefore: { us: number; them: number };
  scoreAfter: { us: number; them: number };
  durSecs: number | null;
  bomb: { site: string | null; plantTick: number | null; plantSecs: number | null; planter: number | null; defuser: number | null; defused: boolean; exploded: boolean };
  teams: Record<"t" | "ct", TeamRound>;
  /** indexed by pi; null for players without a side this round */
  players: (PlayerRound | null)[];
  /** P(CT wins) through the round; null without the kill log or when the model cannot value a state */
  winProb: WinProbPoint[] | null;
  human: HumanRoundAim | null;
}

const STARTING_PISTOL = PRICE.glock;

/** First round of a half, regulation or overtime: equipment resets to the starting pistol. */
export function isHalfStart(ri: number, maxrounds: number | null, otRounds = 6): boolean {
  const max = maxrounds ?? 24;
  if (ri < max) return ri % (max / 2) === 0;
  return (ri - max) % (otRounds / 2) === 0;
}

/** Spend estimate for one player; see PlayerRound.spent. */
export function estimateSpent(equip: number | null, prevEquipEnd: number | null | undefined, halfStart: boolean): number | null {
  if (equip === null) return null;
  if (halfStart) return Math.max(0, equip - STARTING_PISTOL);
  if (prevEquipEnd === undefined || prevEquipEnd === null) return null;
  return Math.max(0, equip - (prevEquipEnd > 0 ? prevEquipEnd : STARTING_PISTOL));
}

const emptyThrown = (): UtilThrown => ({ he: 0, flash: 0, smoke: 0, molotov: 0, decoy: 0 });

function killEvent(ctx: MatchCtx, k: KillRow, j: number, trades: Trades, opening: KillRow | null): KillEvent {
  const freeze = ctx.m.rounds.freezeTick[k.ri];
  return {
    k: j, tick: k.tick, secs: freeze !== null ? (k.tick - freeze) / ctx.tickrate : null, killer: k.killer, victim: k.victim,
    assister: k.assister, flashAssister: k.flashAssister, weapon: k.weapon,
    headshot: (k.flags & KILL_FLAG.headshot) !== 0, wallbang: (k.flags & KILL_FLAG.wallbang) !== 0,
    throughSmoke: (k.flags & KILL_FLAG.smoke) !== 0, noscope: (k.flags & KILL_FLAG.noscope) !== 0,
    killerBlind: (k.flags & KILL_FLAG.blind) !== 0, inAir: (k.flags & KILL_FLAG.air) !== 0,
    teamKill: k.teamKill, suicide: k.suicide, tradeKill: trades.tradeKill[j], traded: trades.tradeDeath[j], opening: opening === k,
  };
}

/**
 * The model's state at any tick: alive counts from deaths so far, HP from player damage rows (world
 * and fall damage are not recorded, so HP can read high), and freeze-end equipment.
 */
function stateAt(ctx: MatchCtx, ri: number, tick: number, planted: boolean): RoundState | null {
  const m = ctx.m;
  const freeze = m.rounds.freezeTick[ri];
  if (freeze === null) return null;
  const hp = new Map<number, number>();
  const alive0 = m.rounds.alive0?.[ri];
  for (let pi = 0; pi < ctx.nPlayers; pi++) if (ctx.side(ri, pi) !== null && alive0?.[pi] !== 0) hp.set(pi, 100);
  const d = m.damage;
  for (let j = 0; j < d.ri.length; j++) {
    if (d.ri[j] !== ri || d.tick[j] > tick || !hp.has(d.victim[j])) continue;
    hp.set(d.victim[j], Math.max(0, hp.get(d.victim[j])! - d.dmg[j]));
  }
  for (const k of ctx.killsByRound.get(ri) ?? []) if (k.tick <= tick) hp.delete(k.victim);
  let ctAlive = 0, tAlive = 0, ctHp = 0, tHp = 0;
  for (const [pi, h] of hp) {
    if (ctx.side(ri, pi) === CT) { ctAlive++; ctHp += Math.max(1, h); } else { tAlive++; tHp += Math.max(1, h); }
  }
  const ct = teamEquip(ctx, ri, CT).equip;
  const t = teamEquip(ctx, ri, T).equip;
  if (ct === null || t === null) return null;
  const plant = m.rounds.plantTick[ri];
  return {
    ctAlive, tAlive, ctHp, tHp, ctEquip: ct, tEquip: t, planted: planted ? 1 : 0,
    secondsSincePlant: planted && plant !== null ? Math.max(0, (tick - plant) / ctx.tickrate) : null,
    secondsSinceFreezeEnd: Math.max(0, (tick - freeze) / ctx.tickrate),
  };
}

/** Start, every valued kill, the plant, and the result. Kill points reuse the swing's own before/after values. */
function winProbPath(ctx: MatchCtx, ri: number, swing: SwingResult, model: WinModel): WinProbPoint[] | null {
  const m = ctx.m;
  const freeze = m.rounds.freezeTick[ri];
  if (freeze === null || swing.unknownRounds.has(ri)) return null;
  const secs = (t: number) => (t - freeze) / ctx.tickrate;
  const value = (s: RoundState | null) => (s ? model.winProbability(s, m.map) : null);
  const start = value(stateAt(ctx, ri, freeze, false));
  if (start === null) return null;
  const out: WinProbPoint[] = [{ tick: freeze, secs: 0, pCT: start, before: null, event: "start" }];
  const plant = m.rounds.plantTick[ri];
  const byKill = new Map(swing.swings.map((s) => [s.k, s]));
  const events: { tick: number; k?: number }[] = [];
  ctx.kills.forEach((k, j) => { if (k.ri === ri && byKill.has(j)) events.push({ tick: k.tick, k: j }); });
  if (plant !== null) events.push({ tick: plant });
  // a kill in the plant's tick happened before the plant could change anything
  events.sort((a, b) => a.tick - b.tick || (a.k === undefined ? 1 : 0) - (b.k === undefined ? 1 : 0));
  for (const e of events) {
    if (e.k !== undefined) {
      const s = byKill.get(e.k)!;
      out.push({ tick: e.tick, secs: secs(e.tick), pCT: s.after, before: s.before, event: "kill", k: e.k });
    } else {
      const after = value(stateAt(ctx, ri, e.tick, true));
      if (after !== null) out.push({ tick: e.tick, secs: secs(e.tick), pCT: after, before: value(stateAt(ctx, ri, e.tick, false)), event: "plant" });
    }
  }
  const win = m.rounds.winSide[ri];
  const end = ctx.endTick(ri);
  if (win !== null && end !== null) out.push({ tick: end, secs: secs(end), pCT: win === CT ? 1 : 0, before: null, event: "end" });
  return out;
}

function humanAim(m: MatchFile, ri: number, burstIdx: Map<number, number>): HumanRoundAim | null {
  const s = m.aim.shots;
  const e = m.aim.engagements;
  if (!s.ri.length && !e.ri.length) return null;
  const tr = m.env.tickrate || 64;
  const out: HumanRoundAim = { shots: 0, hits: 0, headHits: 0, accuracy: null, firstOnTarget: 0, firstHits: 0, firstAccuracy: null, ttdMs: [], reactMs: [], xhairDeg: [], spray: [] };
  const deg = (v: [number, number] | null): [number, number] | null => (v ? [v[0] / 100, v[1] / 100] : null);
  let burst: HumanRoundAim["spray"][number] | null = null;
  for (let i = 0; i < s.ri.length; i++) {
    if (s.ri[i] !== ri) continue;
    const w = m.weapons[s.weapon[i]] ?? "unknown";
    const pc = s.cls ? s.cls[i] : undefined;
    const cls = pc === undefined ? weaponClass(w) : pc === null ? "other" : pc === "shotgun" ? "heavy" : pc;
    if (!(GUN_CLASSES as readonly string[]).includes(cls)) continue;
    const idx = burstIdx.get(i) ?? 1;
    out.shots++;
    if (s.hit[i] !== null) { out.hits++; if (s.hit[i] === 1) out.headHits++; }
    if (idx === 1 && s.target[i] !== null) { out.firstOnTarget++; if (s.hit[i] !== null) out.firstHits++; }
    if (idx === 1) { if (burst && burst.points.length > 1) out.spray.push(burst); burst = { weapon: w, points: [] }; }
    if (burst && idx <= SPRAY_MAX_IDX) burst.points.push({ idx, impact: deg(s.impact[i]), aimErr: deg(s.aimErr[i]), hit: s.hit[i] });
  }
  if (burst && burst.points.length > 1) out.spray.push(burst);
  out.accuracy = out.shots ? out.hits / out.shots : null;
  out.firstAccuracy = out.firstOnTarget ? out.firstHits / out.firstOnTarget : null;
  for (let i = 0; i < e.ri.length; i++) {
    if (e.ri[i] !== ri) continue;
    const fd = e.tFirstDmg[i];
    const as = e.tAimStart[i];
    if (fd !== null) out.ttdMs.push(((fd - e.tVis[i]) * 1000) / tr);
    if (as !== null) out.reactMs.push(((as - e.tVis[i]) * 1000) / tr);
    if (e.angVis[i] !== null) out.xhairDeg.push(e.angVis[i]! / 100);
  }
  return out;
}

/** Everything the round inspector shows, for every round. Rounds without the kill log carry what the file has. */
export function buildRoundDetails(m: MatchFile, model: WinModel = stubModel): RoundDetail[] {
  const ctx = buildCtx(m);
  return roundDetailsFromCtx(ctx, computeTrades(ctx), computeSwing(ctx, model), model);
}

export function roundDetailsFromCtx(ctx: MatchCtx, trades: Trades, swing: SwingResult, model: WinModel): RoundDetail[] {
  const m = ctx.m;
  const nRounds = m.rounds.winSide.length;
  const pos = new Map(ctx.kills.map((k, j) => [k, j]));
  const usSideOf = (ri: number): Side => ctx.side(ri, m.human) ?? m.players.startSide[m.human];
  const teamOf = (pi: number): TeamId => (ctx.onHumanTeam[pi] ? "us" : "them");

  const swingBy = new Map<number, number[]>();
  for (const s of swing.swings) {
    const ri = ctx.kills[s.k].ri;
    let row = swingBy.get(ri);
    if (!row) swingBy.set(ri, (row = new Array<number>(ctx.nPlayers).fill(0)));
    for (const [p, v] of s.credits) row[p] += v;
  }

  // burst index of each human shot over the whole match in tick order, as aim.ts derives it
  const burstIdx = new Map<number, number>();
  const shotOrder: number[] = [];
  for (let i = 0; i < m.aim.shots.ri.length; i++) if (ctx.isFull(m.aim.shots.ri[i])) shotOrder.push(i);
  const seg = segmentBursts(shotOrder.map((i) => ({ ri: m.aim.shots.ri[i], tick: m.aim.shots.tick[i], weapon: m.aim.shots.weapon[i] })), ctx.tickrate);
  shotOrder.forEach((i, j) => burstIdx.set(i, seg.idx[j]));

  let us = 0;
  let them = 0;
  const out: RoundDetail[] = [];
  for (let ri = 0; ri < nRounds; ri++) {
    const usSide = usSideOf(ri);
    const winSide = m.rounds.winSide[ri];
    const winner: TeamId | null = winSide === null ? null : winSide === usSide ? "us" : "them";
    const scoreBefore = { us, them };
    if (winner === "us") us++;
    if (winner === "them") them++;
    const captured = ctx.isFull(ri);
    const basic = !captured ? m.rounds.basic?.[ri] ?? null : null;
    const freeze = m.rounds.freezeTick[ri];
    const plant = m.rounds.plantTick[ri];
    const how = m.rounds.how[ri];
    const list = ctx.killsByRound.get(ri) ?? [];
    const open = captured ? openingKill(list) : null;
    const alive = captured ? aliveAtEnd(ctx, ri) : new Set<number>();
    const clutches = captured ? detectClutches(ctx, ri) : [];
    const pistol = isPistolRound(ri, m.env.maxrounds);
    const halfStart = isHalfStart(ri, m.env.maxrounds);
    const swingRow = captured && swing.available && !swing.unknownRounds.has(ri) ? swingBy.get(ri) ?? new Array<number>(ctx.nPlayers).fill(0) : null;

    const players: (PlayerRound | null)[] = [];
    for (let pi = 0; pi < ctx.nPlayers; pi++) {
      const side = ctx.side(ri, pi);
      if (side === null) { players.push(null); continue; }
      const equip = m.rounds.equip[ri]?.[pi] ?? null;
      const b = basic?.[pi] ?? null;
      const p: PlayerRound = {
        pi, side, team: teamOf(pi), k: 0, d: 0, a: 0, hsKills: 0, kills: [], death: null, flashAssists: 0,
        dmg: 0, dmgTaken: 0, teamDmg: 0, utilDmg: 0, swing: swingRow ? swingRow[pi] : null,
        equip, money: m.rounds.money[ri]?.[pi] ?? null, equipEnd: m.rounds.equipEnd?.[ri]?.[pi] ?? null,
        spent: estimateSpent(equip, ri > 0 ? m.rounds.equipEnd?.[ri - 1]?.[pi] : undefined, halfStart),
        utilSpent: m.rounds.utilSpent?.[ri]?.[pi] ?? null,
        buy: pistol ? "pistol" : equip === null ? null : classifyBuy(equip, false),
        utilThrown: emptyThrown(), enemiesFlashed: 0, enemyBlindSecs: 0, teamFlashSecs: 0,
        survived: captured ? alive.has(pi) : b ? b[1] === 0 : false,
        traded: false, kast: false, saved: captured ? isSave(ctx, ri, pi, alive) : false, clutch: null,
      };
      if (captured) {
        for (const k of list) {
          const j = pos.get(k)!;
          if (k.killer === pi && isEnemyKill(k) && !k.killerBot) {
            p.k++;
            if (k.flags & KILL_FLAG.headshot) p.hsKills++;
            p.kills.push(killEvent(ctx, k, j, trades, open));
          }
          if (k.victim === pi && !k.victimBot) {
            p.d++;
            p.death = killEvent(ctx, k, j, trades, open);
            if (!sameSide(k) && trades.tradeDeath[j]) p.traded = true;
          }
          if (assistersOf(k).includes(pi) && !k.assisterBot && side !== ctx.side(ri, k.victim)) p.a++;
          if (k.flashAssister === pi && !sameSide(k)) p.flashAssists++;
        }
        p.kast = kastRound(list, pi, (k) => trades.tradeDeath[pos.get(k)!]);
        const cl = clutches.find((c) => c.player === pi);
        if (cl) p.clutch = { opponents: cl.opponents, won: cl.won };
      } else if (b) {
        const [k, d, a, dmg, hs] = b;
        Object.assign(p, { k, d, a, dmg, hsKills: hs, kast: k > 0 || a > 0 || d === 0 });
      }
      players.push(p);
    }

    if (captured) {
      const d = m.damage;
      for (let j = 0; j < d.ri.length; j++) {
        if (d.ri[j] !== ri) continue;
        const a = d.attacker[j];
        const v = d.victim[j];
        if (a === null || a === v) continue;
        const pa = players[a];
        const pv = players[v];
        if (!pa || !pv) continue;
        if (pa.side === pv.side) { pa.teamDmg += d.dmg[j]; continue; }
        pa.dmg += d.dmg[j];
        pv.dmgTaken += d.dmg[j];
        if (isUtility(m.weapons[d.weapon[j]] ?? "")) pa.utilDmg += d.dmg[j];
      }
      const g = m.throws ?? m.grenades;
      for (let j = 0; j < g.ri.length; j++) {
        const th = g.thrower[j];
        if (g.ri[j] !== ri || th === null || !players[th]) continue;
        const u = players[th]!.utilThrown;
        const t = g.type[j];
        if (t === "he") u.he++;
        else if (t === "flash") u.flash++;
        else if (t === "smoke") u.smoke++;
        else if (t === "molotov" || t === "incgrenade") u.molotov++;
        else if (t === "decoy") u.decoy++;
      }
      const bl = m.blinds;
      for (let j = 0; j < bl.ri.length; j++) {
        const a = bl.attacker[j];
        const pa = a === null ? null : players[a];
        if (bl.ri[j] !== ri || !pa || bl.ms[j] <= 0 || bl.victim[j] === a) continue;
        const vs = ctx.side(ri, bl.victim[j]);
        if (vs === pa.side) pa.teamFlashSecs += bl.ms[j] / 1000;
        else if (vs !== null) { pa.enemiesFlashed++; pa.enemyBlindSecs += bl.ms[j] / 1000; }
      }
    }

    const team = (side: Side): TeamRound => {
      const ps = players.filter((p): p is PlayerRound => p !== null && p.side === side);
      const eq = teamEquip(ctx, ri, side);
      const spent = !ps.length || ps.some((p) => p.spent === null) ? null : ps.reduce((s, p) => s + p.spent!, 0);
      return {
        side, team: side === usSide ? "us" : "them", players: ps.map((p) => p.pi), equip: eq.equip, money: eq.money, spent,
        buy: teamBuyClass(ctx, ri, side), won: winSide === null ? null : winSide === side,
        aliveEnd: captured ? ps.filter((p) => p.survived).length : null, saves: ps.filter((p) => p.saved).map((p) => p.pi),
      };
    };
    const dur = m.rounds.durTicks[ri];
    out.push({
      ri, captured, lite: !!basic, winSide, how, winner, usSide, scoreBefore, scoreAfter: { us, them },
      durSecs: dur !== null ? dur / ctx.tickrate : null,
      bomb: {
        site: m.rounds.bombSite[ri], plantTick: plant, plantSecs: plant !== null && freeze !== null ? (plant - freeze) / ctx.tickrate : null,
        planter: m.rounds.planter[ri], defuser: m.rounds.defuser[ri], defused: how === "defuse", exploded: how === "bomb",
      },
      teams: { t: team(T), ct: team(CT) }, players,
      winProb: captured ? winProbPath(ctx, ri, swing, model) : null,
      human: captured ? humanAim(m, ri, burstIdx) : null,
    });
  }
  return out;
}
