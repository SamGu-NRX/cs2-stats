// TRANSITIONAL (see adapter.ts): round winners the plugin file leaves null, rebuilt from the scores.
//
// Plugin files before 1.3.0 read each round's result from CCSGameRules.m_iMatchStats_RoundResults,
// which has 30 slots, so every round from the 31st on (overtime) has winSide and how null; a few rush
// files also hold result codes the plugin did not know (recon.unknownResult). rounds.score[i] is the
// [T, CT] score at the start of round i, so the next round's score says who won round i. Scores follow
// the side and swap at half time and at each overtime half, so both are mapped to the human's team
// through the human's side in each round. Plugin 1.3.0 fills those rounds from the round_end event,
// so in its files this rebuilds only what both sources left null (recon.unknownResult).
import { KILL_FLAG, type MatchFile, type RoundHow, type Side } from "./schema";

const other = (s: Side): Side => (s === 2 ? 3 : 2);

const count = (x: number | null | undefined): x is number => Number.isInteger(x) && x! >= 0;

/**
 * [human's team, other team] score at the start of round ri; null when the human has no side or
 * either part of the score is missing, so a missing part is never read as 0.
 */
function teamScore(m: MatchFile, ri: number): [number, number] | null {
  const side = m.rounds.side[ri]?.[m.human] ?? null;
  const s = m.rounds.score[ri];
  if (side === null || !s || !count(s[0]) || !count(s[1])) return null;
  const [t, ct] = s;
  return side === 2 ? [t, ct] : [ct, t];
}

/** Round ri's winner from the score change to round ri + 1: the side whose team's score rose by exactly one while the other's stayed. */
function fromScores(m: MatchFile, ri: number): Side | null {
  const side = m.rounds.side[ri]?.[m.human] ?? null;
  const a = teamScore(m, ri);
  const b = teamScore(m, ri + 1);
  if (side === null || !a || !b) return null;
  if (b[0] - a[0] === 1 && b[1] === a[1]) return side;
  if (b[1] - a[1] === 1 && b[0] === a[0]) return other(side);
  return null;
}

/**
 * The final round of a finished match, which has no next score. A match ends only on a round won by
 * the team that led before it: in overtime a draw is impossible, and in regulation a win by the team
 * one behind would level the score, which ends the match only as a draw. So the side that led wins;
 * the round stays unknown when the score was level, or when overtime was not played and the trailing
 * side was one behind. env.maxrounds decides whether overtime was played.
 */
function finalWinner(m: MatchFile): Side | null {
  const ri = m.rounds.winSide.length - 1;
  const side = m.rounds.side[ri]?.[m.human] ?? null;
  const s = teamScore(m, ri);
  if (m.status !== "complete" || ri < 0 || side === null || !s || s[0] === s[1]) return null;
  const max = m.env.maxrounds;
  const overtime = max !== null && max > 0 && ri + 1 > max;
  if (!overtime && Math.abs(s[0] - s[1]) === 1) return null;
  return s[0] > s[1] ? side : other(side);
}

/**
 * How a round ended, read from the end state the plugin records at round_end, or null when that
 * record does not settle it.
 *
 * A defuser means a defuse. Otherwise each player of the losing side who was alive at freeze end
 * (rounds.alive0) is:
 * - survived, when rounds.equipEnd is above 0: the plugin writes the pawn's equipment value at
 *   round_end if it is alive, 0 if it is dead;
 * - dead, when the file records his death by body (kills.vBody, so a bot a human drove dies as
 *   itself) or his disconnect (leaves) at or before the end tick. Later removals are ignored: the
 *   bomb's blast kills CTs after round_end, and a player may leave after the round;
 * - unknown otherwise, since equipEnd 0 without a recorded death may be a live player carrying
 *   nothing.
 *
 * An unknown loser, or one both dead and survived, leaves the reason null. A driven body's equipEnd
 * may sit in the human's slot, which shows up as exactly such a contradiction. With every loser dead
 * the round was an elimination. With one surviving, a planted T win is the bomb and an unplanted CT
 * win is time; anything else is null. If the file lost kill or disconnect rows to a full buffer
 * (recon.dropped), a death may be missing, so only a defuse is read. Freeze-time kills do not count,
 * since that player respawned for the live round.
 *
 * Used only for rounds whose winner is rebuilt (roundResults). On 41 recorded files it gives the
 * game's reason on all 537 rounds the game reported one for (pnpm takeover-check prints the count).
 * Swing (stats/swing.ts), the round clock (stats/closing.ts) and the bomb events read the reason, so a
 * rule that missed on any of them would not be used.
 */
