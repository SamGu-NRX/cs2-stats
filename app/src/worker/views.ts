// What the worker computes for the views, from MatchFacts and summaries: metric values, ratings,
// match bundles and economy views come out of here as plain data (percentiles and similarity: ranking.ts).
// It runs in the stats worker (and in node tests), never on the UI thread.
import { visibilityCoverage } from "../stats/aim";
import { economyOf } from "../stats/economy";
import { DERIVE_VERSION, type MatchFacts } from "../stats/facts";
import { isGun } from "../stats/guns";
import { ROLE_SIGNALS, STYLE } from "../stats/identity";
import { AWPER_MIN_AWP_KPR } from "../stats/compare";
import { ATTRIBUTES, METRICS } from "../stats/metrics";
import type { WinProbSource } from "../stats/model-params";
import { RATING3_INTERCEPT, RATING3_LABEL, RATING3_STATUS, RATING3_TERMS, RATING3_WEIGHTS, rating3Of } from "../stats/rating3";
import { grenadesOf, keptRounds, rollup, type Filter, type Summary } from "../stats/rollup";
import { spawnPosition } from "../stats/positions";
import { swingSources } from "../stats/swing";
import type { Side } from "../stats/tables";
import { startMs, type MatchEntry } from "../ui/data/match";
import { highlightKinds } from "../stats/highlights";
import type {
  ClutchRow, HighlightRow, Line, MatchBundle, MultiKillRow, Meta, PositionsResult, Rolled, RoundBundle, SideRatings, SpawnRow, Values,
} from "./protocol";

export function metaOf(wp: WinProbSource): Meta {
  return {
    metrics: METRICS.map(({ value: _value, why: _why, sample, ...m }) => (sample ? { ...m, sample: { unit: sample.unit, min: sample.min } } : m)),
    attributes: ATTRIBUTES,
    rating: { label: RATING3_LABEL, status: RATING3_STATUS, intercept: RATING3_INTERCEPT, terms: RATING3_TERMS, weights: RATING3_WEIGHTS },
    winProb: { kind: wp.kind, label: wp.label },
    style: [...STYLE],
    signals: ROLE_SIGNALS,
    awperKpr: AWPER_MIN_AWP_KPR,
    deriveVersion: DERIVE_VERSION,
  };
}

export const valuesOf = (s: Summary): Values => Object.fromEntries(METRICS.map((m) => [m.id, m.value(s)]));
/** Each sample-declaring metric's event count (Metric.sample), by metric id. */
export const samplesOf = (s: Summary): Record<string, number> => Object.fromEntries(METRICS.flatMap((m) => (m.sample ? [[m.id, m.sample.n(s)]] : [])));
export const rolled = (s: Summary): Rolled => ({ ...s, v: valuesOf(s), n: samplesOf(s), swingSources: swingSources(s.m), coverage: visibilityCoverage(s.aim) });
// Every rating here is rating3Of's, the one definition (side-weighted, under the one coverage gate);
// so is the rating3 metric in valuesOf, and with it the comparisons and "Work on". A line's eco values
// are the rating's own inputs, over the rounds it rated.
const lineOf = (s: Summary): Line => {
  const r = rating3Of(s);
  const q = r.inputs;
  return {
    m: s.m, v: valuesOf(s), rating: r.value,
    eco: q ? { ek: q.kpr_eco * r.rounds, ed: q.dpr_eco * r.rounds, eadr: q.adr_eco, ekast: q.kast_eco } : null,
  };
};

/** Rating 3.0 on both sides and on each, as rating3BySide defines it, from the three summaries a caller streamed. */
export const ratingsOf = (s: Record<"both" | "T" | "CT", Summary>): SideRatings => ({ both: rating3Of(s.both), T: rating3Of(s.T), CT: rating3Of(s.CT) });

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

/** Rounds each player played (has a row in; rules.ts onRoster), by id; a player with none is absent. */
const playedRounds = (f: MatchFacts): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of f.pr) { const id = f.players[r.pi].id; out[id] = (out[id] ?? 0) + 1; }
  return out;
};

