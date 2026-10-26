// What the Bot Mode view reads from the backend (src/botmode/commands.ts), and the few judgements
// it makes from that data: which release is newest, whether the installed one is behind, what blocks
// a write, and the knives' names and icons. Everything else on the page is the backend's own words.
import { botmode, type BotModeApi, type Catalog, type Component, type GithubRelease, type Status } from "../../botmode/commands";
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