export function howFromEvidence(m: MatchFile, ri: number, win: Side): RoundHow | null {
  const R = m.rounds;
  if (R.defuser[ri] !== null) return "defuse";
  if (m.recon?.dropped?.kills || m.recon?.dropped?.leaves) return null;
  const fe = R.freezeTick[ri];
  const dur = R.durTicks[ri];
  const equipEnd = R.equipEnd?.[ri];
  if (fe === null || dur === null || !equipEnd) return null;
  const end = fe + dur;
  const dead = new Set<number>();
  const K = m.kills;
  for (let i = 0; i < K.ri.length; i++) {
    if (K.ri[i] === ri && (K.flags[i] & KILL_FLAG.freeze) === 0 && K.tick[i] <= end) dead.add(K.vBody?.[i] ?? K.victim[i]);
  }
  const L = m.leaves;
  for (let i = 0; i < (L?.ri.length ?? 0); i++) if (L!.ri[i] === ri && L!.tick[i] <= end) dead.add(L!.pi[i]);
  const losers = R.side[ri].flatMap((s, pi) => (s === other(win) && R.alive0?.[ri]?.[pi] !== 0 ? [pi] : []));
  if (!losers.length) return null;
  let survivors = 0;
  for (const p of losers) {
    const survived = (equipEnd[p] ?? 0) > 0;
    if (survived === dead.has(p)) return null;
    if (survived) survivors++;
  }
  if (!survivors) return "elim";
  if (R.plantTick[ri] !== null) return win === 2 ? "bomb" : null;
  return win === 3 ? "time" : null;
}

export interface RoundResults {
  winSide: (Side | null)[];
  how: (RoundHow | null)[];
  /** round indices whose winner was rebuilt here */
  recovered: number[];
}

/** The file's round results with null winners rebuilt where the scores decide them. */
export function roundResults(m: MatchFile): RoundResults {
  const n = m.rounds.winSide.length;
  const winSide = [...m.rounds.winSide];
  const how = [...m.rounds.how];
  const recovered: number[] = [];
  for (let ri = 0; ri < n; ri++) {
    if (winSide[ri] !== null) continue;
    const win = ri + 1 < n ? fromScores(m, ri) : finalWinner(m);
    if (win === null) continue;
    winSide[ri] = win;
    how[ri] = howFromEvidence(m, ri, win);
    recovered.push(ri);
  }
  return { winSide, how, recovered };
}

/** Each rule applied to the rounds whose result the file holds, for pnpm takeover-check. */
export function checkResultRules(m: MatchFile) {
  const out = { known: 0, agree: 0, disagree: 0, undecided: 0, finalKnown: 0, finalAgree: 0, finalDisagree: 0, finalUndecided: 0, howKnown: 0, howAgree: 0, howDisagree: 0, howUndecided: 0, recovered: 0, howRecovered: 0 };
  const n = m.rounds.winSide.length;
  const tally = (got: Side | RoundHow | null, want: Side | RoundHow, k: "" | "final" | "how") => {
    const key = (s: string) => (k ? `${k}${s[0].toUpperCase()}${s.slice(1)}` : s) as keyof typeof out;
    out[key("known")]++;
    out[key(got === null ? "undecided" : got === want ? "agree" : "disagree")]++;
  };
  for (let ri = 0; ri < n; ri++) {
    const win = m.rounds.winSide[ri];
    if (win === null) continue;
    if (ri + 1 < n) tally(fromScores(m, ri), win, "");
    else if (m.status === "complete") tally(finalWinner(m), win, "final");
    const how = m.rounds.how[ri];
    if (how !== null) tally(howFromEvidence(m, ri, win), how, "how");
  }
  const r = roundResults(m);
  out.recovered = r.recovered.length;
  out.howRecovered = r.recovered.filter((ri) => r.how[ri] !== null).length;
  return out;
}
