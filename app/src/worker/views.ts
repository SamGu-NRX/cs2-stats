// What the worker computes for the views, from MatchFacts and summaries: metric values, ratings,
// match bundles and economy views come out of here as plain data (percentiles and similarity: ranking.ts).
// It runs in the stats worker (and in node tests), never on the UI thread.
import { visibilityCoverage } from "../stats/aim";
import { economyOf } from "../stats/economy";
import { DERIVE_VERSION, emptyMeasures, type MatchFacts } from "../stats/facts";
import { isGun } from "../stats/guns";
import { STYLE } from "../stats/identity";
import { ATTRIBUTES, METRICS } from "../stats/metrics";
import type { WinProbSource } from "../stats/model-params";
import { RATING3_LABEL, rating3, type Rating3 } from "../stats/rating3";
import { grenadesOf, rollup, type Filter, type Summary } from "../stats/rollup";
import { ratedMatch } from "../ui/data/engine";
import type { MatchEntry } from "../ui/data/match";
import type {
  Line, MatchBundle, Meta, PositionsResult, Rolled, RoundBundle, SideRatings, Values,
} from "./protocol";

export function metaOf(wp: WinProbSource): Meta {
  return {
    metrics: METRICS.map(({ value: _value, ...m }) => m),
    attributes: ATTRIBUTES,
    rating: { label: RATING3_LABEL, status: rating3(emptyMeasures()).status },
    winProb: { kind: wp.kind, label: wp.label },
    style: [...STYLE],
    deriveVersion: DERIVE_VERSION,
  };
}

export const valuesOf = (s: Summary): Values => Object.fromEntries(METRICS.map((m) => [m.id, m.value(s)]));
export const rolled = (s: Summary): Rolled => ({ ...s, v: valuesOf(s), coverage: visibilityCoverage(s.aim) });
const lineOf = (s: Summary, rated: boolean): Line => ({ m: s.m, v: valuesOf(s), rating: rated ? rating3(s.m).value : null });

/** A rating under the coverage rule: below it, no value and no inputs to break down. */
const gated = (r: Rating3, rated: boolean): Rating3 => (rated ? r : { ...r, value: null, inputs: null });

/**
 * Rating 3.0 on both sides and on each, as rating3BySide defines it (the inputs pooled over the kept
 * rounds, rated once), from the three summaries a caller streamed. `rated` is the coverage rule.
 */
export const ratingsOf = (s: Record<"both" | "T" | "CT", Summary>, rated: boolean): SideRatings => ({
  both: gated(rating3(s.both.m), rated), T: gated(rating3(s.T.m), rated), CT: gated(rating3(s.CT.m), rated),
});

/** The coverage rule over several matches: their logged rounds against the rounds they had. */
export const ratedMatches = (ms: { nRounds: number; roundsPlayed: number }[]) =>
  ratedMatch({ nRounds: ms.reduce((a, m) => a + m.nRounds, 0), roundsPlayed: ms.reduce((a, m) => a + m.roundsPlayed, 0) });

// ---------------------------------------------------------------- the match list

/** The recording player and their team. A match without one cannot be shown from "your" side. */
function pov(file: string, f: MatchFacts): { you: number; usTeam: 0 | 1 } {
  const you = f.players.findIndex((p) => p.id === f.match.pov);
  if (you < 0) throw new Error(`${file}: the recording player (match pov ${f.match.pov ?? "missing"}) is not among the players`);
  const usTeam = f.players[you].team;
  if (usTeam === null) throw new Error(`${file}: the recording player never had a side`);
  return { you, usTeam };
}

const resultOf = (us: number, them: number): MatchEntry["result"] => (us > them ? "W" : us < them ? "L" : "T");

export function entryOf(file: string, origin: string, f: MatchFacts): MatchEntry {
  const { you, usTeam } = pov(file, f);
  const s = rollup([f], { player: f.players[you].id });
  const us = f.match.score[usTeam];
  const them = f.match.score[1 - usTeam];
  return {
    file, origin, match: f.match, players: f.players, you, usTeam, usStartSide: usTeam === 0 ? "CT" : "T",
    score: { us, them }, result: resultOf(us, them),
    hasAim: f.aim.some((a) => a.k === "shots"), hasPos: f.pr.some((r) => r.spawn !== null),
    shots: s.aim.shots, line: lineOf(s, ratedMatch(f.match)),
  };
}

// ---------------------------------------------------------------- one match

const SIDES = { both: {}, t: { sides: ["T" as const] }, ct: { sides: ["CT" as const] } };

/** Hits on the head with guns: HIT_GROUPS[0] summed over the guns of a summary. */
export const gunHeadHits = (s: Summary) => Object.entries(s.weapons).reduce((a, [w, t]) => a + (isGun(w) ? t.groups[0] : 0), 0);

export function matchBundle(entry: MatchEntry, f: MatchFacts): MatchBundle {
  const rated = ratedMatch(f.match);
  const usIds = f.players.filter((p) => p.team === entry.usTeam).map((p) => p.id);
  const themIds = f.players.filter((p) => p.team !== entry.usTeam).map((p) => p.id);
  const you = f.players[entry.you].id;
  const lines = Object.fromEntries(Object.entries(SIDES).map(([k, side]) =>
    [k, f.players.map((p) => lineOf(rollup([f], { player: p.id, ...side }), rated))])) as MatchBundle["lines"];
  const team = (ids: string[]) => lineOf(rollup([f], { player: ids }), rated);
  const byRound = (player: string | string[], n: number) => rollup([f], { player, rounds: [n] });
  return {
    core: { v: f.v, match: f.match, players: f.players, rounds: f.rounds, pr: f.pr, kills: f.kills },
    lines,
    teams: { us: team(usIds), them: team(themIds) },
    economy: economyOf(f, entry.usTeam),
    teamSwing: f.rounds.map((r) => { const m = byRound(usIds, r.number).m; return m.swingRounds ? m.swing : null; }),
    yourRounds: f.rounds.map((r) => valuesOf(byRound(you, r.number))),
    grenades: grenadesOf([f], { player: f.players.map((p) => p.id) }).map((x) => x.g),
    presence: rollup([f], { player: you }).presence[f.match.map] ?? null,
  };
}

/** Every player's numbers in one round, by player index; null for a player without a row in it. */
export function roundBundle(f: MatchFacts, number: number): RoundBundle {
  return {
    number,
    players: f.players.map((p) => {
      const s = rollup([f], { player: p.id, rounds: [number] });
      const { shots, hits, first, firstHits } = s.aim;
      return s.m.rounds ? { m: s.m, v: valuesOf(s), aim: { shots, hits, first, firstHits }, headHits: gunHeadHits(s) } : null;
    }),
  };
}

// ---------------------------------------------------------------- positions

/** Adds one match's kill and death positions for the filter's players to `out`. */
export function addPositions(out: PositionsResult, f: MatchFacts, filter: Filter): void {
  if (filter.maps && !filter.maps.includes(f.match.map)) return;
  const ids = new Set(Array.isArray(filter.player) ? filter.player : [filter.player]);
  for (const k of f.kills) {
    if (k.enemy && k.killer !== null && k.kpos && ids.has(f.players[k.killer].id)) out.kills.push(k.kpos);
    if (k.vpos && ids.has(f.players[k.victim].id)) out.deaths.push(k.vpos);
  }
}