export function entryOf(file: string, origin: string, f: MatchFacts): MatchEntry {
  const { you, usTeam } = pov(file, f);
  const id = f.players[you].id;
  const s = rollup([f], { player: id });
  const us = f.match.score[usTeam];
  const them = f.match.score[1 - usTeam];
  return {
    file, origin, match: f.match, players: f.players, you, usTeam, usStartSide: usTeam === 0 ? "CT" : "T",
    score: { us, them }, result: resultOf(us, them),
    hasAim: f.aim.some((a) => a.k === "shots"), hasPos: f.pr.some((r) => r.spawn !== null),
    shots: s.aim.shots, kills: f.kills.length, line: lineOf(s), played: playedRounds(f),
    activity: f.rounds.some((r) => r.winner !== null) || f.kills.length > 0 || f.pr.some((r) => (r.m.dmg ?? 0) > 0),
  };
}

// ---------------------------------------------------------------- one match

const SIDES = { both: {}, t: { sides: ["T" as const] }, ct: { sides: ["CT" as const] } };

/** Hits on the head with guns: HIT_GROUPS[0] summed over the guns of a summary. */
export const gunHeadHits = (s: Summary) => Object.entries(s.weapons).reduce((a, [w, t]) => a + (isGun(w) ? t.groups[0] : 0), 0);

