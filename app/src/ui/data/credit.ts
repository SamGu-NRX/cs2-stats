// Takeover credit: who the views count a takeover for. After dying, the user can take over a living
// teammate bot. The game's own round stats credit what he does in that body to the bot, and so does
// derive (stats/plugin/bodies.ts). With this switch on "you", the stat lines move that play to him: his
// kills, headshot kills, deaths and damage made in a bot's body leave the bot's line and join his, so
// a team's totals stay the same. Derive counts the moved play on both players as measures
// (facts.ts takeover*, driven*), so a switch only re-reads lines and never derives again.
//
// What moves: K, D, +/−, damage, ADR, HS%, KPR and DPR. Assists already go to the controller, as the
// game gives them. Rating 3.0, KAST, openings, trades, clutches, multi-kills and every metric compared
// with pros stay as the game credits them: they assume one life per round, and "you" can give him two
// deaths in one.
//
// One choice for the whole app, kept in localStorage like the privacy setting (privacy.ts), so the
// scoreboard, the match list, Profile and Home agree.
import { useSyncExternalStore } from "react";
import type { Best } from "../../stats/career";
import type { Measures } from "../../stats/facts";
import { shiftOf, youMeasures, type Shift } from "../../stats/takeover";
import type { StatLine } from "./engine";

export type Credit = "bot" | "you";

const KEY = "cs2stats.takeoverCredit";

/** The saved choice; "bot", the game's own credit, when storage is missing, blocked or holds anything else. */
function readSaved(): Credit {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "you" ? "you" : "bot";
  } catch {
    return "bot";
  }
}
let current = readSaved();
/** When the choice last changed, ms since the epoch; 0 before any change this session. */
let changedAt = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const creditNow = () => current;
/** Whether the choice changed in the last `ms`: a number it changes marks the change then, and not when a page merely opens. */
export const creditJustChanged = (ms: number) => Date.now() - changedAt < ms;

/**
 * Saves the choice, then applies it. When storage refuses the write it still applies for this
 * session, and the returned sentence says so for a toast; null when the choice was saved. A choice made
 * from the keyboard is not marked as just changed, so the numbers it moves change without a fade, as
 * the segmented control's thumb jumps (components/controls.tsx).
 */
export function setCredit(c: Credit, keyboard = false): string | null {
  let problem: string | null = null;
  try {
    localStorage.setItem(KEY, c);
  } catch {
    problem = "Takeover credit is set until you close the app; the choice could not be saved.";
  }
  if (c !== current) changedAt = keyboard ? 0 : Date.now();
  current = c;
  for (const fn of listeners) fn();
  return problem;
}

/** The choice, re-rendering when it changes. */
export const useCredit = () => useSyncExternalStore(subscribe, creditNow);

/** The tooltip of the switch, wherever it is shown. */
export const CREDIT_TIP =
  "After you die you can take over a teammate bot. The game credits what you do in its body to the bot.\n" +
  "You: counts those kills, deaths and damage as yours, and takes them off the bot.\n" +
  "Rating 3.0, KAST, openings, clutches, multi-kills, verdicts and pro comparisons always use the game's credit.";

export { shiftOf, type Shift };

const at = (m: Partial<Measures>, k: keyof Measures) => m[k] ?? 0;

/** Whether any takeover play is in these measures, made by this player or in this player's body. */
export const hasTakeover = (m: Partial<Measures>) =>
  (["takeoverKills", "takeoverDeaths", "takeoverDmg", "drivenKills", "drivenDeaths", "drivenDmg"] as const).some((k) => at(m, k) !== 0);

/** A stat line under a credit, with the game's own line beside it. */
export type CreditedLine = StatLine & {
  game: StatLine;
  /** what "you" moves on this line, whichever credit is chosen; null when it moves nothing */
  shift: Shift | null;
  /** the figures whose value under "you" differs from the game's, whichever credit is chosen */
  changed: ReadonlySet<CreditField>;
  /** "you" is chosen and some figure differs from the game's */
  moved: boolean;
};

