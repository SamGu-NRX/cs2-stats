// Per-round views of one match's facts: the round drawer's killfeed and Overview's deciding rounds.
// Pure functions over stats/facts.ts; the views only draw what these return.
import type { KillFact, MatchFacts } from "../../stats/facts";
import type { Side } from "../../stats/tables";
import type { FeedKill } from "../views/match/Killfeed";

/** The parts of a match's facts the round views read (the worker's MatchCore has them). */
type RoundFacts = Pick<MatchFacts, "players" | "kills">;

/**
 * A kill's swing from one team's side: the change in that team's chance to win the round. It comes from
 * the victim's loss credit (the full win-probability change of the death), so a world death, or a kill
 * where no enemy damage was credited, still reads for both teams. Null when the round is not valued.
 */
export function teamSwing(f: RoundFacts, k: KillFact, team: 0 | 1): number | null {
  const loss = k.credits.find(([pi]) => pi === k.victim)?.[1];
  if (loss === undefined) return null;
  return f.players[k.victim]?.team === team ? loss : -loss;
}

/**
 * The round's killfeed as the viewer's team sees it; with no viewer (a pro demo before a pick), as
 * team `usTeam` sees it, the team the match layout puts first.
 */
export function feedFor(f: RoundFacts, ri: number, viewer: number | null, usTeam: 0 | 1 = 0): FeedKill[] {
  const team = viewer === null ? usTeam : (f.players[viewer].team as 0 | 1);
  return f.kills.filter((k) => k.ri === ri).map((k) => ({
    t: k.t,
    killer: k.killer === null || !k.killerSide ? null : { pi: k.killer, name: f.players[k.killer].name, side: k.killerSide },
    victim: { pi: k.victim, name: f.players[k.victim].name, side: k.victimSide ?? (k.killerSide === "T" ? "CT" : "T") },
    assister: k.assister === null ? null : { pi: k.assister, name: f.players[k.assister].name, flash: k.flashAssist },
    weapon: k.weapon, headshot: k.headshot, wallbang: k.wallbang, smoke: k.smoke, noscope: k.noscope, blind: k.killerBlind === true, inAir: k.killerInAir === true,
    opening: k.opening, tradeKill: k.tradeKill,
    swing: teamSwing(f, k, team),
    mine: k.killer === viewer || k.victim === viewer,
  }));
}

/** Your rounds with the largest swing either way, on one side or both, most decisive first. */
export function decidingRounds<R extends { usSide: Side }>(rounds: R[], swingOf: (r: R) => number | null, side: "both" | "t" | "ct", n: number): { r: R; sw: number }[] {
  const want = side === "t" ? "T" : side === "ct" ? "CT" : null;
  return rounds
    .filter((r) => want === null || r.usSide === want)
    .map((r) => ({ r, sw: swingOf(r) }))
    .filter((x): x is { r: R; sw: number } => x.sw !== null && x.sw !== 0)
    .sort((a, b) => Math.abs(b.sw) - Math.abs(a.sw))
    .slice(0, n);
}
