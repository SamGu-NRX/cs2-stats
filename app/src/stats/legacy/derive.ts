// Everything the match page shows, computed once per match. The result is plain data so the worker
// can post it to the UI and cache it.
import { aimAggregate, type AimAgg } from "./aim";
import { buildCtx, type MatchCtx } from "./context";
import { countMatch, type Counters, type RoundFacts } from "./counters";
import { BUY_TYPES, economyView, teamEquip, type BuyType, type EconomyView } from "./economy";
import { positionsAggregate, type PosAgg } from "./positions";
import { hsPercent, rating2 } from "./rating";
import { hltvCounts } from "./hltv";
import { r3Inputs, rating3, type Rating3 } from "./rating3";
import { deriveRole, roleCounts, type Role } from "./role";
import { computeTrades, isEnemyKill, isSave } from "./rules";
import type { MatchFile, RoundHow, Side, Vec3 } from "./schema";
import { roundDetailsFromCtx, type RoundDetail, type TeamId } from "./rounds";
import { computeSwing } from "./swing";
import { stubModel, type WinModel } from "./winprob";

/** Bump when a definition changes, so cached summaries are rebuilt. */
// 7: swing for plugin 1.0.0 files removes the victim's HP after a kill (was unknown for every round).
export const DERIVE_VERSION = 7;

export type { TeamId };

export interface PlayerRow {
  pi: number;
  key: string;
  name: string;
  isBot: boolean;
  isHuman: boolean;
  team: TeamId;
  c: Counters;
  /** Rating 2.0 (public approximation) */
  rating: number;
  /** Rating 3.0 (approx.), over rounds with the kill log; see rating3.ts */
  rating3: Rating3;
  /** AWPer or Rifler with a flavour, from this match alone (role.ts) */
  role: Role;
  adr: number;
  kast: number;
  hs: number;
  /** average win-probability swing per round, in points (0.05 = 5 %) or null without round states */
  swingPerRound: number | null;
}

export interface KillView {
  tick: number;
  secs: number | null;
  killer: number | null;
  victim: number;
  assister: number | null;
  flashAssister: number | null;
  weapon: string;
  flags: number;
  tradeKill: boolean;
  tradeDeath: boolean;
  teamKill: boolean;
  suicide: boolean;
  /** alive before the kill, from the killer team's view is not assumed: [ctAlive, tAlive] */
  alive: [number, number] | null;
  ctWinBefore: number | null;
  ctWinAfter: number | null;
  credits: [number, number][];
  kpos: Vec3 | null;
  vpos: Vec3 | null;
}

export interface RoundView {
  ri: number;
  /** the kill-by-kill log covers this round */
  captured: boolean;
  /** only the game's round totals exist for this round (kills, deaths, assists, damage) */
  lite: boolean;
  /** null when the plugin could not read the round result */
  winSide: Side | null;
  how: RoundHow | null;
  winner: TeamId | null;
  usSide: Side;
  /** players alive on the winning side at round end, null when the round was not captured */
  left: number | null;
  scoreAfter: { us: number; them: number };
  durSecs: number | null;
  bombSite: string | null;
  planter: number | null;
  defuser: number | null;
  buy: { us: BuyType | null; them: BuyType | null };
  equip: { us: number | null; them: number | null };
  money: { us: number | null; them: number | null };
  kills: KillView[];
  /** enemy damage per player this round */
  dmg: number[];
  /** swing per player this round; null when unknown (no round states, unknown equipment, or a state the model rejects) */
  swing: number[] | null;
  clutches: RoundFacts["clutches"];
  saves: number[];
}

export interface EconomySummary {
  /** rounds and wins for our buy type (row) against theirs (column), BUY_TYPES order */
  matrix: { rounds: number; wins: number }[][];
  byOwn: { rounds: number; wins: number }[];
  /** rounds whose buy type could not be classified (unknown equipment or money) */
  unknown: number;
}

