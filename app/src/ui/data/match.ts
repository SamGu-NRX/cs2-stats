// One match's facts shaped for the match views, seen from the recording player's team ("us"): rounds
// with their kills and player rows, and the per-player cells of the round inspector. Pure grouping of
// MatchFacts; every number with a definition still comes from rollup and METRIC (data/engine.ts).
import { BUY_CLASSES, type BuyClass } from "../../stats/economy";
import type { KillFact, MatchFacts, MatchInfo, PlayerInfo, PlayerRound, RoundFact } from "../../stats/facts";
import { rating3, type Rating3 } from "../../stats/rating3";
import { rollup, type Summary } from "../../stats/rollup";
import type { Side } from "../../stats/tables";

export type Team = "us" | "them";
export type RoundHow = "elim" | "bomb" | "defuse" | "time";

/** A match in the list: what Home, Matches, the sidebar and the match hero show before the facts load. */
export interface MatchEntry {
  file: string;
  /** env.plugin of the plugin file ("legacy-convert", "synthetic-demo" or a plugin version); data/sources.ts reads it */
  origin: string;
  match: MatchInfo;
  players: PlayerInfo[];
  /** index of the recording player (match.pov) in players */
  you: number;
  usTeam: 0 | 1;
  usStartSide: Side;
  score: { us: number; them: number };
  result: "W" | "L" | "T";
  /** the file has shots (aim) and position samples (movement) */
  hasAim: boolean;
  hasPos: boolean;
  /** the recording player over the whole match */
  summary: Summary;
  rating: Rating3;
}

const resultOf = (us: number, them: number): MatchEntry["result"] => (us > them ? "W" : us < them ? "L" : "T");

/** The recording player and their team. A match without one cannot be shown from "your" side. */
function pov(file: string, f: MatchFacts): { you: number; usTeam: 0 | 1 } {
  const you = f.players.findIndex((p) => p.id === f.match.pov);
  if (you < 0) throw new Error(`${file}: the recording player (match pov ${f.match.pov ?? "missing"}) is not among the players`);
  const usTeam = f.players[you].team;
  if (usTeam === null) throw new Error(`${file}: the recording player never had a side`);
  return { you, usTeam };
}

export function entryOf(file: string, origin: string, f: MatchFacts): MatchEntry {
  const { you, usTeam } = pov(file, f);
  const summary = rollup([f], { player: f.players[you].id });
  const us = f.match.score[usTeam];
  const them = f.match.score[1 - usTeam];
  return {
    file, origin, match: f.match, players: f.players, you, usTeam, usStartSide: usTeam === 0 ? "CT" : "T",
    score: { us, them }, result: resultOf(us, them),
    hasAim: f.aim.some((a) => a.k === "shots"), hasPos: f.pr.some((r) => r.spawn !== null),
    summary, rating: rating3(summary.m),
  };
}

/** Newest first: by date, then by file name (plugin files are named by their start time). */
export const byNewest = (a: MatchEntry, b: MatchEntry) => (b.match.date ?? "").localeCompare(a.match.date ?? "") || b.file.localeCompare(a.file);

// ---------------------------------------------------------------- the match model

export interface MPlayer { pi: number; key: string; name: string; bot: boolean; team: Team; isHuman: boolean }

export interface MRound {
  ri: number;
  /** the round's number in the match, 1-based */
  number: number;
  usSide: Side;
  winSide: Side | null;
  winner: Team | null;
  how: RoundHow | null;
  durSecs: number | null;
  /** score after the round; null when the file is missing earlier rounds, so the running score is unknown */
  scoreAfter: { us: number; them: number } | null;
  buy: Record<Team, BuyClass | null>;
  equip: Record<Team, number | null>;
  plantSite: string | null;
  planted: boolean;
  defused: boolean;
  exploded: boolean;
  /** tick order */
  kills: KillFact[];
  /** player rows by pi; null when the player has no row this round */
  pr: (PlayerRound | null)[];
}

export interface MatchModel {
  entry: MatchEntry;
  file: string;
  facts: MatchFacts;
  map: string;
  maxRounds: number;
  nRounds: number;
  /** pi of the recording player */
  human: number;
  usStartSide: Side;
  players: MPlayer[];
  rounds: MRound[];
  /** the extractor computed mesh visibility; the aim timings need it */
  visibility: boolean;
}

/** Round end reasons as the round glyphs name them; the plugin adapter and demos use these names. */
function howOf(reason: string | null): RoundHow | null {
  if (!reason) return null;
  if (reason.endsWith("_killed")) return "elim";
  if (reason === "bomb_defused") return "defuse";
  if (reason === "bomb_exploded" || reason === "target_bombed") return "bomb";
  if (reason === "time_ran_out" || reason === "target_saved") return "time";
  return null;
}

