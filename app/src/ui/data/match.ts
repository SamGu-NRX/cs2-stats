// One match shaped for the match views, seen from the recording player's team ("us"): rounds with
// their kills and player rows, and the per-player cells of the round inspector. Pure grouping of the
// worker's MatchBundle; every number with a definition comes from the worker (worker/views.ts).
import type { BuyClass } from "../../stats/economy";
import type { KillFact, MatchInfo, PlayerInfo, PlayerRound, RoundFact } from "../../stats/facts";
import type { Side } from "../../stats/tables";
import type { Line, MatchBundle, MatchCore } from "../../worker/protocol";
import { halfStarts } from "../lib/layout";

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
  /** gun shots by the recording player */
  shots: number;
  /** the recording player over the whole match, both sides; its rating is under the coverage rule */
  line: Line;
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
  /** a side swap falls just before this round (by round number, lib/layout.ts halfStarts) */
  halfStart: boolean;
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
  fact: RoundFact;
}

export interface MatchModel {
  entry: MatchEntry;
  file: string;
  /** the worker's numbers for this match */
  b: MatchBundle;
  facts: MatchCore;
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

export function matchModel(entry: MatchEntry, b: MatchBundle): MatchModel {
  const facts = b.core;
  const usTeam = entry.usTeam;
  const teamOf = (t: 0 | 1 | null): Team => (t === usTeam ? "us" : "them");
  const players: MPlayer[] = facts.players.map((p, pi) => ({ pi, key: p.id, name: p.name, bot: p.bot, team: teamOf(p.team), isHuman: pi === entry.you }));
  const kills = facts.rounds.map(() => [] as KillFact[]);
  for (const k of facts.kills) kills[k.ri].push(k);
  const pr = facts.rounds.map(() => players.map((): PlayerRound | null => null));
  for (const r of facts.pr) pr[r.ri][r.pi] = r;
  const starts = halfStarts(facts.rounds.map((r) => r.number), facts.match.maxRounds);
  let us = 0;
  let them = 0;
  const rounds = facts.rounds.map((r: RoundFact, ri): MRound => {
    const usSide: Side = r.ctTeam === usTeam ? "CT" : "T";
    const themSide: Side = usSide === "CT" ? "T" : "CT";
    const winner: Team | null = r.winner === null ? null : r.winner === usSide ? "us" : "them";
    if (winner === "us") us++;
    else if (winner === "them") them++;
    return {
      ri, number: r.number, usSide, winSide: r.winner, winner, how: howOf(r.reason), durSecs: r.durationS, halfStart: starts[ri],
      // round numbers skip when the file holds early rounds as totals only (plugin/adapter.ts)
      scoreAfter: r.number === ri + 1 ? { us, them } : null,
      buy: { us: r.buy[usSide], them: r.buy[themSide] }, equip: { us: r.equip[usSide], them: r.equip[themSide] },
      plantSite: r.plantSite, planted: r.plantTick !== null, defused: r.defused, exploded: r.exploded,
      kills: kills[ri], pr: pr[ri], fact: r,
    };
  });
  return {
    entry, file: entry.file, b, facts, map: facts.match.map, maxRounds: facts.match.maxRounds, nRounds: facts.rounds.length,
    human: entry.you, usStartSide: entry.usStartSide, players, rounds, visibility: facts.match.visibility === "ok",
  };
}

/** The side a player was on in a round: their row's side, else their team's. */
export function sideOf(v: MatchModel, r: MRound, pi: number): Side {
  const row = r.pr[pi];
  if (row) return row.side;
  return v.players[pi].team === "us" ? r.usSide : r.usSide === "CT" ? "T" : "CT";
}

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

/** Seconds since the round's freeze end at a tick; null without a freeze-end tick. */
export const roundSecs = (v: MatchModel, r: MRound, tick: number | null) =>
  tick === null || r.fact.freezeEndTick === null ? null : (tick - r.fact.freezeEndTick) / v.facts.match.tickRate;

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

/** Enemy kills by killer and victim, [killer][victim]. */
export function killMatrix(v: MatchModel): number[][] {
  const km = v.players.map(() => v.players.map(() => 0));
  for (const k of v.facts.kills) if (k.enemy && k.killer !== null) km[k.killer][k.victim]++;
  return km;
}

/**
 * A map callout as the game names it ("TopofMid", "BombsiteB", "CTSpawn") in plain words ("Top of mid",
 * "B site", "CT spawn"). Unknown shapes pass through with spaces before capitals.
 */
export function placeName(raw: string): string {
  const s = raw
    .replace(/^Bombsite([A-Z])$/, "$1 site")
    .replace(/^(CT|T)Spawn$/, "$1 spawn")
    .replace(/([a-z])of([A-Z])/g, "$1 of $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  const words = s.split(/\s+/).filter(Boolean);
  return words.map((w, i) => (w.length <= 2 && w === w.toUpperCase() ? w : i === 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(" ");
}

/** Seconds per place with the callouts in plain words; places that read the same are added together. */
export function placesNamed(places: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [p, secs] of Object.entries(places)) { const n = placeName(p); out[n] = (out[n] ?? 0) + secs; }
  return out;
}
