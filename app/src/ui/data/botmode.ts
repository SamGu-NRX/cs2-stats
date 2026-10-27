// What the Bot Mode view reads from the backend (src/botmode/commands.ts), and the few judgements
// it makes from that data: which release is newest, whether the installed one is behind, what blocks
// a write, and the knives' names and icons. Everything else on the page is the backend's own words.
import { botmode, type BotModeApi, type Catalog, type Component, type GithubRelease, type RunningCs2, type Status } from "../../botmode/commands";
import { isTauri } from "../../host/host";

let override: BotModeApi | null | undefined;

/**
 * Stands a backend in for the Tauri commands: the view tests and `vite dev ?botmode=` (main.tsx)
 * pass mock.ts's, the privacy test one with sentinel paths. undefined goes back to the default.
 */
export function setBotModeApi(api: BotModeApi | null | undefined) {
  override = api;
}

/** The Bot Mode commands, or null in a browser, where there is no game folder to reach. */
export function botModeApi(): BotModeApi | null {
  if (override !== undefined) return override;
  return isTauri() ? botmode : null;
}

/** A command's rejection as text: Tauri rejects with the Rust error string. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e) ?? String(e);
}

/** The newest published, non-draft, non-prerelease release; null when there is none. */
export function latestRelease(releases: GithubRelease[]): GithubRelease | null {
  const out = releases.filter((r) => !r.draft && !r.prerelease && r.published_at);
  out.sort((a, b) => b.published_at!.localeCompare(a.published_at!));
  return out[0] ?? null;
}

/**
 * Where the install stands against the releases:
 * - missing: Metamod or CounterStrikeSharp is not in the game folder, so Bot Mode cannot start;
 * - unknown: present, but not installed by this app and matching no downloaded release;
 * - byHand: present, not installed by this app, matching a downloaded release (`reference`);
 * - current / behind: installed by this app; behind when a newer release is out.
 * `latest` is null until the releases load, or when they could not.
 */
export type InstallState =
  | { kind: "missing"; latest: GithubRelease | null }
  | { kind: "unknown"; latest: GithubRelease | null }
  | { kind: "byHand"; reference: string; latest: GithubRelease | null }
  | { kind: "current"; tag: string; latest: GithubRelease | null }
  | { kind: "behind"; tag: string; latest: GithubRelease };

/** Without these two, launch refuses: an unmodded game would start (launch.rs REQUIRED). */
const LOADERS = ["Metamod:Source", "CounterStrikeSharp"];
export const modPresent = (s: Status) => LOADERS.every((n) => s.components.some((c) => c.name === n && c.state !== "missing"));

export function installState(s: Status, releases: GithubRelease[] | null): InstallState {
  const latest = releases ? latestRelease(releases) : null;
  if (!modPresent(s)) return { kind: "missing", latest };
  const tag = s.release.installed?.tag;
  if (!tag) return s.release.reference ? { kind: "byHand", reference: s.release.reference, latest } : { kind: "unknown", latest };
  if (latest && latest.tag_name !== tag) {
    // behind only when the installed tag is an older release; a tag GitHub does not list is not judged
    const mine = releases!.find((r) => r.tag_name === tag);
    if (mine?.published_at && mine.published_at < latest.published_at!) return { kind: "behind", tag, latest };
  }
  return { kind: "current", tag, latest };
}

/**
 * Why a change to the game folder would be refused right now, as the backend would refuse it; null
 * when nothing stands in the way. Launch has the same blockers.
 */
export function writeBlocker(s: Status, supervised: boolean): string | null {
  if (s.unfinished) return "A change was interrupted. Roll it back first.";
  if (supervised || s.supervised) return "A Bot Mode session is running. Changes wait until CS2 exits.";
  if (s.cs2Running) return "CS2 is running. Close it to change game files.";
  if (s.cs2Running === null) return "The app could not check whether CS2 is running, so it changes nothing.";
  return null;
}

/** Components whose files are not all the release's or the user's own builds. */
export const damaged = (s: Status): Component[] => s.components.filter((c) => c.state === "modified" || c.state === "missing");

/** The user's BotRandomizer build reads the three cosmetic convars; the official build does not. */
export function cosmeticsSupport(s: Status): "yours" | "official" | "missing" | "unknown" {
  const c = s.components.find((x) => x.name === "BotRandomizer");
  if (!c || c.state === "missing") return "missing";
  if (c.state === "overlay") return "yours";
  if (c.state === "official") return "official";
  return "unknown";
}