export interface MatchView {
  id: string;
  file: string;
  map: string;
  startUtc: string;
  endUtc: string;
  status: MatchFile["status"];
  env: MatchFile["env"];
  firstFullRound: number;
  nRounds: number;
  /** rounds with the kill-by-kill log */
  captured: number;
  /** rounds with any player stats: captured rounds plus lite rounds with the game's totals */
  statRounds: number;
  score: { us: number; them: number };
  result: "W" | "L" | "T";
  human: number;
  usStartSide: Side;
  players: PlayerRow[];
  rounds: RoundView[];
  /** kills[killer][victim], enemy kills only */
  killMatrix: number[][];
  economy: EconomySummary;
  model: { kind: WinModel["kind"]; label: string };
  aim: AimAgg | null;
  pos: PosAgg;
  hasAim: boolean;
  hasPos: boolean;
  /** the plugin's own check of each round against the game's per-round stats, when recorded */
  recon: ReconSummary | null;
  /** per round, per player: the round inspector's data (rounds.ts) */
  roundDetails: RoundDetail[];
  /** four-way buy classes, win rates, matchups, money and equipment curves, saves (economy.ts) */
  econ: EconomyView;
}

export interface ReconSummary {
  rounds: number;
  /** rounds where every expected player was compared with the game */
  fullyChecked: number;
  /** "Round 7, Rip: damage 87 here, 88 in game" */
  mismatches: string[];
  /** true only when every round was fully checked and nothing differed */
  matches: boolean;
}

/**
 * The plugin's comparison with the game's own per-round stats. A round counts as checked when the
 * players compared reach the players expected: recon.rounds.checkedPlayers / expectedPlayers when
 * present, else the older checked count against the players on a side that round.
 */
export function reconSummary(m: MatchFile): ReconSummary | null {
  const r = m.recon?.rounds;
  if (!r) return null;
  const nRounds = m.rounds.winSide.length;
  let fullyChecked = 0;
  for (let ri = 0; ri < nRounds; ri++) {
    const j = r.ri.indexOf(ri);
    if (j < 0) continue;
    const present = m.rounds.side[ri]?.filter((s) => s !== null).length ?? 0;
    const expected = r.expectedPlayers?.[j] ?? present;
    const raw = r.checkedPlayers?.[j] ?? r.checked?.[j] ?? 0;
    const checked = typeof raw === "number" ? raw : raw === true ? expected : 0;
    if (expected > 0 && checked >= expected) fullyChecked++;
  }
  const mm = m.recon?.mismatch;
  const field: Record<string, string> = { k: "kills", d: "deaths", a: "assists", dmg: "damage" };
  const mismatches = mm ? mm.ri.map((ri, j) => `Round ${ri + 1}, ${m.players.name[mm.pi[j]] ?? "?"}: ${field[mm.field[j]] ?? mm.field[j]} ${mm.ours[j]} here, ${mm.game[j]} in game`) : [];
  return { rounds: nRounds, fullyChecked, mismatches, matches: fullyChecked === nRounds && mismatches.length === 0 };
}

function rowFor(ctx: MatchCtx, pi: number, c: Counters): PlayerRow {
  const m = ctx.m;
  return {
    pi, key: m.players.key[pi], name: m.players.name[pi], isBot: m.players.isBot[pi], isHuman: pi === m.human,
    team: ctx.onHumanTeam[pi] ? "us" : "them", c, rating: rating2(c), rating3: rating3(c.r3), role: deriveRole(c), adr: c.rounds ? c.dmg / c.rounds : 0,
    kast: c.rounds ? (100 * c.kastRounds) / c.rounds : 0, hs: hsPercent(c.hsKills, c.kills),
    swingPerRound: c.swingRounds ? c.swing / c.swingRounds : null,
  };
}

