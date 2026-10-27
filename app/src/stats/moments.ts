// Moments: the rounds worth a POV clip (issue #11, design/clips.md). One moment is one player-round
// with something to show: a multi-kill of three or more, a clutch won, a kill that moved the round's
// win probability a lot, a flick kill or the round's opening kill. Each moment carries the demo ticks
// to record, with pre-roll and post-roll, and a one-line reason for the clip's lower third.
//
// Scored from facts alone (design/architecture.md "Clipping"): kills with their swing credits
// (swing.ts), clutches (rules.ts), and sightings with mesh visibility (aim.ts), which only extracted
// demos have. Whether the demo is on disk is the host's question (clips/demo.ts), not the engine's.
import { calloutName } from "../ui/lib/callouts";
import type { MatchFacts } from "./facts";
import type { SightFact } from "./aim";
import { keptRounds, type Filter } from "./rollup";
import type { Side } from "./tables";

/** What earns a player-round a moment. A round can be several, such as a 3K that opened the round. */
export type MomentKind = "ace" | "4k" | "3k" | "clutch" | "swing" | "flick" | "opening";
export const MOMENT_KINDS: MomentKind[] = ["ace", "4k", "3k", "clutch", "swing", "flick", "opening"];

// Clip padding. CS2-povforge (MIT) uses 5 s before the first kill and 3 s after the last as its
// default kill padding (docs/releases/v0.16.4/verification.md); ours copies it. Nobody has checked it
// against a rendered clip yet.
export const PRE_ROLL_S = 5;
export const POST_ROLL_S = 3;

/**
 * How long a clip runs past the POV player's death, when they die before its planned end: long enough
 * to show the death itself. After a death CS2's demo camera leaves the player (death cam, then another
 * player); the director reads that as camera_lost and that take never counts (design/clips.md), so a
 * clip must end before the camera moves. 0.5 s is ours, with no measurement of when CS2 switches: if it
 * switches at the death tick itself, the first supervised render will show camera_lost here too, and
 * the tail has to go to 0.
 */
export const DEATH_TAIL_S = 0.5;

/** The killer's swing credit on one kill from which the kill is a "swing" moment (0.2 = 20 points of round win probability). Ours, no fit. */
export const HIGH_SWING = 0.2;

/**
 * A flick kill: a sighting that ended in the attacker's kill of the victim within FLICK_TTK_S of the
 * onset, after the view turned FLICK_MIN_DEG or more to the first damage (SightFact.moved). Both ours,
 * no fit; extracted demos with mesh visibility only, because plugin files have no sightings.
 */
export const FLICK_MIN_DEG = 30;
export const FLICK_TTK_S = 0.6;

/**
 * Ranking points, ours with no fit: nothing measures which clips people like. A 3K, 4K and ace score
 * 3, 5 and 8; a won 1vN clutch 2 + 1.5 (N - 1); each 0.01 of the player's kill swing 0.1, so a +40%
 * round adds 4; a flick 1.5 each; the opening kill 1.
 */
export const POINTS = { k3: 3, k4: 5, ace: 8, clutchBase: 2, clutchPerEnemy: 1.5, swingPerUnit: 10, flick: 1.5, opening: 1 } as const;

export interface Moment {
  ri: number;
  /** RoundFact.number */
  round: number;
  /** the POV player: players index and SteamID */
  pi: number;
  player: string;
  side: Side;
  kinds: MomentKind[];
  /**
   * the player's enemy kills in the round, in order: tick, weapon and flags for the killfeed. All of
   * them count toward the kinds and the score; `inClip` is false for a kill after endTick, which the
   * video does not show (clipNote says why)
   */
  kills: { tick: number; weapon: string; headshot: boolean; wallbang: boolean; smoke: boolean; noscope: boolean; blind: boolean | null; inAir: boolean | null; inClip: boolean }[];
  /** the player's kills that were flicks (FLICK_MIN_DEG) */
  flicks: number;
  /** the clutch won in the round: enemies left when it began */
  clutch: { opponents: number } | null;
  /**
   * Round impact: the player's swing credits on their own kills in the round, added up, as a
   * win-probability fraction; null when the round was not valued (no win probability). It leaves out the
   * round-end remainder and the player's own death, so it says what the clipped kills were worth. It
   * is a sum of credits, not one change in probability, so it passes 1 when the round swings back and
   * forth (clips/state.ts ROUND_IMPACT_TIP says so in the app).
   */
  swing: number | null;
  /** where most of the kills were, raw ("BombsiteB"); null when the source records no place */
  place: string | null;
  /**
   * demo ticks to record: PRE_ROLL_S before the first event, POST_ROLL_S after the last, no earlier
   * than freeze end and no later than the round's end (or the last kill, when a kill came after it),
   * nor than DEATH_TAIL_S after the player's death or than their disconnect
   */
  startTick: number;
  endTick: number;
  /**
   * Why some of the kills are not in the clip, with the numbers: "The 4th kill came 2.1 s after they
   * died. The clip ends 0.5 s after the death, so it isn't in the video." Null when every kill is in it.
   */
  clipNote: string | null;
  tickRate: number;
  score: number;
  /** "3K on B Site, +38% round impact" */
  reason: string;
}

