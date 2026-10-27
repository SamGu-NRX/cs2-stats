// "Hide personal info" (Data & settings), so a screenshot of the app never needs blurring. With it on,
// the views are handed data in which:
// - the user's own name reads "You";
// - every other human in a match that is not a pro demo reads "Teammate 1", "Opponent 3" or, without a
//   side, "Player 2", numbered in the file's player order within each team, so a match reads the same
//   in every view and every tab;
// - bots keep their names, which are the game's, and players in pro demos keep theirs, being public.
//   A match is a pro demo only when its own source tag says so (isProDemo); without that, every human
//   in it is hidden;
// - absolute paths, file URLs, SteamIDs and Steam profile links in any text the app shows become
//   placeholders, and so do the names of match files, which the user chooses for imported ones.
// Numbers are never touched. SteamIDs stay inside the data, because every query is keyed by them; no
// view prints one.
//
// Where it is applied, which is where names, errors and paths enter the views:
// - DataValue (provider.tsx): the match list, the scan and file errors, the baselines' errors;
// - useMatch and useAsync (hooks.ts): a match's players, and every worker call's error;
// - usePros (packs.ts) and the replay's round loader (Replay.tsx): their errors;
// - copyText (overlay.tsx): text put on the clipboard, or the hidden form its caller gives;
// - Data & settings, the one view that shows the host's folders, the Valve user and the importer's
//   output, passes them through hideText and FOLDER_HIDDEN;
// - useLeetify (leetify/store.ts): the imported Leetify profile and matches (hideLeetifyData), the
//   connected player (hideLeetifyStatus) and Leetify's errors. A Leetify profile link names the player's
//   SteamID, so while hiding, LeetifyLink (views/leetify/parts.tsx) opens it from a button and never
//   writes it into the page.
// privacy.test.tsx renders every page and tab with sentinel names, SteamIDs and paths, and fails when
// one reaches the page or the window title.
//
// Capture runs turn it on without clicking: VITE_PRIVACY=1 when Vite starts (`pnpm capture` sets it),
// or ?privacy=1 in the page's URL. Either one holds it on for the session; the saved setting is left
// as it was.
import { useSyncExternalStore } from "react";
import type { LeetifyStatus } from "../../host/leetify";
import type { PlayerInfo } from "../../stats/facts";
import type { MatchBundle } from "../../worker/protocol";
import type { LeetifyData } from "./leetify/api";
import type { MatchEntry } from "./match";
import type { Data } from "./provider";

// ---------------------------------------------------------------- the setting

const KEY = "cs2stats.hidePersonal";

/** The capture switch: VITE_PRIVACY is "1", or the page's query has privacy=1. */
export const privacySwitch = (env: unknown, search: string) => env === "1" || new URLSearchParams(search).get("privacy") === "1";

const FORCED = privacySwitch(import.meta.env.VITE_PRIVACY, typeof location === "undefined" ? "" : location.search);
/** The saved choice; off when storage is missing or blocked (reading a blocked localStorage throws). */
function readSaved(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
let saved = readSaved();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** The capture switch is on, so the setting is on whatever was saved. */
export const privacyForced = () => FORCED;
/** Personal info is hidden: forced by the switch, or saved in Data & settings. */
export const hidingPersonal = () => FORCED || saved;
/** The setting, off until the user turns it on; on for the session after a choice that could not be saved. */
export const savedHidePersonal = () => saved;

/**
 * Saves the choice, then applies it. When storage refuses the write (blocked or full), the setting
 * is on for this session whichever way the user turned it, since hiding is the safe way to be wrong,
 * and the returned sentence says so for a toast; null when the choice was saved.
 */
export function setHidePersonal(on: boolean): string | null {
  let problem: string | null = null;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    problem = on
      ? "Hide personal info is on until you close the app; the setting could not be saved."
      : "Hide personal info stays on: the setting could not be saved.";
  }
  saved = problem ? true : on;
  for (const fn of listeners) fn();
  return problem;
}

/** Calls `fn` whenever the setting changes; returns the unsubscribe. */
export const onHidePersonalChange = subscribe;

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

/**
 * A pro demo, whose players keep their names: the match's own source tag is "hltv", the tag the
 * extractor gives demos downloaded from HLTV (extractor/extract.py --source) and the pre-v1 table
 * loader gives the same demos (stats/load.ts). Where a file sits says nothing about who played in it:
 * a scrim in the development folder is labelled "Pro demo" by sources.ts, and its humans are hidden.
 */
export const isProDemo = (e: Pick<MatchEntry, "match">) => e.match.source === "hltv";