export function matchBundle(entry: MatchEntry, f: MatchFacts): MatchBundle {
  const usIds = f.players.filter((p) => p.team === entry.usTeam).map((p) => p.id);
  const themIds = f.players.filter((p) => p.team !== entry.usTeam).map((p) => p.id);
  const you = f.players[entry.you].id;
  const lines = Object.fromEntries(Object.entries(SIDES).map(([k, side]) =>
    [k, f.players.map((p) => lineOf(rollup([f], { player: p.id, ...side })))])) as MatchBundle["lines"];
  const team = (ids: string[]) => lineOf(rollup([f], { player: ids }));
  const byRound = (player: string | string[], n: number) => rollup([f], { player, rounds: [n] });
  return {
    core: { v: f.v, match: f.match, players: f.players, rounds: f.rounds, pr: f.pr, kills: f.kills, totalsRounds: f.totalsRounds },
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

// ---------------------------------------------------------------- spawns

/** Spawns seen per map and side over a stream of matches: every player's, and the queried players' with their round counts. */
export interface SpawnIndex {
  all: Map<string, Record<Side, Set<string>>>;
  mine: Map<string, { map: string; side: Side; spawn: string; place: string | null; rounds: number }>;
}

export const emptySpawns = (): SpawnIndex => ({ all: new Map(), mine: new Map() });

/**
 * Adds one match's spawns: every player's to the map's spawn areas, and the rows `filter` keeps (its
 * players, sides, dates and every other filter, as rollup keeps them) to the queried players' spawns.
 */
export function addSpawns(acc: SpawnIndex, f: MatchFacts, filter: Filter): void {
  const map = f.match.map;
  const all = acc.all.get(map) ?? { T: new Set<string>(), CT: new Set<string>() };
  acc.all.set(map, all);
  for (const r of f.pr) if (r.spawn) all[r.side].add(r.spawn);
  for (const r of keptRounds(f, filter)) {
    if (!r.spawn) continue;
    const k = `${map}|${r.side}|${r.spawn}`;
    const cur = acc.mine.get(k);
    if (cur) cur.rounds++;
    else acc.mine.set(k, { map, side: r.side, spawn: r.spawn, place: r.spawnPlace, rounds: 1 });
  }
}

/** The queried players' spawns per side, most used first, each with its map, place name and position in the spawn area (positions.ts spawnPosition). */
export function spawnRows(acc: SpawnIndex): Record<Side, SpawnRow[]> {
  const out: Record<Side, SpawnRow[]> = { T: [], CT: [] };
  for (const s of acc.mine.values()) {
    const sides = acc.all.get(s.map)!;
    out[s.side].push({ ...s, position: spawnPosition(s.spawn, [...sides[s.side]], [...sides[s.side === "T" ? "CT" : "T"]]) });
  }
  for (const side of ["T", "CT"] as const) out[side].sort((a, b) => b.rounds - a.rounds);
  return out;
}

/** Adds one match's rounds that `filter` keeps to its map's count (the rounds per map rolesByMap orders by). */
export function addMapRounds(acc: Record<string, number>, f: MatchFacts, filter: Filter): void {
  const n = keptRounds(f, filter).length;
  if (n) acc[f.match.map] = (acc[f.match.map] ?? 0) + n;
}

/** Adds the clutches of one match (its `file`) whose player-round `filter` keeps. */
export function addClutchRows(out: ClutchRow[], file: string, f: MatchFacts, filter: Filter): void {
  const kept = new Map(keptRounds(f, filter).map((r) => [r.ri * 1024 + r.pi, r]));
  for (const c of f.clutches) {
    const r = kept.get(c.ri * 1024 + c.pi);
    if (r) out.push({ file, round: f.rounds[c.ri].number, side: r.side, player: f.players[c.pi].id, opponents: c.opponents, won: c.won, kills: c.kills, saved: c.saved, t: c.t, afterPlant: c.afterPlant, left: c.left });
  }
}

/** Adds the rounds of one match (its `file`) where a player the filter keeps got two or more kills. */
export function addMultiKillRows(out: MultiKillRow[], file: string, f: MatchFacts, filter: Filter): void {
  for (const r of keptRounds(f, filter)) {
    const kills = r.m.kills ?? 0;
    if (kills >= 2) out.push({ file, round: f.rounds[r.ri].number, side: r.side, player: f.players[r.pi].id, kills, won: r.won });
  }
}

/**
 * Adds the highlights of one match (its `file`) among the player-rounds `filter` keeps: rounds with
 * three or more enemy kills and rounds with a clutch the player won (highlightKinds), each with the
 * player's kills in order for the killfeed icons.
 */
export function addHighlightRows(out: HighlightRow[], file: string, f: MatchFacts, filter: Filter): void {
  const won = new Map(f.clutches.filter((c) => c.won).map((c) => [c.ri * 1024 + c.pi, c]));
  const start = startMs(f.match);
  for (const r of keptRounds(f, filter)) {
    const feed = f.kills.filter((k) => k.ri === r.ri && k.enemy && k.killer === r.pi);
    const c = won.get(r.ri * 1024 + r.pi) ?? null;
    const kinds = highlightKinds(feed.length, c !== null);
    if (!kinds.length) continue;
    out.push({
      file, round: f.rounds[r.ri].number, side: r.side, player: f.players[r.pi].id, start, kinds, kills: feed.length,
      clutch: c && { opponents: c.opponents, kills: c.kills }, won: r.won,
      feed: feed.map((k) => ({ weapon: k.weapon, headshot: k.headshot, wallbang: k.wallbang, smoke: k.smoke, noscope: k.noscope, blind: k.killerBlind, inAir: k.killerInAir })),
    });
  }
}

/** Newest match first, then the later round first; files that share a start time keep one order. */
export const newestHighlightFirst = (a: HighlightRow, b: HighlightRow) => b.start - a.start || b.file.localeCompare(a.file) || b.round - a.round;

/**
 * The files of the player's `n` most recent matches before `file` (by start time, as the match list
 * orders them), for "your match". A match counts when the player played a round of it (MatchEntry.played),
 * not merely when they are among its players.
 */
export function recentFiles(entries: { file: string; match: Pick<MatchEntry["match"], "startedAt" | "date">; played: Record<string, number> }[], file: string, player: string, n: number): string[] {
  const sorted = [...entries].sort((a, b) => startMs(b.match) - startMs(a.match) || b.file.localeCompare(a.file));
  const at = sorted.findIndex((e) => e.file === file);
  if (at < 0) throw new Error(`${file} is not in the match folder; rescan it`);
  return sorted.slice(at + 1).filter((e) => (e.played[player] ?? 0) > 0).slice(0, n).map((e) => e.file);
}