export function matchModel(entry: MatchEntry, facts: MatchFacts): MatchModel {
  const usTeam = entry.usTeam;
  const teamOf = (t: 0 | 1 | null): Team => (t === usTeam ? "us" : "them");
  const players: MPlayer[] = facts.players.map((p, pi) => ({ pi, key: p.id, name: p.name, bot: p.bot, team: teamOf(p.team), isHuman: pi === entry.you }));
  const kills = facts.rounds.map(() => [] as KillFact[]);
  for (const k of facts.kills) kills[k.ri].push(k);
  const pr = facts.rounds.map(() => players.map((): PlayerRound | null => null));
  for (const r of facts.pr) pr[r.ri][r.pi] = r;
  let us = 0;
  let them = 0;
  const rounds = facts.rounds.map((r: RoundFact, ri): MRound => {
    const usSide: Side = r.ctTeam === usTeam ? "CT" : "T";
    const themSide: Side = usSide === "CT" ? "T" : "CT";
    const winner: Team | null = r.winner === null ? null : r.winner === usSide ? "us" : "them";
    if (winner === "us") us++;
    else if (winner === "them") them++;
    return {
      ri, number: r.number, usSide, winSide: r.winner, winner, how: howOf(r.reason), durSecs: r.durationS,
      // round numbers skip when the file holds early rounds as totals only (plugin/adapter.ts)
      scoreAfter: r.number === ri + 1 ? { us, them } : null,
      buy: { us: r.buy[usSide], them: r.buy[themSide] }, equip: { us: r.equip[usSide], them: r.equip[themSide] },
      plantSite: r.plantSite, planted: r.plantTick !== null, defused: r.defused, exploded: r.exploded,
      kills: kills[ri], pr: pr[ri],
    };
  });
  return {
    entry, file: entry.file, facts, map: facts.match.map, maxRounds: facts.match.maxRounds, nRounds: facts.rounds.length,
    human: entry.you, usStartSide: entry.usStartSide, players, rounds, visibility: facts.match.visibility === "ok",
  };
}

/** The side a player was on in a round: their row's side, else their team's. */
export function sideOf(v: MatchModel, r: MRound, pi: number): Side {
  const row = r.pr[pi];
  if (row) return row.side;
  return v.players[pi].team === "us" ? r.usSide : r.usSide === "CT" ? "T" : "CT";
}

/** The match's facts cut to one round, so rollup and METRIC give that round's numbers. */
export const roundSlice = (f: MatchFacts, ri: number): MatchFacts => ({ ...f, pr: f.pr.filter((r) => r.ri === ri) });

/** A player's enemy kills and death in one round. */
export const killsBy = (r: MRound, pi: number) => r.kills.filter((k) => k.killer === pi && k.enemy);
export const deathOf = (r: MRound, pi: number) => r.kills.find((k) => k.victim === pi) ?? null;

/** Swing a kill credited to one player, a win-probability fraction; null when the round is not valued. */
export function killSwing(k: KillFact, pi: number | null): number | null {
  if (pi === null || !k.credits.length) return null;
  return k.credits.find(([p]) => p === pi)?.[1] ?? 0;
}

/** A player's swing in one round (a fraction), from their row; null when the round is not valued. */
export const roundSwing = (row: PlayerRound | null) => (row && row.m.swingRounds ? row.m.swing ?? 0 : null);

/** One player's round in the inspector grid. */
export interface RoundCell {
  ri: number;
  side: Side;
  kills: KillFact[];
  death: KillFact | null;
  died: boolean;
  dmg: number;
  swing: number | null;
  /** the player has no row this round */
  empty: boolean;
  pr: PlayerRound | null;
}

/** The round inspector's grid, [pi][ri]. */
export function roundMatrix(v: MatchModel): RoundCell[][] {
  return v.players.map((p) => v.rounds.map((r) => {
    const row = r.pr[p.pi];
    const death = deathOf(r, p.pi);
    return { ri: r.ri, side: sideOf(v, r, p.pi), kills: killsBy(r, p.pi), death, died: death !== null, dmg: row?.m.dmg ?? 0, swing: roundSwing(row), empty: !row, pr: row };
  }));
}

export interface WinTally { wins: number; rounds: number }
const byBuy = <T,>(f: () => T) => Object.fromEntries(BUY_CLASSES.map((b) => [b, f()])) as Record<BuyClass, T>;

/** Rounds played and won on each buy class, per team, and your team's wins by both teams' buys. */
export function buyTally(v: MatchModel) {
  const us = byBuy((): WinTally => ({ wins: 0, rounds: 0 }));
  const them = byBuy((): WinTally => ({ wins: 0, rounds: 0 }));
  const matchup = byBuy(() => byBuy((): WinTally => ({ wins: 0, rounds: 0 })));
  for (const r of v.rounds) {
    if (r.winner === null) continue;
    if (r.buy.us) { us[r.buy.us].rounds++; if (r.winner === "us") us[r.buy.us].wins++; }
    if (r.buy.them) { them[r.buy.them].rounds++; if (r.winner === "them") them[r.buy.them].wins++; }
    if (r.buy.us && r.buy.them) { const x = matchup[r.buy.us][r.buy.them]; x.rounds++; if (r.winner === "us") x.wins++; }
  }
  return { us, them, matchup };
}

/** Enemy kills by killer and victim, [killer][victim]. */
export function killMatrix(v: MatchModel): number[][] {
  const km = v.players.map(() => v.players.map(() => 0));
  for (const k of v.facts.kills) if (k.enemy && k.killer !== null) km[k.killer][k.victim]++;
  return km;
}