const seatOf = (e: MatchEntry): Seat => ({ you: e.you, usTeam: e.usTeam, pro: isProDemo(e) });

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
  // steamcommunity.com/profiles/<id> and /id/<vanity name>, and the s.team/p/<code> short links
  [/(?:\bhttps?:\/\/)?(?:\bwww\.)?\b(?:steamcommunity\.com\/(?:profiles|id)|s\.team\/p)\/[^\s'"<>)]+/gi, "<Steam profile>"],
  // file:///C:/Users/... and file:///home/...: the whole URL, spaces in folder names included
  [new RegExp(String.raw`\bfile:\/\/(?:[^\\/\r\n<>|"'?*]*[\\/])*${NAME_END}`, "gi"), PATH_HIDDEN],
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

// ---------------------------------------------------------------- file names

export const FILE_HIDDEN = "<file>";
const FILE_EXT = /(?:\.json\.gz|\.dem\.bz2|\.dem|\.parquet|\.json|\.gz)$/i;

/**
 * A match file's path with its name hidden and its top folder and extension kept:
 * "imported/<file>.json.gz", "valve/<file>". A bare name keeps only its extension. The user names
 * imported and picked files and can rename anything in the match folder, so every name is hidden
 * but the bundled samples'.
 */
export function hideFile(file: string): string {
  if (file.startsWith("samples/")) return file;
  const slash = file.indexOf("/");
  const top = slash > 0 ? file.slice(0, slash + 1) : "";
  return `${top}${FILE_HIDDEN}${FILE_EXT.exec(file)?.[0] ?? ""}`;
}

/**
 * Text with each of these match files hidden (hideFile) wherever it appears, as its path or as its
 * bare name with an extension ("x.json.gz: already imported"), then hideText's rules applied.
 */
export function hideTextAndFiles(s: string, files: Iterable<string>): string {
  const swaps = new Map<string, string>();
  for (const f of files) {
    if (f.startsWith("samples/")) continue;
    swaps.set(f, hideFile(f));
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (FILE_EXT.test(base)) swaps.set(base, hideFile(base));
  }
  let out = s;
  for (const [from, to] of [...swaps].sort((a, b) => b[0].length - a[0].length)) out = out.split(from).join(to);
  return hideText(out);
}

const hideOrNull = (s: string | null, files: Iterable<string>) => (s === null ? null : hideTextAndFiles(s, files));

/** What the views read from the provider, with personal info hidden; the host is passed as it is (see the top of this file). */
export function hideData(d: Data): Data {
  const files = [...d.matches.map((m) => m.file), ...d.fileErrors.map((e) => e.file)];
  return {
    ...d,
    matches: d.matches.map(hideEntry),
    error: hideOrNull(d.error, files),
    fileErrors: d.fileErrors.map((e) => ({ file: hideFile(e.file), message: hideTextAndFiles(e.message, [e.file]) })),
    baselines: d.baselines && { ...d.baselines, source: hideText(d.baselines.source), localError: hideOrNull(d.baselines.localError, []) },
    baselinesError: hideOrNull(d.baselinesError, []),
  };
}

// ---------------------------------------------------------------- Leetify

export const LEETIFY_ID_HIDDEN = "<Leetify id>";

/** The name a connected Leetify player who is not the user reads as. */
export const LEETIFY_PLAYER = "Leetify player";

/**
 * The imported Leetify data as the views may show it: the player reads "You" (or "Leetify player" when
 * `self` is false: anyone's public profile can be connected), and their SteamID and Leetify id become
 * placeholders, in the profile and in every match row. The profile's link keeps the SteamID (see the top
 * of this file). Numbers are untouched.
 */
export function hideLeetifyData(d: LeetifyData, self: boolean): LeetifyData {
  const name = self ? YOU : LEETIFY_PLAYER;
  return {
    ...d,
    profile: { ...d.profile, name, steam64: STEAMID_HIDDEN, id: d.profile.id === null ? null : LEETIFY_ID_HIDDEN },
    matches: d.matches.map((m) => ({ ...m, me: { ...m.me, name, steam64: STEAMID_HIDDEN } })),
  };
}

/** The connected player as a placeholder, and the key store's error through hideText. */
export function hideLeetifyStatus(s: LeetifyStatus): LeetifyStatus {
  return {
    ...s,
    player: s.player && { ...s.player, id: s.player.kind === "steam" ? STEAMID_HIDDEN : LEETIFY_ID_HIDDEN },
    keyError: s.keyError === null ? null : hideText(s.keyError),
  };
}