/** The figures of a stat line the credit can change. */
export type CreditField = "kills" | "deaths" | "diff" | "adr" | "hs" | "kpr" | "dpr";
const FIELDS: readonly CreditField[] = ["kills", "deaths", "diff", "adr", "hs", "kpr", "dpr"];
const NONE: ReadonlySet<CreditField> = new Set();

/**
 * A rate's denominator in the game's measures. Each of these rates is null only when it is 0
 * (stats/metrics.ts per and pct), so a rate that is null over a non-zero denominator is one the line
 * hides: the coverage rule hides a thin log's rates (engine.ts coverEntry).
 */
const OVER: Record<"adr" | "kpr" | "dpr" | "hs", (m: Measures) => number> = { adr: (m) => m.rounds, kpr: (m) => m.rounds, dpr: (m) => m.rounds, hs: (m) => m.kills };

/** The line hides this rate (see OVER): "You" leaves it hidden. */
const hidden = (l: StatLine, f: keyof typeof OVER) => l[f] === null && OVER[f](l.m) !== 0;

/**
 * Whether "You" changes a figure the line shows: its value under "you" differs from the game's. A
 * shift can leave a figure as it was (a kill and a death cancel in +/-, a takeover's headshot share
 * can equal the game's), and a rate the line hides stays hidden; neither is marked.
 */
export const moves = (l: CreditedLine, f: CreditField): boolean => l.changed.has(f);

/** Two figures that read the same: both missing, or equal past floating-point noise. */
const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);

/**
 * The line as `c` credits it. Under "bot" it is the line as derived. Under "you" the moved counts are
 * applied to the measures and to the rates read from them (the same ratios as stats/metrics.ts kpr,
 * dpr, adr and hs), except a rate the line hides, which stays hidden; every other value is the game's.
 * Either way the line says which figures "you" changes (`changed`), so a view can mark them, and
 * fade them when the switch flips back.
 */
export function credited(l: StatLine, c: Credit): CreditedLine {
  const s = shiftOf(l.m);
  const shift = s.kills || s.hsKills || s.deaths || s.dmg ? s : null;
  if (!shift) return { ...l, game: l, shift, changed: NONE, moved: false };
  const m = youMeasures(l.m);
  const rate = (f: keyof typeof OVER, num: number, scale = 1) => (hidden(l, f) || !OVER[f](m) ? null : (scale * num) / OVER[f](m));
  const adr = rate("adr", m.dmg), kpr = rate("kpr", m.kills), dpr = rate("dpr", m.deaths), hs = rate("hs", m.hsKills, 100);
  const you: Record<CreditField, number | null> = { kills: m.kills, deaths: m.deaths, diff: m.kills - m.deaths, adr, hs, kpr, dpr };
  const changed: ReadonlySet<CreditField> = new Set(FIELDS.filter((f) => !same(you[f], l[f])));
  if (c === "bot") return { ...l, game: l, shift, changed, moved: false };
  return {
    ...l, m, v: { ...l.v, adr, kpr, dpr, hs }, kills: m.kills, deaths: m.deaths, diff: m.kills - m.deaths, adr, kpr, dpr, hs,
    game: l, shift, changed, moved: changed.size > 0,
  };
}

/**
 * A personal best under `c`, with the game's beside it. Under "you" a best the credit moves is the one
 * the worker chose from the credited summaries (career.ts Best.you), which may be another match.
 */
export function creditedBest(b: Best, c: Credit): Best & { game: Best } {
  return c === "you" && b.you ? { ...b, value: b.you.value, file: b.you.file, game: b } : { ...b, game: b };
}

/**
 * One of the player's own comparison rows under `c` (this match against recent ones, a period against
 * the one before): under "you", its "You" figures where the worker gave them (career.ts
 * MetricDelta.you), with `moved` set; otherwise the row as it is.
 */
export function creditedRow<T extends { you?: object }>(row: T, c: Credit): T & { moved: boolean } {
  return c === "you" && row.you ? { ...row, ...row.you, moved: true } : { ...row, moved: false };
}