export function deriveMatch(m: MatchFile, file: string, model: WinModel = stubModel): MatchView {
  const ctx = buildCtx(m);
  const trades = computeTrades(ctx);
  const swingResult = computeSwing(ctx, model);
  const swing = swingResult.swings;
  const { counters, rounds: facts } = countMatch(ctx, trades, swingResult);
  r3Inputs(ctx, trades, swingResult).forEach((x, pi) => (counters[pi].r3 = x));
  roleCounts(ctx).forEach((x, pi) => (counters[pi].role = x));
  const roundDetails = roundDetailsFromCtx(ctx, trades, swingResult, model);
  hltvCounts(ctx, roundDetails).forEach((x, pi) => (counters[pi].hl = x));
  const players = counters.map((c, pi) => rowFor(ctx, pi, c));
  const nRounds = m.rounds.winSide.length;
  const swingByKill = new Map(swing.map((s) => [s.k, s]));
  const factByRound = new Map(facts.map((f) => [f.ri, f]));
  const usSide = (ri: number): Side => ctx.side(ri, m.human) ?? m.players.startSide[m.human];

  let us = 0;
  let them = 0;
  const rounds: RoundView[] = [];
  for (let ri = 0; ri < nRounds; ri++) {
    const s = usSide(ri);
    const winSide = m.rounds.winSide[ri];
    const winner: TeamId | null = winSide === null ? null : winSide === s ? "us" : "them";
    if (winner === "us") us++;
    if (winner === "them") them++;
    const f = factByRound.get(ri);
    const freeze = m.rounds.freezeTick[ri];
    const kills: KillView[] = [];
    const dmg = new Array<number>(ctx.nPlayers).fill(0);
    const sw = new Array<number>(ctx.nPlayers).fill(0);
    if (f) {
      ctx.kills.forEach((k, j) => {
        if (k.ri !== ri) return;
        const st = m.kills.state[k.i];
        const swk = swingByKill.get(j);
        if (swk) for (const [p, v] of swk.credits) sw[p] += v;
        kills.push({
          tick: k.tick, secs: freeze !== null ? (k.tick - freeze) / ctx.tickrate : null, killer: k.killer, victim: k.victim,
          assister: k.assister, flashAssister: k.flashAssister, weapon: k.weapon, flags: k.flags,
          tradeKill: trades.tradeKill[j], tradeDeath: trades.tradeDeath[j], teamKill: k.teamKill, suicide: k.suicide,
          alive: st ? [st[0], st[1]] : null, ctWinBefore: swk?.before ?? null, ctWinAfter: swk?.after ?? null,
          credits: swk?.credits ?? [], kpos: m.kills.kpos[k.i], vpos: m.kills.vpos[k.i],
        });
      });
      for (let j = 0; j < m.damage.ri.length; j++) {
        const a = m.damage.attacker[j];
        if (m.damage.ri[j] !== ri || a === null || ctx.side(ri, a) === ctx.side(ri, m.damage.victim[j])) continue;
        dmg[a] += m.damage.dmg[j];
      }
    }
    const basicRow = !f ? m.rounds.basic?.[ri] ?? null : null;
    if (basicRow) basicRow.forEach((b, pi) => { if (b) dmg[pi] = b[3]; });
    const aliveEnd = m.rounds.aliveEnd?.[ri] ?? null;
    const left = winSide === null ? null
      : f ? [...f.alive].filter((p) => ctx.side(ri, p) === winSide).length
      : aliveEnd ? aliveEnd[winSide === 3 ? 0 : 1] : null;
    const eqUs = teamEquip(ctx, ri, s);
    const eqThem = teamEquip(ctx, ri, (5 - s) as Side);
    const dur = m.rounds.durTicks[ri];
    rounds.push({
      ri, captured: !!f, lite: !!basicRow, winSide, how: m.rounds.how[ri], winner, usSide: s, left, scoreAfter: { us, them },
      durSecs: dur !== null ? dur / ctx.tickrate : null, bombSite: m.rounds.bombSite[ri], planter: m.rounds.planter[ri],
      defuser: m.rounds.defuser[ri],
      buy: { us: f ? f.buy[s] : null, them: f ? f.buy[(5 - s) as Side] : null },
      equip: { us: eqUs.equip, them: eqThem.equip }, money: { us: eqUs.money, them: eqThem.money },
      kills, dmg, swing: f && swingResult.available && !swingResult.unknownRounds.has(ri) ? sw : null, clutches: f?.clutches ?? [],
      saves: f && winSide !== null ? [...f.alive].filter((p) => isSave(ctx, ri, p, f.alive)) : [],
    });
  }

  const killMatrix = Array.from({ length: ctx.nPlayers }, () => new Array<number>(ctx.nPlayers).fill(0));
  for (const k of ctx.kills) if (isEnemyKill(k)) killMatrix[k.killer!][k.victim]++;

  const economy: EconomySummary = {
    matrix: BUY_TYPES.map(() => BUY_TYPES.map(() => ({ rounds: 0, wins: 0 }))),
    byOwn: BUY_TYPES.map(() => ({ rounds: 0, wins: 0 })),
    unknown: 0,
  };
  for (const r of rounds) {
    if (!r.captured) continue;
    if (!r.buy.us || !r.buy.them) { economy.unknown++; continue; }
    const a = BUY_TYPES.indexOf(r.buy.us);
    const b = BUY_TYPES.indexOf(r.buy.them);
    const won = r.winner === "us" ? 1 : 0;
    economy.matrix[a][b].rounds++;
    economy.matrix[a][b].wins += won;
    economy.byOwn[a].rounds++;
    economy.byOwn[a].wins += won;
  }

  const aim = aimAggregate(m);
  return {
    id: m.id, file, map: m.map, startUtc: m.startUtc, endUtc: m.endUtc, status: m.status, env: m.env,
    firstFullRound: m.firstFullRound, nRounds, captured: ctx.rounds.length, statRounds: players[m.human].c.rounds, score: { us, them },
    result: us > them ? "W" : us < them ? "L" : "T", human: m.human, usStartSide: usSide(0), players, rounds,
    killMatrix, economy, model: { kind: model.kind, label: model.label }, aim,
    pos: positionsAggregate(m), hasAim: m.aim.shots.ri.length > 0 || m.aim.engagements.ri.length > 0,
    hasPos: m.pos.ri.length > 0, recon: reconSummary(m), roundDetails, econ: economyView(roundDetails),
  };
}

