// Per-round views of one match's facts for the Rounds grid, the round drawer's killfeed and the clutch
// list. Pure functions over stats/facts.ts; the views only draw what these return.
import type { KillFact, MatchFacts } from "../../stats/facts";
import type { Side } from "../../stats/tables";
import type { FeedKill } from "../views/match/Killfeed";

/** The parts of a match's facts the round views read (the worker's MatchCore has them). */
type RoundFacts = Pick<MatchFacts, "players" | "rounds" | "pr" | "kills">;

/** One player in one round: one encoding per question in the grid. */
export interface RoundCell {
  side: Side;
  kills: number;
  died: boolean;
  /** this player made ("k") or took ("d") the round's opening kill */
  opening: "k" | "d" | null;
  /** the player's swing that round (sum of their kill and death credits), a fraction; null when the round is not valued */
  swing: number | null;
}

/** cells[pi][ri]; null where the player did not play the round. */
export function roundCells(f: RoundFacts): (RoundCell | null)[][] {
  const cells: (RoundCell | null)[][] = f.players.map(() => f.rounds.map(() => null));
  for (const r of f.pr) cells[r.pi][r.ri] = { side: r.side, kills: r.m.kills ?? 0, died: (r.m.deaths ?? 0) > 0, opening: null, swing: null };
  for (const k of f.kills) {
    if (k.opening) {
      if (k.killer !== null && cells[k.killer][k.ri]) cells[k.killer][k.ri]!.opening = "k";
      if (cells[k.victim][k.ri]) cells[k.victim][k.ri]!.opening = "d";
    }
    for (const [pi, pts] of k.credits) { const c = cells[pi]?.[k.ri]; if (c) c.swing = (c.swing ?? 0) + pts; }
  }
  return cells;
}

/** A kill's swing from one team's side: the sum of the kill's credits to that team's players. */
export function teamSwing(f: RoundFacts, k: KillFact, team: 0 | 1): number | null {
  if (!k.credits.length) return null;
  return k.credits.reduce((s, [pi, pts]) => (f.players[pi]?.team === team ? s + pts : s), 0);
}

/** The round's killfeed as the viewer's team sees it. */
export function feedFor(f: RoundFacts, ri: number, viewer: number): FeedKill[] {
  const team = f.players[viewer].team as 0 | 1;
  return f.kills.filter((k) => k.ri === ri).map((k) => ({
    t: k.t,
    killer: k.killer === null || !k.killerSide ? null : { name: f.players[k.killer].name, side: k.killerSide },
    victim: { name: f.players[k.victim].name, side: k.victimSide ?? (k.killerSide === "T" ? "CT" : "T") },
    assister: k.assister === null ? null : { name: f.players[k.assister].name, flash: k.flashAssist },
    weapon: k.weapon, headshot: k.headshot, wallbang: k.wallbang, smoke: k.smoke, noscope: k.noscope, blind: k.killerBlind === true, inAir: k.killerInAir === true,
    opening: k.opening, tradeKill: k.tradeKill,
    swing: teamSwing(f, k, team),
    mine: k.killer === viewer || k.victim === viewer,
  }));
}

export interface Clutch { ri: number; pi: number; side: Side; against: number; won: boolean; killsAfter: number }

/**
 * Clutches from the kill order: the moment a player is the last of their side alive with enemies still
 * up. Players who joined a round dead (no player-round row) are not counted alive.
 */
export function clutchesOf(f: RoundFacts): Clutch[] {
  const out: Clutch[] = [];
  f.rounds.forEach((r, ri) => {
    const side = new Map(f.pr.filter((x) => x.ri === ri).map((x) => [x.pi, x.side] as const));
    const alive = new Set(side.keys());
    const kills = f.kills.filter((k) => k.ri === ri).sort((a, b) => a.tick - b.tick);
    const seen = new Set<Side>();
    kills.forEach((k, i) => {
      alive.delete(k.victim);
      for (const s of ["T", "CT"] as const) {
        if (seen.has(s)) continue;
        const mates = [...alive].filter((p) => side.get(p) === s), foes = [...alive].filter((p) => side.get(p) !== s);
        if (mates.length === 1 && foes.length > 0) {
          seen.add(s);
          const pi = mates[0];
          out.push({ ri, pi, side: s, against: foes.length, won: r.winner === s, killsAfter: kills.slice(i + 1).filter((x) => x.killer === pi && x.enemy).length });
        }
      }
    });
  });
  return out;
}