/**
 * The knives a dropped knife can be, by item definition index: the icon pack's id (the game's
 * weapon_knife_* names) and the name the game shows.
 */
export const KNIVES: Record<number, { icon: string; name: string }> = {
  500: { icon: "bayonet", name: "Bayonet" },
  503: { icon: "knife_css", name: "Classic Knife" },
  505: { icon: "knife_flip", name: "Flip Knife" },
  506: { icon: "knife_gut", name: "Gut Knife" },
  507: { icon: "knife_karambit", name: "Karambit" },
  508: { icon: "knife_m9_bayonet", name: "M9 Bayonet" },
  509: { icon: "knife_tactical", name: "Huntsman Knife" },
  512: { icon: "knife_falchion", name: "Falchion Knife" },
  514: { icon: "knife_survival_bowie", name: "Bowie Knife" },
  515: { icon: "knife_butterfly", name: "Butterfly Knife" },
  516: { icon: "knife_push", name: "Shadow Daggers" },
  517: { icon: "knife_cord", name: "Paracord Knife" },
  518: { icon: "knife_canis", name: "Survival Knife" },
  519: { icon: "knife_ursus", name: "Ursus Knife" },
  520: { icon: "knife_gypsy_jackknife", name: "Navaja Knife" },
  521: { icon: "knife_outdoor", name: "Nomad Knife" },
  522: { icon: "knife_stiletto", name: "Stiletto Knife" },
  523: { icon: "knife_widowmaker", name: "Talon Knife" },
  525: { icon: "knife_skeleton", name: "Skeleton Knife" },
  526: { icon: "knife_kukri", name: "Kukri Knife" },
};

/** Every knife subclass_create spawns, in the mod's order (settings.rs KNIVES). */
export const KNIFE_IDS = Object.keys(KNIVES).map(Number);
/** The key the mod's own knife bind uses (its my_bot_*_config.cfg). */
export const MOD_KNIFE_KEY = "\\";