/** What the match list and the profile need from one match. Small enough to cache 1,000 of them. */
export interface MatchSummary {
  v: number;
  file: string;
  id: string;
  map: string;
  startUtc: string;
  status: MatchFile["status"];
  nRounds: number;
  /** rounds with the kill-by-kill log */
  captured: number;
  /** rounds with any player stats: captured rounds plus lite rounds with the game's totals */
  statRounds: number;
  score: { us: number; them: number };
  result: MatchView["result"];
  usStartSide: Side;
  human: { key: string; name: string; c: Counters; rating: number; rating3: number | null };
  /** bot careers: one entry per bot in the match, either team */
  bots: { key: string; name: string; c: Counters }[];
  aim: AimAgg | null;
  /** the human has position samples (positions themselves are cached separately) */
  hasPos: boolean;
  pos: PosAgg;
}

export function summarize(v: MatchView): MatchSummary {
  const h = v.players[v.human];
  return {
    v: DERIVE_VERSION, file: v.file, id: v.id, map: v.map, startUtc: v.startUtc, status: v.status, nRounds: v.nRounds,
    captured: v.captured, statRounds: v.statRounds, score: v.score, result: v.result, usStartSide: v.usStartSide,
    human: { key: h.key, name: h.name, c: h.c, rating: h.rating, rating3: h.rating3.value },
    bots: v.players.filter((p) => p.isBot).map((p) => ({ key: p.key, name: p.name, c: p.c })),
    aim: v.aim, hasPos: Object.keys(v.pos.human).length > 0, pos: v.pos,
  };
}

