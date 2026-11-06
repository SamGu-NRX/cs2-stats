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
import type { Measures } from "../../stats/facts";
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
  "Rating 3.0, KAST, openings, clutches, multi-kills and pro comparisons always use the game's credit.";

/** What "you" adds to one line: the player's play in bots' bodies, less a human's play in this one. */
export interface Shift { kills: number; hsKills: number; deaths: number; dmg: number }

const at = (m: Partial<Measures>, k: keyof Measures) => m[k] ?? 0;

export function shiftOf(m: Partial<Measures>): Shift {
  return {
    kills: at(m, "takeoverKills") - at(m, "drivenKills"),
    hsKills: at(m, "takeoverHsKills") - at(m, "drivenHsKills"),
    deaths: at(m, "takeoverDeaths") - at(m, "drivenDeaths"),
    dmg: at(m, "takeoverDmg") - at(m, "drivenDmg"),
  };
}

/** Whether any takeover play is in these measures, made by this player or in this player's body. */
export const hasTakeover = (m: Partial<Measures>) =>
  (["takeoverKills", "takeoverDeaths", "takeoverDmg", "drivenKills", "drivenDeaths", "drivenDmg"] as const).some((k) => at(m, k) !== 0);

/** A stat line under a credit, with the game's own line beside it. */
export type CreditedLine = StatLine & {
  game: StatLine;
  /** what "you" moves on this line, whichever credit is chosen; null when it moves nothing */
  shift: Shift | null;
  /** the line differs from the game's: "you" is chosen and something moved */
  moved: boolean;
};

/** The figures of a stat line the credit can change. */
export type CreditField = "kills" | "deaths" | "diff" | "adr" | "hs" | "kpr" | "dpr";

/** Whether a shift changes a figure of the line. */
export function shifts(s: Shift | null, f: CreditField): boolean {
  if (!s) return false;
  switch (f) {
    case "kills": case "kpr": return s.kills !== 0;
    case "deaths": case "dpr": return s.deaths !== 0;
    case "diff": return s.kills !== s.deaths;
    case "adr": return s.dmg !== 0;
    case "hs": return s.kills !== 0 || s.hsKills !== 0;
  }
}

const per = (a: number, b: number) => (b ? a / b : null);

/**
 * The line as `c` credits it. Under "bot" it is the line as derived. Under "you" the moved counts are
 * applied to the measures and to the values read from them (the same ratios as stats/metrics.ts kpr,
 * dpr, adr and hs); every other value is the game's.
 */
export function credited(l: StatLine, c: Credit): CreditedLine {
  const s = shiftOf(l.m);
  const shift = s.kills || s.hsKills || s.deaths || s.dmg ? s : null;
  if (c === "bot" || !shift) return { ...l, game: l, shift, moved: false };
  const m: Measures = { ...l.m, kills: l.m.kills + s.kills, hsKills: l.m.hsKills + s.hsKills, deaths: l.m.deaths + s.deaths, dmg: l.m.dmg + s.dmg };
  const adr = per(m.dmg, m.rounds), kpr = per(m.kills, m.rounds), dpr = per(m.deaths, m.rounds);
  const hs = m.kills ? (100 * m.hsKills) / m.kills : null;
  return {
    ...l, m, v: { ...l.v, adr, kpr, dpr, hs }, kills: m.kills, deaths: m.deaths, diff: m.kills - m.deaths, adr, kpr, dpr, hs,
    game: l, shift, moved: true,
  };
}