/** A key name the backend accepts for the knife bind (settings.rs check_key). */
export const isKeyName = (k: string) => /^(?:[a-zA-Z0-9\\`[\]\-=,./']|[a-z0-9_]{2,16})$/.test(k);

/**
 * The VAC state the page shows, from what the game itself reports: each running CS2's command
 * line (botmode_running), Bot Mode in gameinfo.gi, and Steam's own launch options.
 * - off: a CS2 of this install runs with -insecure (VAC off for that run);
 * - on: CS2 runs without -insecure, or none runs and nothing would start one insecure from Steam;
 * - warn: none runs, but a start from Steam would not be a plain VAC game;
 * - unknown: a running CS2 could not be read.
 */
/**
 * Launch options as the command line reads them (launch.rs split): whitespace separates, double
 * quotes group and are dropped, so `"-insecure"` is the token -insecure. null for an unbalanced quote.
 */
export function splitOptions(options: string): string[] | null {
  const out: string[] = [];
  let cur = "", quoted = false, any = false;
  for (const c of options) {
    if (c === '"') { quoted = !quoted; any = true; }
    else if (/\s/.test(c) && !quoted) { if (any) { out.push(cur); cur = ""; any = false; } }
    else { cur += c; any = true; }
  }
  if (quoted) return null;
  if (any) out.push(cur);
  return out;
}

/** A token that turns VAC back on: -secure, +secure, --secure, -secure=1 (process.rs is_secure_token). */
const isSecureToken = (t: string) => t.replace(/^[-+]+/, "").toLowerCase().split(/[=\s]/)[0] === "secure";

export function vacState(s: Status, running: RunningCs2[] | null, supervised: boolean): { tone: "off" | "on" | "warn" | "unknown"; text: string; detail: string } {
  const UNKNOWN = "VAC state unknown";
  if (running === null) return { tone: "unknown", text: UNKNOWN, detail: "The running CS2 processes could not be read." };
  const off = running.find((r) => r.vac === "off");
  if (off) {
    return supervised
      ? { tone: "off", text: "VAC off for this session", detail: `CS2 (pid ${off.pid}) runs with -insecure, and Bot Mode is ${s.botMode ? "on" : "off"} in gameinfo.gi. VAC is back on once CS2 exits and starts without Bot Mode.` }
      : { tone: "off", text: "VAC off", detail: `CS2 (pid ${off.pid}) runs with -insecure outside a Bot Mode session.` };
  }
  const unknown = running.find((r) => r.vac === "unknown");
  if (unknown && unknown.vac === "unknown") return { tone: "unknown", text: UNKNOWN, detail: `CS2 (pid ${unknown.pid}) could not be checked: ${unknown.why}.` };
  // a running CS2's own command line is direct evidence; without one, the next start from Steam
  // is judged from gameinfo.gi and Steam's options, and either one unread leaves it unknown
  if (running.length) return { tone: "on", text: "VAC on", detail: "CS2 runs without -insecure." };
  if (s.botMode === null) return { tone: "unknown", text: UNKNOWN, detail: "gameinfo.gi could not be read, so whether CS2 started from Steam would load the mod is unknown." };
  if (s.steamLaunchOptions === null) return { tone: "unknown", text: UNKNOWN, detail: "CS2's launch options in Steam could not be read, so whether CS2 started from Steam runs with -insecure is unknown." };
  const tokens = splitOptions(s.steamLaunchOptions);
  if (tokens === null) return { tone: "unknown", text: UNKNOWN, detail: "CS2's launch options in Steam have an unbalanced quote, so how Steam reads them is unknown." };
  const steamInsecure = tokens.some((t) => t.toLowerCase() === "-insecure") && !tokens.some(isSecureToken);
  if (steamInsecure) return { tone: "warn", text: "VAC off on Steam starts", detail: "CS2's launch options in Steam contain -insecure, so CS2 started from Steam runs with VAC off. This app never writes Steam's launch options; remove it in Steam > Counter-Strike 2 > Properties." };
  if (s.botMode) return { tone: "warn", text: "Bot Mode on in gameinfo.gi", detail: "No CS2 runs, and Bot Mode is on with no session of this app's. CS2 started from Steam would load the mod." };
  return { tone: "on", text: "VAC on", detail: "No CS2 runs and Bot Mode is off in gameinfo.gi, so CS2 started from Steam runs with VAC on." };
}

/** The mod's Commands.txt as groups of copyable commands, and its team lineups. */
export interface ModCommands {
  groups: { title: string; commands: string[] }[];
  teams: { name: string; ct: string | null; t: string | null }[];
}

/** Reads Commands.txt's layout: a heading in capitals, then one command a line; under ADD TEAMS, "N. Team" and its CT and T lines. */
export function parseModCommands(text: string): ModCommands {
  const out: ModCommands = { groups: [], teams: [] };
  let group: { title: string; commands: string[] } | null = null;
  let team: ModCommands["teams"][number] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[A-Z][A-Z /&()-]*$/.test(line)) {
      team = null;
      group = line === "ADD TEAMS" ? null : { title: line.charAt(0) + line.slice(1).toLowerCase(), commands: [] };
      if (group) out.groups.push(group);
      continue;
    }
    const t = /^\d+\.\s+(.+)$/.exec(line);
    if (t && !group) { team = { name: t[1], ct: null, t: null }; out.teams.push(team); continue; }
    if (team && !group) {
      if (line.startsWith("bot_add_ct")) team.ct = line;
      else if (line.startsWith("bot_add_t")) team.t = line;
      continue;
    }
    group?.commands.push(line);
  }
  return out;
}

/** A music kit's catalog name ("Music Kit | Noisia, Sharpened") as artist and title. */
export function kitParts(name: string | null, id: number): { artist: string | null; title: string } {
  if (!name) return { artist: null, title: `Kit ${id}` };
  const bare = name.replace(/^Music Kit \| /, "");
  const comma = bare.indexOf(", ");
  return comma > 0 ? { artist: bare.slice(0, comma), title: bare.slice(comma + 2) } : { artist: null, title: bare };
}

/** The music kit choices: off, random each map, then the catalog's kits by title. */
export function kitChoices(c: Catalog | null): { id: number; artist: string | null; title: string }[] {
  const kits = (c?.musicKits ?? []).map((k) => ({ id: k.id, ...kitParts(k.name, k.id) }));
  kits.sort((a, b) => a.title.localeCompare(b.title));
  return [{ id: 0, artist: null, title: "Off" }, { id: -1, artist: null, title: "Random each map" }, ...kits];
}
