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
  /** the player's enemy kills in the round, in order: tick, weapon and flags for the killfeed */
  kills: { tick: number; weapon: string; headshot: boolean; wallbang: boolean; smoke: boolean; noscope: boolean; blind: boolean | null; inAir: boolean | null }[];
  /** the player's kills that were flicks (FLICK_MIN_DEG) */
  flicks: number;
  /** the clutch won in the round: enemies left when it began */
  clutch: { opponents: number } | null;
  /**
   * The player's swing credits on their own kills in the round, a win-probability fraction; null when
   * the round was not valued (no win probability). It leaves out the round-end remainder and the
   * player's own death, so it says what the clipped kills were worth.
   */
  swing: number | null;
  /** where most of the kills were, raw ("BombsiteB"); null when the source records no place */
  place: string | null;
  /** demo ticks to record: PRE_ROLL_S before the first event, POST_ROLL_S after the last */
  startTick: number;
  endTick: number;
  tickRate: number;
  score: number;
  /** "3K on B Site, +38% swing" */
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
 * the kind), where, then the other kinds and the swing. "3K on B Site, opening kill, +38% swing".
 */
export function momentReason(m: Pick<Moment, "kinds" | "clutch" | "place" | "swing" | "flicks">): string {
  const multi = m.kinds.find((k) => MULTI_LABEL[k]);
  const clutch = m.clutch ? `1v${m.clutch.opponents} clutch` : null;
  const head = multi ? MULTI_LABEL[multi]! : clutch ?? (m.kinds.includes("flick") ? "Flick kill" : m.kinds.includes("opening") ? "Opening kill" : "High-swing kill");
  const parts = [m.place ? `${head} on ${calloutName(m.place)}` : head];
  if (multi && clutch) parts.push(clutch);
  if (m.flicks && head !== "Flick kill") parts.push(m.flicks > 1 ? `${m.flicks} flicks` : "flick");
  if (m.kinds.includes("opening") && head !== "Opening kill") parts.push("opening kill");
  if (m.swing !== null && Math.abs(m.swing) >= 0.005) parts.push(`${pct(m.swing)} swing`);
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
    const endTick = last + Math.round(POST_ROLL_S * rate);

    const score = (multi ? MULTI_POINTS[multi]! : 0)
      + (clutch ? POINTS.clutchBase + POINTS.clutchPerEnemy * (clutch.opponents - 1) : 0)
      + POINTS.swingPerUnit * Math.max(0, swing ?? 0)
      + POINTS.flick * nFlicks
      + (kinds.includes("opening") ? POINTS.opening : 0);
    const m: Omit<Moment, "reason"> = {
      ri: r.ri, round: round.number, pi: r.pi, player: f.players[r.pi].id, side: r.side, kinds,
      kills: kills.map((k) => ({ tick: k.tick, weapon: k.weapon, headshot: k.headshot, wallbang: k.wallbang, smoke: k.smoke, noscope: k.noscope, blind: k.killerBlind, inAir: k.killerInAir })),
      flicks: nFlicks, clutch: clutch && { opponents: clutch.opponents },
      swing, place: modePlace(kills.map((k) => k.place)), startTick, endTick, tickRate: rate, score: Math.round(score * 100) / 100,
    };
    out.push({ ...m, reason: momentReason(m) });
  }
  return out;
}

/** Best first: the higher score, then the larger swing, then the earlier round, so ties keep one order. */
export const bestMomentFirst = (a: Pick<Moment, "score" | "swing" | "round">, b: Pick<Moment, "score" | "swing" | "round">) =>
  b.score - a.score || (b.swing ?? 0) - (a.swing ?? 0) || a.round - b.round;
