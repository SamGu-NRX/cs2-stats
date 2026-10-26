// "Hide personal info" (Data & settings), so a screenshot of the app never needs blurring. With it on,
// the views are handed data in which:
// - the user's own name reads "You";
// - every other human in a match that is not a pro demo reads "Teammate 1", "Opponent 3" or, without a
//   side, "Player 2", numbered in the file's player order within each team, so a match reads the same
//   in every view and every tab;
// - bots keep their names, which are the game's, and players in pro demos keep theirs, being public;
// - absolute paths, SteamIDs and Steam profile links in any text the app shows become placeholders.
// Numbers are never touched. SteamIDs stay inside the data, because every query is keyed by them; no
// view prints one.
//
// Where it is applied, which is where names, errors and paths enter the views:
// - DataValue (provider.tsx): the match list, the scan and file errors, the baselines' errors;
// - useMatch and useAsync (hooks.ts): a match's players, and every worker call's error;
// - usePros (packs.ts) and the replay's round loader (Replay.tsx): their errors;
// - copyText (overlay.tsx): text put on the clipboard;
// - Data & settings, the one view that shows the host's folders, the Valve user and the importer's
//   output, passes them through hideText and FOLDER_HIDDEN.
// privacy.test.tsx renders every page and tab with sentinel names, SteamIDs and paths, and fails when
// one reaches the page or the window title.
//
// Capture runs turn it on without clicking: VITE_PRIVACY=1 when Vite starts (`pnpm capture` sets it),
// or ?privacy=1 in the page's URL. Either one holds it on for the session; the saved setting is left
// as it was.
import { useSyncExternalStore } from "react";
import type { PlayerInfo } from "../../stats/facts";
import type { MatchBundle } from "../../worker/protocol";
import type { MatchEntry } from "./match";
import type { Data } from "./provider";
import { sourceOf } from "./sources";

// ---------------------------------------------------------------- the setting

const KEY = "cs2stats.hidePersonal";

/** The capture switch: VITE_PRIVACY is "1", or the page's query has privacy=1. */
export const privacySwitch = (env: unknown, search: string) => env === "1" || new URLSearchParams(search).get("privacy") === "1";

const FORCED = privacySwitch(import.meta.env.VITE_PRIVACY, typeof location === "undefined" ? "" : location.search);
let saved = typeof localStorage === "undefined" ? false : localStorage.getItem(KEY) === "1";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The capture switch is on, so the setting is on whatever was saved. */
export const privacyForced = () => FORCED;
/** Personal info is hidden: forced by the switch, or saved in Data & settings. */
export const hidingPersonal = () => FORCED || saved;
/** The saved setting, off until the user turns it on. */
export const savedHidePersonal = () => saved;

export function setHidePersonal(on: boolean) {
  saved = on;
  localStorage.setItem(KEY, on ? "1" : "0");
  for (const fn of listeners) fn();
}

/** Whether personal info is hidden, re-rendering when the setting changes. */
export const useHidePersonal = () => useSyncExternalStore(subscribe, hidingPersonal);
/** The saved setting, for the switch in Data & settings. */
export const useSavedHidePersonal = () => useSyncExternalStore(subscribe, savedHidePersonal);

// ---------------------------------------------------------------- names

export const YOU = "You";

interface Seat {
  /** index of the recording player */
  you: number;
  usTeam: 0 | 1;
  /** a pro demo: every player is a public figure */
  pro: boolean;
}

const seatOf = (e: MatchEntry): Seat => ({ you: e.you, usTeam: e.usTeam, pro: sourceOf(e).id === "pro" });

/** One match's players under the rules at the top of this file, in the same order. */
export function hidePlayers(players: PlayerInfo[], seat: Seat): PlayerInfo[] {
  if (seat.pro) return players;
  let mates = 0, opponents = 0, unsided = 0;
  return players.map((p, i) => {
    if (i === seat.you) return { ...p, name: YOU };
    if (p.bot) return p;
    const name = p.team === null ? `Player ${++unsided}` : p.team === seat.usTeam ? `Teammate ${++mates}` : `Opponent ${++opponents}`;
    return { ...p, name };
  });
}

export const hideEntry = (e: MatchEntry): MatchEntry => ({ ...e, players: hidePlayers(e.players, seatOf(e)) });

/** A match's bundle with its players named as in its entry; the entry and the bundle list the same players in the same order (worker/views.ts). */
export const hideBundle = (b: MatchBundle, e: MatchEntry): MatchBundle => ({ ...b, core: { ...b.core, players: hidePlayers(b.core.players, seatOf(e)) } });

// ---------------------------------------------------------------- text

export const PATH_HIDDEN = "<path>";
export const STEAMID_HIDDEN = "<SteamID>";
/**
 * The folders Data & settings shows once the host has resolved them. Before that it shows them as
 * %APPDATA%\BotMatchStats\..., which holds nothing personal and stays.
 */
export const FOLDER_HIDDEN = { data: "<data folder>", valve: "<Valve folder>" } as const;

// A path ends at a quote, a bracket or a character no file name can hold. Folder names may contain
// spaces, so a path runs to its last separator on the line, then to the end of its last name, which
// stops at a space. When that takes in a few words after the path, more is hidden than needed; a
// file name with a space in it ("My demo.dem") keeps the words after the space, which name no one.
const NAME_END = String.raw`[^\\/\s<>|"'?*:,;)]*`;
const SEGMENTS = String.raw`(?:[^\\/\r\n<>|"'?*:]*[\\/])*`;
const RULES: [RegExp, string][] = [
  [/(?:\bhttps?:\/\/)?(?:\bwww\.)?\bsteamcommunity\.com\/(?:profiles|id)\/[^\s'"<>)]+/gi, "<Steam profile>"],
  [/\b7656119\d{10}\b/g, STEAMID_HIDDEN],
  [/\bSTEAM_[0-5]:[01]:\d+\b|\[U:1:\d+\]/g, STEAMID_HIDDEN],
  // C:\... or C:/..., then \\server\share\...
  [new RegExp(String.raw`\b[A-Za-z]:[\\/]${SEGMENTS}${NAME_END}`, "g"), PATH_HIDDEN],
  [new RegExp(String.raw`\\\\[^\\/\s<>|"'?*:]+[\\/]${SEGMENTS}${NAME_END}`, "g"), PATH_HIDDEN],
  // /home/name/..., two names at least; not a URL's path, a relative path such as 2026/x.json.gz, or "and/or"
  [new RegExp(String.raw`(?<![\w.:/\\~%-])\/(?:[^\\/\r\n<>|"'?*:]+\/)+${NAME_END}`, "g"), PATH_HIDDEN],
];

/** Text with every absolute path, SteamID and Steam profile link replaced by a placeholder. */
export function hideText(s: string): string {
  let out = s;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

const hideOrNull = (s: string | null) => (s === null ? null : hideText(s));

/** What the views read from the provider, with personal info hidden; the host is passed as it is (see the top of this file). */
export function hideData(d: Data): Data {
  return {
    ...d,
    matches: d.matches.map(hideEntry),
    error: hideOrNull(d.error),
    fileErrors: d.fileErrors.map((e) => ({ file: hideText(e.file), message: hideText(e.message) })),
    baselines: d.baselines && { ...d.baselines, source: hideText(d.baselines.source), localError: hideOrNull(d.baselines.localError) },
    baselinesError: hideOrNull(d.baselinesError),
  };
}
