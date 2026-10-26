// Who took part in each round, applied once to a match's tables (rules.ts onRoster). derive and every
// view that reads tables (head to head, map zones, round places, the Flash Tool, the replay) take the
// tables this returns, so none of them decides participation on its own: an event of a player off
// their round's roster is simply not there.
import type { MatchFacts } from "./facts";
import { onRoster } from "./rules";
import type { MatchTables, Table, TableName } from "./tables";

/** What rosterTables removed, by kind: the match view's note reads it (MatchInfo.inputs.offRoster). */
export interface OffRoster {
  /** kills by or of a player off the roster */
  kills: number;
  /** assists credited to one, on a kill that stays (the assist is cleared) */
  assists: number;
  /** damage rows by or on one */
  damages: number;
  /** blinds by or on one */
  blinds: number;
  /** their grenade throws, detonations, smokes and fires */
  grenades: number;
  shots: number;
  /** their position samples while alive */
  positions: number;
  /** radar spotted changes by or of one */
  spotted: number;
  /** engagements by or on one, with their per-tick rows */
  engagements: number;
}

/** Match tables with the roster applied; the only tables derive's families and the match views read. */
export type RosterTables = MatchTables & {
  readonly roster: {
    /** steamids off each round's roster, by round number */
    off: ReadonlyMap<number, ReadonlySet<string>>;
    removed: OffRoster;
  };
};

const sided = (s: string | null) => s === "CT" || s === "T";

/** Steamids off each round's roster (rules.ts onRoster), by round number. */
function offPlayers(t: MatchTables): Map<number, Set<string>> {
  const R = t.rounds;
  // onRoster reads player indices; any stable numbering will do
  const ix = new Map<string, number>();
  const n = (id: string) => { let i = ix.get(id); if (i === undefined) ix.set(id, (i = ix.size)); return i; };
  const out = new Map<number, Set<string>>();
  for (let ri = 0; ri < R.n; ri++) {
    const round = R.round[ri];
    const rf = { freezeEndTick: R.freeze_end_tick[ri], leaves: [] as { tick: number; pi: number }[] };
    const L = t.leaves;
    if (L) for (let i = 0; i < L.n; i++) if (L.round[i] === round && L.alive[i]) rf.leaves.push({ tick: L.tick[i], pi: n(L.steamid[i]) });
    const kills: { tick: number; victim: number }[] = [];
    for (let i = 0; i < t.kills.n; i++) if (t.kills.round[i] === round) kills.push({ tick: t.kills.tick[i], victim: n(t.kills.victim_steamid[i]) });
    // the round's players: its player_rounds rows with a side; a round without rows (derive.ts buildCtx
    // then seats every player with a team, with no alive flag) can only lose a player by a disconnect
    const rows: [string, boolean | null][] = [];
    const PR = t.player_rounds;
    for (let i = 0; i < PR.n; i++) if (PR.round[i] === round && sided(PR.side[i])) rows.push([PR.steamid[i], PR.alive_at_start[i]]);
    if (!rows.length && L) for (let i = 0; i < L.n; i++) if (L.round[i] === round) rows.push([L.steamid[i], null]);
    const off = new Set(rows.filter(([id, a]) => !onRoster(rf, n(id), a, kills)).map(([id]) => id));
    if (off.size) out.set(round, off);
  }
  return out;
}

/** The rows of `tab` that `keep` passes, every column; and the indices it dropped. */
function select<N extends TableName>(tab: Table<N>, keep: (i: number) => boolean): [Table<N>, number[]] {
  const kept: number[] = [];
  const dropped: number[] = [];
  for (let i = 0; i < tab.n; i++) (keep(i) ? kept : dropped).push(i);
  if (!dropped.length) return [tab, dropped];
  const out: Record<string, unknown> = { n: kept.length };
  for (const [c, col] of Object.entries(tab as unknown as Record<string, unknown[]>)) if (c !== "n") out[c] = kept.map((i) => col[i]);
  return [out as Table<N>, dropped];
}

/**
 * The match's tables without any event of a player off their round's roster: kills by or of them,
 * damage, blinds and spotted changes by or on them, their grenades, shots and position samples, and
 * engagements either way. An assist of theirs is cleared from a kill that otherwise stays. Their
 * disconnects go too, uncounted: a disconnect acts on no one, and one kept would take a player who is
 * in no population out of it (rules.ts roundPopulation). Their player_rounds rows and purchases stay,
 * and so do the bomb's events and the round's plant and defuse, which decide the round whoever the
 * source names.
 *
 * The tally counts only what shows the player in the live round, after freeze end (alive, for position
 * samples): a player marked dead at freeze end has dead samples, and one who left during freeze time
 * has samples before it, and neither is a fault in the file. Applying it twice changes nothing.
 */