const MULTI: Record<number, MomentKind> = { 3: "3k", 4: "4k" };
const multiOf = (n: number): MomentKind | null => (n >= 5 ? "ace" : MULTI[n] ?? null);
const MULTI_LABEL: Partial<Record<MomentKind, string>> = { ace: "Ace", "4k": "4K", "3k": "3K" };
const MULTI_POINTS: Partial<Record<MomentKind, number>> = { ace: POINTS.ace, "4k": POINTS.k4, "3k": POINTS.k3 };

/** The most frequent of the places, the earliest on a tie; null when none is known. */
function modePlace(places: (string | null)[]): string | null {
  const n = new Map<string, number>();
  for (const p of places) if (p) n.set(p, (n.get(p) ?? 0) + 1);
  let best: string | null = null;
  for (const [p, c] of n) if (best === null || c > n.get(best)!) best = p;
  return best;
}

/** Signed whole percent: 0.384 reads "+38%". */
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.round(Math.abs(x) * 100)}%`;

/**
 * The moment's line for the lower third and the list: the headline (multi-kill, else the clutch, else
 * the kind), where, then the other kinds and the round impact. "3K on B Site, opening kill, +38% round impact".
 */
export function momentReason(m: Pick<Moment, "kinds" | "clutch" | "place" | "swing" | "flicks">): string {
  const multi = m.kinds.find((k) => MULTI_LABEL[k]);
  const clutch = m.clutch ? `1v${m.clutch.opponents} clutch` : null;
  const head = multi ? MULTI_LABEL[multi]! : clutch ?? (m.kinds.includes("flick") ? "Flick kill" : m.kinds.includes("opening") ? "Opening kill" : "High-swing kill");
  const parts = [m.place ? `${head} on ${calloutName(m.place)}` : head];
  if (multi && clutch) parts.push(clutch);
  if (m.flicks && head !== "Flick kill") parts.push(m.flicks > 1 ? `${m.flicks} flicks` : "flick");
  if (m.kinds.includes("opening") && head !== "Opening kill") parts.push("opening kill");
  if (m.swing !== null && Math.abs(m.swing) >= 0.005) parts.push(`${pct(m.swing)} round impact`);
  return parts.join(", ");
}

/**
 * Every moment among the player-rounds `filter` keeps, in round order. A player-round without an
 * enemy kill or a won clutch has none. Throws when the match has no tick rate, since every tick
 * this returns depends on it.
 */
export function scoreMoments(f: MatchFacts, filter: Filter): Moment[] {
  const rate = f.match.tickRate;
  if (!(rate > 0)) throw new Error(`scoreMoments: match ${f.match.id} has no tick rate (${rate})`);
  const won = new Map(f.clutches.filter((c) => c.won).map((c) => [c.ri * 1024 + c.pi, c]));
  // flick kills by round, player and kill tick
  const flicks = new Set<string>();
  for (const a of f.aim) {
    if (a.k !== "sight") continue;
    const s = a as SightFact;
    if (s.killTick !== null && s.ttk !== null && s.ttk <= FLICK_TTK_S && s.moved !== null && s.moved >= FLICK_MIN_DEG) flicks.add(`${s.ri}|${s.pi}|${s.killTick}`);
  }
  const out: Moment[] = [];
  for (const r of keptRounds(f, filter)) {
    const round = f.rounds[r.ri];
    const kills = f.kills.filter((k) => k.ri === r.ri && k.enemy && k.killer === r.pi);
    const clutch = won.get(r.ri * 1024 + r.pi) ?? null;
    if (!kills.length && !clutch) continue;
    const credit = (k: (typeof kills)[number]) => k.credits.reduce((s, [p, v]) => (p === r.pi ? s + v : s), 0);
    const valued = round.winProb !== null;
    const swing = valued ? kills.reduce((s, k) => s + credit(k), 0) : null;
    const kinds: MomentKind[] = [];
    const multi = multiOf(kills.length);
    if (multi) kinds.push(multi);
    if (clutch) kinds.push("clutch");
    if (valued && kills.some((k) => credit(k) >= HIGH_SWING)) kinds.push("swing");
    const nFlicks = kills.filter((k) => flicks.has(`${r.ri}|${r.pi}|${k.tick}`)).length;
    if (nFlicks) kinds.push("flick");
    if (kills.some((k) => k.opening)) kinds.push("opening");
    if (!kinds.length) continue;

    // the events the clip must hold: the kills, and a won clutch from its start to the round's end
    const fe = round.freezeEndTick;
    const ticks = kills.map((k) => k.tick);
    if (clutch) {
      ticks.push(clutch.t !== null && fe !== null ? fe + Math.round(clutch.t * rate) : ticks[0] ?? round.endTick);
      ticks.push(round.endTick);
    }
    const first = Math.min(...ticks), last = Math.max(...ticks);
    const startTick = Math.max(fe ?? 0, first - Math.round(PRE_ROLL_S * rate));
    // the post-roll stays inside the round: it stops at the round's end, or at the last kill when one
    // came after the end (a kill in the round-end delay), so no clip runs into the next round
    const planned = Math.min(last + Math.round(POST_ROLL_S * rate), Math.max(round.endTick, last));
    // and it stops DEATH_TAIL_S after the player dies, before the demo camera leaves them, or when they
    // disconnect alive, since the camera cannot follow a player who left. A kill the player's grenade makes
    // after that is cut off: their view cannot show it. An exit before the clip starts (a moment of such
    // kills alone) leaves the clip as it was.
    const exit = playerExit(f, r.ri, r.pi, rate);
    const endTick = exit && exit.tick >= startTick ? Math.min(planned, exit.end) : planned;
    const cut = kills.map((k, i) => ({ n: i + 1, tick: k.tick })).filter((k) => k.tick > endTick);

    const score = (multi ? MULTI_POINTS[multi]! : 0)
      + (clutch ? POINTS.clutchBase + POINTS.clutchPerEnemy * (clutch.opponents - 1) : 0)
      + POINTS.swingPerUnit * Math.max(0, swing ?? 0)
      + POINTS.flick * nFlicks
      + (kinds.includes("opening") ? POINTS.opening : 0);
    const m: Omit<Moment, "reason"> = {
      ri: r.ri, round: round.number, pi: r.pi, player: f.players[r.pi].id, side: r.side, kinds,
      kills: kills.map((k) => ({ tick: k.tick, weapon: k.weapon, headshot: k.headshot, wallbang: k.wallbang, smoke: k.smoke, noscope: k.noscope, blind: k.killerBlind, inAir: k.killerInAir, inClip: k.tick <= endTick })),
      flicks: nFlicks, clutch: clutch && { opponents: clutch.opponents },
      swing, place: modePlace(kills.map((k) => k.place)), startTick, endTick, tickRate: rate, score: Math.round(score * 100) / 100,
      clipNote: cut.length && exit ? clipNote(cut, exit, rate) : null,
    };
    out.push({ ...m, reason: momentReason(m) });
  }
  return out;
}

/** How the player's round ends early for the camera: their first death, or their disconnect alive, whichever is first; `end` is where a clip must stop. */
interface Exit { kind: "death" | "disconnect"; tick: number; end: number }

function playerExit(f: MatchFacts, ri: number, pi: number, rate: number): Exit | null {
  const death = f.kills.reduce((d, k) => (k.ri === ri && k.victim === pi && k.tick < d ? k.tick : d), Infinity);
  const leave = f.rounds[ri].leaves.reduce((d, l) => (l.pi === pi && l.tick < d ? l.tick : d), Infinity);
  if (death === Infinity && leave === Infinity) return null;
  return death <= leave ? { kind: "death", tick: death, end: death + Math.round(DEATH_TAIL_S * rate) } : { kind: "disconnect", tick: leave, end: leave };
}

const ORDINAL = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"];
const ordinal = (n: number) => ORDINAL[n - 1] ?? `${n}th`;
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The moment's line about its kills after the clip's end: which ones, how long after the exit, and why the clip stops there. */
function clipNote(cut: { n: number; tick: number }[], exit: Exit, rate: number): string {
  const one = cut.length === 1;
  const which = `The ${andList(cut.map((k) => ordinal(k.n)))} kill${one ? "" : "s"}`;
  const after = andList(cut.map((k) => `${((k.tick - exit.tick) / rate).toFixed(1)} s`));
  const event = exit.kind === "death" ? "died" : "disconnected";
  const ends = exit.kind === "death" ? `The clip ends ${DEATH_TAIL_S} s after the death` : "The clip ends when they left";
  return `${which} came ${after} after they ${event}. ${ends}, so ${one ? "it isn't" : "they aren't"} in the video.`;
}

/** Best first: the higher score, then the larger swing, then the earlier round, so ties keep one order. */
export const bestMomentFirst = (a: Pick<Moment, "score" | "swing" | "round">, b: Pick<Moment, "score" | "swing" | "round">) =>
  b.score - a.score || (b.swing ?? 0) - (a.swing ?? 0) || a.round - b.round;