export function rosterTables(t: MatchTables): RosterTables {
  if ("roster" in t) return t as RosterTables;
  const removed: OffRoster = { kills: 0, assists: 0, damages: 0, blinds: 0, grenades: 0, shots: 0, positions: 0, spotted: 0, engagements: 0 };
  const off = offPlayers(t);
  if (!off.size) return { ...t, roster: { off, removed } };
  const fe = new Map<number, number | null>();
  for (let i = 0; i < t.rounds.n; i++) fe.set(t.rounds.round[i], t.rounds.freeze_end_tick[i]);
  const live = (round: number, tick: number) => { const f = fe.get(round); return f === null || f === undefined || tick > f; };
  const isOff = (round: number, id: string | null) => id !== null && off.get(round)?.has(id) === true;
  /** filters `tab`, adding to `kind` the dropped rows at a live tick that `count` (default all) passes */
  const drop = <N extends TableName>(tab: Table<N>, round: (i: number) => number, ids: (i: number) => (string | null)[], tick: (i: number) => number, kind: keyof OffRoster, count: (i: number) => boolean = () => true): Table<N> => {
    const [kept, dropped] = select(tab, (i) => !ids(i).some((id) => isOff(round(i), id)));
    removed[kind] += dropped.filter((i) => live(round(i), tick(i)) && count(i)).length;
    return kept;
  };

  const K = t.kills;
  let kills = drop(K, (i) => K.round[i], (i) => [K.attacker_steamid[i], K.victim_steamid[i]], (i) => K.tick[i], "kills");
  const strip = kills.assister_steamid.map((id, i) => isOff(kills.round[i], id));
  if (strip.some(Boolean)) {
    removed.assists += strip.filter((s, i) => s && live(kills.round[i], kills.tick[i])).length;
    kills = { ...kills, assister_steamid: kills.assister_steamid.map((id, i) => (strip[i] ? null : id)), assistedflash: kills.assistedflash.map((f, i) => (strip[i] ? null : f)) };
  }
  const D = t.damages, B = t.blinds;
  const out: MatchTables = {
    ...t, kills,
    damages: drop(D, (i) => D.round[i], (i) => [D.attacker_steamid[i], D.victim_steamid[i]], (i) => D.tick[i], "damages"),
    blinds: drop(B, (i) => B.round[i], (i) => [B.attacker_steamid[i], B.victim_steamid[i]], (i) => B.tick[i], "blinds"),
  };
  const L = t.leaves;
  if (L) out.leaves = select(L, (i) => !isOff(L.round[i], L.steamid[i]))[0];
  const G = t.grenade_throws, E = t.grenade_events, S = t.smokes, F = t.infernos, SH = t.shots, P = t.positions, SP = t.spotted, EN = t.engagements;
  if (G) out.grenade_throws = drop(G, (i) => G.round[i], (i) => [G.steamid[i]], (i) => G.tick[i], "grenades");
  if (E) out.grenade_events = drop(E, (i) => E.round[i], (i) => [E.steamid[i]], (i) => E.tick[i], "grenades");
  if (S) out.smokes = drop(S, (i) => S.round[i], (i) => [S.steamid[i]], (i) => S.start_tick[i], "grenades");
  if (F) out.infernos = drop(F, (i) => F.round[i], (i) => [F.steamid[i]], (i) => F.start_tick[i], "grenades");
  if (SH) out.shots = drop(SH, (i) => SH.round[i], (i) => [SH.steamid[i]], (i) => SH.tick[i], "shots");
  if (P) out.positions = drop(P, (i) => P.round[i], (i) => [P.steamid[i]], (i) => P.tick[i], "positions", (i) => P.is_alive[i]);
  if (SP) out.spotted = drop(SP, (i) => SP.round[i], (i) => [SP.spotter_steamid[i], SP.target_steamid[i]], (i) => SP.tick[i], "spotted");
  if (EN) {
    out.engagements = drop(EN, (i) => EN.round[i], (i) => [EN.attacker_steamid[i], EN.victim_steamid[i]], (i) => EN.start_tick[i], "engagements");
    const ET = t.engagement_ticks;
    if (ET && out.engagements.n !== EN.n) {
      const ids = new Set(out.engagements.engagement_id);
      out.engagement_ticks = select(ET, (i) => ids.has(ET.engagement_id[i]))[0];
    }
  }
  return { ...out, roster: { off, removed } };
}

/**
 * Whether `player` played a round of the match: has a player-round in its facts, not merely a place in
 * its player list. "Your match" picks recent matches by it, and opponent comparisons find opponents by it.
 */
export const playedMatch = (f: Pick<MatchFacts, "pr" | "players">, player: string) => f.pr.some((r) => f.players[r.pi].id === player);
