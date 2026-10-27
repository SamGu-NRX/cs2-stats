// A scripted stand-in for the Bot Mode commands, answering as commands.rs would from an
// in-memory game folder. The view tests drive it through Tauri's mockIPC, and `vite dev` serves it
// for ?botmode=<scenario> (main.tsx), so the Bot Mode page can be built and screenshotted without
// touching CS2, Steam or the game folder. Builds never include it.
//
// It keeps the backend's refusals that the view relies on: every write is refused while CS2 runs
// or a session holds the game, and a cosmetics write whose `seen` no longer matches is refused as
// a stale read. The releases and catalog entries are copied from the public GitHub release list
// and the BotRandomizer catalog; the game folder, hashes and the session are made up.
import { botmodeOver, UNREACHABLE, type BotModeApi, type Call, type Catalog, type Change, type Component, type Cosmetics, type Difficulty, type GithubRelease, type InstallReport, type KnifeBind, type KnifeFileStatus, type OverlayPlan, type OverlayReport, type PlannedEntry, type ReleaseIndex, type RepairPlan, type RollbackReport, type RunningCs2, type Preview, type ServerPatch, type ServerSettings, type SessionStatus, type SessionView, type SourceLink, type Status, type UndoPlan } from "./commands";

export const SCENARIOS = ["installed", "outdated", "not-installed", "session", "cs2-running", "unfinished", "no-steam", "unreachable", "managed", "recovery", "unknown-version", "knife-missing"] as const;

/** session.rs's notices (#50), as the backend sends them. */
export const NOTICES = {
  unprotected: "Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.",
  managed: "Bot Mode is managed by another tool (left as is)",
  recovery: "Bot Mode is on after CS2 Stats closed unexpectedly. If you didn't turn it on with another tool, turn it off. Leave it on to keep another tool's setting, such as the Bot-Improver Panel's.",
  changedSinceAsked: "gameinfo.gi changed after CS2 Stats asked about it, so Bot Mode was not changed. Check Bot Mode again before turning it off.",
} as const;
const BOT_LINES = ["\t\t\tGame\tcsgo/addons", "\t\t\tGame\tcsgo_bots"];
export type Scenario = (typeof SCENARIOS)[number];

const CSGO = String.raw`C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo`;
const CS2_EXE = String.raw`C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe`;
const OFFICIAL = "https://github.com/ed0ard/CS2-Bot-Improver";
// joined at run time, so the repository holds no user folder path (scripts/check-public-tree.mjs)
const OVERLAY_HOME = ["C:", "Users", "Player"].join("\\");

const sha = (seed: string) => Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(seed.charCodeAt(i % seed.length) * (i + 7)) % 16]).join("");

const release = (tag: string, published: string, size: number, digest: string): GithubRelease => ({
  tag_name: tag, html_url: `${OFFICIAL}/releases/tag/${tag}`, draft: false, prerelease: false, published_at: published,
  assets: [{ name: "CS2BotImprover.zip", size, digest: `sha256:${digest}`, browser_download_url: `${OFFICIAL}/releases/download/${tag}/CS2BotImprover.zip` }],
});

/** The newest four releases as GitHub listed them on 2026-10-26. */
export const RELEASES: GithubRelease[] = [
  release("v1.4.7", "2026-10-25T14:21:52Z", 73700851, "effb3c9c76301f74da1582fb167b44fa12b86772c2cacc91848767c27db92e67"),
  release("v1.4.6", "2026-10-11T12:06:38Z", 73126151, "e66a17329ccb00b340555fb64b09b0771ea4a0aa04566e7b9a915d7ad4c6f28e"),
  release("v1.4.5", "2026-10-03T01:47:49Z", 73129728, "ae37b86533abfe0547c5ad4346d478cd846727509fc092842a81240eb0130140"),
  release("v1.4.4", "2026-09-04T09:58:48Z", 68536430, "cba05fdc239bf0e3e95dff7d8670863fe69de9fb03ade8512b6d4f79f88664db"),
];

/** Part of the catalog in the user's BotRandomizer build (its data comes from @ianlucas/cs2-lib 9.8.0). */
export const CATALOG: Catalog = {
  musicKits: [
    [3, "Daniel Sadowski, Crimson Assault"], [4, "Noisia, Sharpened"], [5, "Robert Allaire, Insurgency"], [6, "Sean Murray, A*D*8"],
    [7, "Feed Me, High Noon"], [8, "Dren, Death's Head Demolition"], [9, "Austin Wintory, Desert Fire"], [10, "Sasha, LNOE"],
    [11, "Skog, Metal"], [12, "Midnight Riders, All I Want for Christmas"], [13, "Matt Lange, IsoRhythm"], [14, "Mateo Messina, For No Mankind"],
    [15, "Michael Bross, Invasion!"], [16, "Ian Hultquist, Lion's Mouth"], [17, "New Beat Fund, Sponge Fingerz"], [18, "Beartooth, Disgusting"],
    [19, "Lennie Moore, Java Havana Funkaloo"], [20, "Darude, Moments CS:GO"], [21, "Proxy, Battlepack"], [22, "Kelly Bailey, Hazardous Environments"],
  ].map(([id, name]) => ({ id: id as number, name: `Music Kit | ${name}` })),
  knives: [500, 503, 505, 506, 507, 508, 509, 512, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 525, 526],
  knifeFinishes: [
    ["Autotronic", 4], ["Black Laminate", 4], ["Blue Steel", 3], ["Boreal Forest", 3], ["Bright Water", 3], ["Case Hardened", 4],
    ["Crimson Web", 6], ["Damascus Steel", 3], ["Doppler", 10], ["Fade", 8], ["Forest DDPAT", 3], ["Freehand", 3], ["Gamma Doppler", 8],
    ["Lore", 5], ["Marble Fade", 5], ["Night", 3], ["Night Stripe", 2], ["Rust Coat", 3], ["Safari Mesh", 2], ["Scorched", 3],
    ["Slaughter", 6], ["Stained", 3], ["Tiger Tooth", 4], ["Ultraviolet", 3], ["Urban Masked", 4],
  ].map(([finish, weight]) => ({ finish: finish as string, weight: weight as number })),
};

const link = (repo: string, reference: string, commit: string): SourceLink => ({ repo: `https://github.com/${repo}`, reference, commit, url: `https://github.com/${repo}/tree/${commit}` });
const FORKS: Record<string, [string, string, string, string]> = {
  BotRandomizer: ["SamGu-NRX/CS2-Bot-Randomizer", "feat/combined-1.4.7", "d9bd28e4c1a07f5b3e2d9a6c8f0b1e7a4d3c2b19", "addons/counterstrikesharp/plugins/BotRandomizer"],
  BotState: ["SamGu-NRX/CS2-Smarter-Bot", "fix/postplant-hold-and-carrier", "7c2e91a0b5d4f3e6a8c1b9d0e2f4a6c8b0d1e3f5", "addons/counterstrikesharp/plugins/BotState"],
  BotBuy: ["SamGu-NRX/CS2-Bot-Buy", "feat/chatwheel-economy-calls", "3f6a8c1e9b2d4f7a0c5e8b1d3f6a9c2e4b7d0f13", "addons/counterstrikesharp/plugins/BotBuy"],
  BotMatchStats: ["SamGu-NRX/cs2-stats", "main", "35d9c78c8b1e71d8bab256288f917e561ad3b38d", "addons/counterstrikesharp/plugins/BotMatchStats"],
};

const comp = (name: string, state: Component["state"], n: number, extra: Partial<Component> = {}): Component => ({
  name, state, sha256: state === "missing" ? null : sha(name), files: Object.fromEntries(Array.from({ length: state === "missing" ? 0 : n }, (_, i) => [`${name}/${i}`, sha(name + i)])),
  differs: [], missing: [], overlay: null, ...extra,
});

function components(withForks: boolean): Component[] {
  const fork = (name: string, n: number) => withForks
    ? comp(name, "overlay", n, { overlay: link(FORKS[name][0], FORKS[name][1], FORKS[name][2]) })
    : comp(name, name === "BotMatchStats" ? "missing" : "official", n);
  return [
    comp("Metamod:Source", "official", 41), comp("CounterStrikeSharp", "official", 287), comp("BotController", "official", 9), comp("BotHider", "official", 6),
    comp("BotVision", "official", 8), fork("BotRandomizer", 14), fork("BotState", 5), fork("BotBuy", 6), fork("BotMatchStats", 3),
    comp("Mod cfgs", "modified", 18, { differs: ["cfg/my_bot_normal_config.cfg", "cfg/gamemode_competitive.cfg"] }),
    comp("Bot profiles", "official", 4), comp("Mode backups (backup/)", "official", 2),
  ];
}

const change = (seq: number, operation: string, created: string, files: number, status: Change["status"] = "complete", kind: Change["kind"] = "normal"): Change => ({
  seq, id: `${String(seq).padStart(4, "0")}-${created.replace(/[-:]/g, "").slice(0, 15)}Z-${operation}`, operation, created, status, files, error: null, warnings: [], kind,
});

const lastSession = (): SessionStatus => ({
  runId: "r-1761518412", mode: "launch", state: "done", message: `cs2.exe (pid 18244) started with -insecure. CS2 has exited.`,
  verdicts: [{ verdict: "safe", pid: 18244, commandLine: `"${CS2_EXE}" -insecure -novid -fullscreen -w 1280 -h 960` }],
  errors: [], heartbeat: 1761522046,
  outcome: { outcome: "exited", checked: [{ verdict: "safe", pid: 18244, commandLine: `"${CS2_EXE}" -insecure -novid -fullscreen -w 1280 -h 960` }] },
  botModeOn: change(7, "bot-mode-on", "2026-10-25T22:40:15Z", 1, "complete", "session"), botModeOff: change(8, "bot-mode-off", "2026-10-26T00:20:46Z", 1, "complete", "session"), leftOn: null,
});

interface State {
  status: Status;
  session: SessionView;
  statusError: string | null;
  /** the server cfg's presets; its cosmetics are status.cosmetics */
  server: { botAim: ServerSettings["botAim"]; botNades: ServerSettings["botNades"] };
  /** the knife file's lines after its header (settings.rs KNIFE_CFG); null when there is none */
  knifeFile: string[] | null;
  /** the knife file is there but can't be read */
  knifeUnreadable: boolean;
  /** whether the server cfg runs the knife file */
  exec: boolean;
  /** whether the app's exec line is the server cfg's last command; the commands after the knife file that win over it, and those that may */
  execLast: boolean;
  overrides: string[];
  uncertain: string[];
  running: RunningCs2[];
  /** what each recorded change wrote, by id */
  files: Record<string, string[]>;
  /** overlay.json's hash; a test changes it to stand in for an edit after the preview */
  manifestSha: string;
  /** what each settings change wrote, by change id (settings.rs SettingsRecord) */
  records: Record<string, SettingsRecord>;
}

/** What the knife file leaves the keys as (settings.rs Knife). */
export interface Knife { bind: KnifeBind | null; unbound: string[]; extra?: KnifeBind[]; held?: string[] }
interface SettingsRecord {
  scalars: { name: string; before: string | null; after: string }[];
  knife?: { before: Knife; after: Knife; afterSha256: string; afterText: string };
}

export const KNIFE_CFG = "cfg/cs2stats_knife.cfg";
const KNIFE_EXEC_LINE = "exec cs2stats_knife // cs2-stats knife drop";
const KNIFE_HEADER = [
  "// Bot Mode's knife key, managed by CS2 Stats. The server cfg runs this file on every map",
  "// (exec cs2stats_knife). CS2 Stats rewrites it whole when you change the knife key, keeping",
  "// any line of yours it does not write.",
];
const bindLine = (b: KnifeBind) => `bind ${b.key} "${b.knives.map((k) => `subclass_create ${k}`).join(";")}"`;
const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/**
 * A line without its comment. As cfg.rs `commands` reads it, `//` outside quotes starts one
 * anywhere on the line, so a whole-line comment such as `// mine` leaves nothing.
 */
const codeOf = (l: string) => {
  let quoted = false;
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '"') quoted = !quoted;
    else if (!quoted && l[i] === "/" && l[i + 1] === "/") return l.slice(0, i);
  }
  return l;
};
/** A line's words, quotes dropped and a comment cut; the mock reads one command per line. */
const wordsOf = (l: string) => codeOf(l).trim().match(/"[^"]*"|\S+/g)?.map((w) => w.replace(/^"|"$/g, "")) ?? [];
/** Whether a line holds one command (no `;` outside quotes). */
const single = (l: string) => !codeOf(l).replace(/"[^"]*"/g, "").includes(";");
type KeyState = "u" | "o" | KnifeBind;
/**
 * settings.rs Knife::read: command by command in file order, the last bind or unbind of each key
 * winning and unbindall clearing every key (the mod's \ included); keys compared in any case.
 */
export function readKnife(lines: string[]): Knife {
  // each key's final state, the index of the command that set it, and of its last bind
  const keys: { key: string; st: KeyState; at: number; bound: number | null }[] = [];
  let unbindall: number | null = null;
  const set = (key: string, st: KeyState, at: number, bind: boolean) => {
    const e = keys.find((x) => sameKey(x.key, key));
    if (e) { e.st = st; e.at = at; if (bind) e.bound = at; } else keys.push({ key, st, at, bound: bind ? at : null });
  };
  lines.forEach((l, i) => {
    const w = wordsOf(l);
    const c = w[0]?.toLowerCase();
    if (c === "unbindall" && w.length === 1) {
      for (const e of keys) { e.st = "u"; e.at = i; }
      if (!keys.some((e) => e.key === "\\")) keys.push({ key: "\\", st: "u", at: i, bound: null });
      unbindall = i;
    } else if (c === "unbind" && w.length === 2) set(w[1], "u", i, false);
    else if (c === "bind" && w.length >= 3) {
      const knives = w.length === 3 ? w[2].split(";").map((x) => /^\s*subclass_create (\d+)\s*$/.exec(x)) : [null];
      set(w[1], knives.every(Boolean) ? { key: w[1], knives: knives.map((m) => Number(m![1])) } : "o", i, true);
    }
  });
  const knifeKeys = keys.filter((e) => typeof e.st === "object").sort((a, b) => a.at - b.at).map((e) => e.st as KnifeBind);
  const unbound = keys.filter((e) => e.st === "u");
  const u = unbindall as number | null;
  return {
    bind: knifeKeys.pop() ?? null,
    unbound: unbound.map((e) => e.key),
    extra: knifeKeys,
    held: u === null ? [] : unbound.filter((e) => e.bound === null || e.bound < u).map((e) => e.key),
  };
}
const stateOf = (k: Knife, key: string) => (k.bind && sameKey(k.bind.key, key) ? JSON.stringify(k.bind) : k.unbound.some((u) => sameKey(u, key)) ? "u" : null);
/**
 * settings.rs Knife::rewrite: only the keys the change moves are touched. Their one-command bind or
 * unbind lines come out; every other line stays where it is; the app's lines for them go at the end.
 */
function rewriteKnife(old: string[], now: Knife, next: Knife) {
  const keys = [...now.unbound, ...next.unbound, ...(now.bind ? [now.bind.key] : []), ...(next.bind ? [next.bind.key] : [])];
  const moved = keys.filter((k) => stateOf(now, k) !== stateOf(next, k));
  const hit = (k: string) => moved.some((m) => sameKey(m, k));
  const kept: string[] = [];
  const removed: string[] = [];
  for (const l of old) {
    const w = wordsOf(l);
    (single(l) && /^(un)?bind$/i.test(w[0] ?? "") && w[1] && hit(w[1]) ? removed : kept).push(l);
  }
  return { lines: [...kept, ...next.unbound.filter(hit).map((u) => `unbind ${u}`), ...(next.bind && hit(next.bind.key) ? [bindLine(next.bind)] : [])], removed };
}
/** The knife file's text: the header, then its lines. */
const knifeText = (lines: string[]) => [...KNIFE_HEADER, ...lines].map((l) => `${l}\r\n`).join("");
/** settings.rs Knife::unreadable_command: an exec or an alias in the knife file. */
/** settings.rs readable_command: only bind <key> <command>, unbind <key> and unbindall; comments and blank lines aside. */
const unsupported = (lines: string[]) => {
  const ok = (w: string[]) => (w.length === 1 && /^unbindall$/i.test(w[0])) || (w.length === 2 && /^unbind$/i.test(w[0])) || (w.length === 3 && /^bind$/i.test(w[0]));
  const i = lines.findIndex((l) => { const w = wordsOf(l); return w.length > 0 && !ok(w); });
  return i < 0 ? null : `${KNIFE_CFG}:${i + KNIFE_HEADER.length + 1}: ${lines[i].trim()}`;
};
const unbindallLine = (lines: string[]) => {
  const i = lines.map((l) => /^unbindall$/i.test(wordsOf(l).join(" "))).lastIndexOf(true);
  return i < 0 ? null : `${KNIFE_CFG}:${i + KNIFE_HEADER.length + 1}: ${lines[i].trim()}`;
};
const UNREADABLE_SHA = "9f2c6c1d0e4b8a7f3e5d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f";
/** A stand-in SHA-256 of a text: FNV-1a with eight seeds, so any edit changes it. */
const hashText = (t: string) => Array.from({ length: 8 }, (_, seed) => {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}).join("");
const keyOf = (k: Knife) => k.bind?.key ?? "\\";
const withKey = (keys: string[], key: string) => (keys.some((k) => sameKey(k, key)) ? keys : [...keys, key]);
/** settings.rs SCALARS: each convar a change can touch, with the value the game uses without a line. */
const SCALAR_DEFAULTS: Record<string, string> = { br_dropped_knife_skins: "0", br_dropped_knife_premium: "0", br_player_music_kit: "0", bot_aim: "mixed", bot_nades: "normal" };

/** A few entries of the mod's Commands.txt, in its layout (the real list has 40 teams). */
export const COMMANDS_TXT = [
  "GAME MODE", "scouts_on", "scouts_off", "", "BOT AIM STYLE", "", "bot_aim head", "bot_aim body", "bot_aim mixed", "",
  "BOT MANAGEMENT", "", "bot_kick", "bot_add_t", "mp_restartgame 1", "", "ADD TEAMS", "", "1. Falcons", "",
  'bot_add_ct "NiKo";bot_add_ct "TeSeS";bot_add_ct "m0NESY";bot_add_ct "karrigan";bot_add_ct "kyousuke";mp_teamlogo_1 fal;mp_teamname_1 Falcons', "",
  'bot_add_t "NiKo";bot_add_t "TeSeS";bot_add_t "m0NESY";bot_add_t "karrigan";bot_add_t "kyousuke";mp_teamlogo_2 fal;mp_teamname_2 Falcons', "",
  "2. Team Vitality", "",
  'bot_add_ct "apEX";bot_add_ct "ZywOo";bot_add_ct "ropz";bot_add_ct "mezii";bot_add_ct "flameZ";mp_teamlogo_1 vita;mp_teamname_1 Team Vitality', "",
  'bot_add_t "apEX";bot_add_t "ZywOo";bot_add_t "ropz";bot_add_t "mezii";bot_add_t "flameZ";mp_teamlogo_2 vita;mp_teamname_2 Team Vitality', "",
  "COORDINATED BUY", "", "ak47", "awp", "bot_buy",
].join("\r\n");

/** The key names the backend accepts (settings.rs check_key). */
const KEY = /^(?:[a-zA-Z0-9\\`[\]\-=,./']|[a-z0-9_]{2,16})$/;

function knifeMissingRecord(): SettingsRecord {
  const after: Knife = { bind: { key: "k", knives: [500, 507, 515] }, unbound: ["\\"] };
  const text = knifeText(rewriteKnife([], { bind: null, unbound: [] }, after).lines);
  return { scalars: [], knife: { before: { bind: null, unbound: [] }, after, afterSha256: hashText(text), afterText: text } };
}

function initial(s: Scenario): State {
  const installedTag = s === "outdated" ? "v1.4.6" : "v1.4.7";
  const installed = s !== "not-installed";
  const backups = installed ? [change(9, "cosmetics", "2026-10-26T00:31:02Z", 1), change(8, "bot-mode-off", "2026-10-26T00:20:46Z", 1, "complete", "session"), ...(s === "knife-missing" ? [change(7, "server-cfg", "2026-10-26T00:02:17Z", 2)] : []), change(6, "overlay", "2026-10-25T22:31:40Z", 18), change(5, `install-${installedTag}`, "2026-10-25T22:30:12Z", 551)] : [];
  const status: Status = {
    csgo: CSGO, steam: String.raw`C:\Program Files (x86)\Steam`, buildId: "20577134",
    cs2Running: s === "session" || s === "cs2-running",
    // managed: another tool (the Panel) keeps Bot Mode on; recovery: a session of ours died with it on
    botMode: s === "session" || s === "managed" || s === "recovery",
    supervised: s === "session",
    notice: s === "managed" ? NOTICES.managed : s === "recovery" ? NOTICES.recovery : NOTICES.unprotected,
    // unknown-version: the mod's files are there, but match no release this app downloaded
    release: s === "unknown-version" ? { installed: null, reference: null, matching: 0, total: 0 }
      : installed
      ? { installed: { tag: installedTag, asset: "CS2BotImprover.zip", installedAt: "2026-10-25T22:30:12Z", source: link("ed0ard/CS2-Bot-Improver", installedTag, "a1f4c2e9d7b3058e6c1a9f2d4b7e0c3a5f8d1b6e") }, reference: installedTag, matching: 551, total: 562 }
      : { installed: null, reference: null, matching: 0, total: 0 },
    difficulty: installed ? "medium" : null,
    activeProfile: installed ? sha("profile-medium") : null,
    cosmetics: installed ? { droppedKnifeSkins: true, droppedKnifePremium: false, musicKit: 3, cfgPresent: true } : { droppedKnifeSkins: false, droppedKnifePremium: false, musicKit: 0, cfgPresent: false },
    steamLaunchOptions: "-novid -fullscreen -w 1280 -h 960",
    launchOptions: installed ? "+exec botmode" : "",
    components: installed ? components(true) : [],
    protected: installed ? { "cfg/autoexec.cfg": sha("autoexec"), "cfg/gamemode_competitive_server.cfg": sha("server") } : {},
    overlays: installed ? Object.entries(FORKS).map(([name, [repo, ref, commit, target]]) => ({ name, target, files: { [`${target}/${name}.dll`]: sha(name) }, source: link(repo, ref, commit), appliedAt: "2026-10-25T22:31:40Z" })) : [],
    backups,
    unfinished: s === "unfinished" ? change(10, "install-v1.4.7", "2026-10-26T01:02:11Z", 212, "inProgress") : null,
    warnings: [],
  };
  if (s === "unfinished") {
    status.backups = [status.unfinished!, ...backups];
    status.warnings.push(`Change ${status.unfinished!.id} (install-v1.4.7) was interrupted or only partly undone, so the game folder may be half-written. Run \`botmode rollback\` to put it back.`);
  }
  const session: SessionView = s === "session"
    ? { supervised: true, notice: null, recovery: null, status: { ...lastSession(), runId: "r-1761530000", state: "running", message: "cs2.exe (pid 22916) started with -insecure; watching it until it exits", verdicts: [{ verdict: "safe", pid: 22916, commandLine: `"${CS2_EXE}" -insecure -novid -fullscreen -w 1280 -h 960 +exec botmode` }], outcome: null, botModeOn: change(11, "bot-mode-on", new Date(Date.now() - 25 * 60_000).toISOString().slice(0, 19) + "Z", 1, "complete", "session"), botModeOff: null, heartbeat: Math.floor(Date.now() / 1000) } }
    : {
      supervised: false, notice: s === "managed" ? NOTICES.managed : null, status: installed ? lastSession() : null,
      recovery: s === "recovery" ? { message: NOTICES.recovery, file: `${CSGO}\\gameinfo.gi`, lines: BOT_LINES, hash: sha("gameinfo-on") } : null,
    };
  const files: Record<string, string[]> = {};
  const installFiles = ["addons/metamod.vdf", "addons/counterstrikesharp/bin/win64/counterstrikesharp.dll", "cfg/my_bot_normal_config.cfg"];
  for (const b of status.backups) {
    files[b.id] = b.operation.startsWith("install") ? Array.from({ length: b.files }, (_, i) => installFiles[i] ?? `addons/counterstrikesharp/plugins/BotAI/file${i}.dll`)
      : b.operation === "overlay" ? Object.entries(FORKS).flatMap(([name, [, , , target]]) => ["dll", "deps.json", "pdb"].map((x) => `${target}/${name}.${x}`))
      : b.operation.startsWith("bot-mode") ? ["gameinfo.gi"] : ["cfg/gamemode_competitive_server.cfg"];
  }
  const running: RunningCs2[] = s === "session" ? [{ vac: "off", pid: 22916, commandLine: `"${CS2_EXE}" -insecure -novid -fullscreen -w 1280 -h 960 +exec botmode` }]
    : s === "cs2-running" ? [{ vac: "on", pid: 30112, why: "-insecure is missing" }] : [];
  return {
    status, session, files, running, manifestSha: sha("overlay.json"),
    // the scripted "cosmetics" change set the music kit from off to Crimson Assault; in
    // knife-missing, an earlier change moved the knife key to k and the file has since gone
    records: installed ? {
      [backups[0].id]: { scalars: [{ name: "br_player_music_kit", before: "0", after: "3" }] },
      ...(s === "knife-missing" ? { [backups[2].id]: knifeMissingRecord() } : {}),
    } : {},
    server: { botAim: null, botNades: installed ? "more" : null },
    knifeFile: null,
    knifeUnreadable: false,
    exec: s === "knife-missing",
    execLast: true,
    overrides: [],
    uncertain: [],
    statusError: s === "unreachable" ? `${UNREACHABLE}: reading the CS2 install took longer than 30 s. If CS2 is on a network or removable drive, check that it is connected, then check again.`
      : s === "no-steam" ? String.raw`C:\Program Files (x86)\Steam\steamapps\appmanifest_730.acf: The system cannot find the file specified. (os error 2). Bot Mode finds CS2 through Steam: check that Steam and CS2 are installed, and repair or reinstall CS2 in Steam if its appmanifest_730.acf is damaged` : null,
  };
}

const sameCosmetics = (a: Cosmetics, b: Cosmetics) => a.droppedKnifeSkins === b.droppedKnifeSkins && a.droppedKnifePremium === b.droppedKnifePremium && a.musicKit === b.musicKit;

/** A Call that answers from an in-memory game folder in `scenario`. `delay` (ms) stands in for the real commands' time. */
export function mockCall(scenario: Scenario, delay = 0): Call & { state: State } {
  const st = initial(scenario);
  let seq = 20;
  const now = () => new Date().toISOString().slice(0, 19) + "Z";
  const record = (operation: string, files: number, paths: string[] = []) => {
    const c = change(++seq, operation, now(), files);
    st.status.backups = [c, ...st.status.backups];
    st.files[c.id] = paths;
    return c;
  };
  const knifeStatus = (): KnifeFileStatus => (st.knifeUnreadable ? "unreadable" : st.knifeFile ? (unsupported(st.knifeFile) ? "unsupported" : st.exec ? "ok" : "notRun") : st.exec ? "missing" : "none");
  const knifeSha = () => (st.knifeUnreadable ? UNREADABLE_SHA : st.knifeFile ? hashText(knifeText(st.knifeFile)) : null);
  const knifeNow = (): Knife => (st.knifeFile ? readKnife(st.knifeFile) : { bind: null, unbound: [] });
  /** a stand-in hash of the server cfg: the values and exec placement the mock models */
  const serverSha = () => hashText(JSON.stringify([st.status.cosmetics, st.server, st.exec, st.execLast, st.overrides, st.uncertain]));
  const serverOf = (): ServerSettings => ({
    cosmetics: { droppedKnifeSkins: st.status.cosmetics.droppedKnifeSkins, droppedKnifePremium: st.status.cosmetics.droppedKnifePremium, musicKit: st.status.cosmetics.musicKit },
    ...st.server,
    knifeBind: knifeNow().bind,
    unboundKeys: knifeNow().unbound,
    extraKnifeBinds: knifeNow().extra ?? [],
    heldKeys: knifeNow().held ?? [],
    knifeFile: {
      path: KNIFE_CFG, status: knifeStatus(), sha256: knifeSha(),
      error: st.knifeUnreadable ? `${KNIFE_CFG}: stream did not contain valid UTF-8` : st.knifeFile ? unsupported(st.knifeFile) : null,
      overrides: knifeStatus() === "ok" ? st.overrides : [], uncertain: knifeStatus() === "ok" ? st.uncertain : [], execLast: st.exec && st.execLast,
      runs: st.exec, unbindall: st.knifeFile ? unbindallLine(st.knifeFile) : null,
    },
  });
  // the five convars, as settings.rs scalar_in reads them
  const scalar = (name: string): string | null => {
    const c = st.status.cosmetics;
    switch (name) {
      case "br_dropped_knife_skins": return c.cfgPresent ? String(+c.droppedKnifeSkins) : null;
      case "br_dropped_knife_premium": return c.cfgPresent ? String(+c.droppedKnifePremium) : null;
      case "br_player_music_kit": return c.cfgPresent ? String(c.musicKit) : null;
      case "bot_aim": return st.server.botAim;
      default: return st.server.botNades;
    }
  };
  const setScalar = (name: string, v: string) => {
    const c = st.status.cosmetics;
    if (name === "br_dropped_knife_skins") st.status.cosmetics = { ...c, droppedKnifeSkins: v === "1", cfgPresent: true };
    else if (name === "br_dropped_knife_premium") st.status.cosmetics = { ...c, droppedKnifePremium: v === "1", cfgPresent: true };
    else if (name === "br_player_music_kit") st.status.cosmetics = { ...c, musicKit: Number(v), cfgPresent: true };
    else if (name === "bot_aim") st.server.botAim = v as ServerSettings["botAim"];
    else st.server.botNades = v as ServerSettings["botNades"];
  };
  /** settings.rs plan_settings: what a write does to both files, and its record. */
  const planSettings = (values: [string, string][], knife: Knife | null) => {
    const rec: SettingsRecord = { scalars: [] };
    const serverDiff: Preview["serverDiff"] = [];
    for (const [name, after] of values) {
      const before = scalar(name);
      if ((before ?? SCALAR_DEFAULTS[name]) !== after) rec.scalars.push({ name, before, after });
      if (before !== after) {
        if (before !== null) serverDiff.push({ added: false, line: `${name} ${before}`, ending: "\r\n" });
        serverDiff.push({ added: true, line: `${name} ${after}`, ending: "\r\n" });
      }
    }
    let file = st.knifeFile;
    let knifeRemoved: string[] = [];
    if (knife) {
      const r = rewriteKnife(st.knifeFile ?? [], knifeNow(), knife);
      if (knifeText(r.lines) !== (st.knifeFile && knifeText(st.knifeFile))) {
        file = r.lines;
        knifeRemoved = r.removed;
        const text = knifeText(r.lines);
        rec.knife = { before: knifeNow(), after: structuredClone(knife), afterSha256: hashText(text), afterText: text };
      }
    }
    const execMoves = (st.exec && !st.execLast) || (!!rec.knife && !st.exec);
    if (execMoves) {
      if (st.exec) serverDiff.unshift({ added: false, line: KNIFE_EXEC_LINE, ending: "\r\n" });
      serverDiff.push({ added: true, line: KNIFE_EXEC_LINE, ending: "\r\n" });
    }
    const preview: Preview = { serverDiff, knifeLines: rec.knife ? file : null, knifeRemoved, read: { serverSha256: serverSha(), knifeSha256: knifeSha() } };
    return { rec, file, preview, execMoves };
  };
  /** settings.rs check_read: a write carrying a preview's read is refused once either file changed. */
  const checkRead = (read: unknown) => {
    const r = read as Preview["read"] | undefined;
    if (r && r.serverSha256 !== serverSha()) throw "cfg/gamemode_competitive_server.cfg: changed since it was read (after the preview); nothing was written";
    if (r && r.knifeSha256 !== knifeSha()) throw `${KNIFE_CFG}: changed since it was read (after the preview); nothing was written`;
  };
  /** settings.rs write_settings: sets the values and the knife file as one change, with its record. */
  const writeSettings = (op: string, values: [string, string][], knife: Knife | null) => {
    const { rec, file, execMoves } = planSettings(values, knife);
    const paths = [...(rec.scalars.length || execMoves ? ["cfg/gamemode_competitive_server.cfg"] : []), ...(rec.knife ? [KNIFE_CFG] : [])];
    for (const [name, v] of values) setScalar(name, v);
    if (rec.knife) { st.knifeFile = file; st.exec = true; }
    if (st.exec) { st.execLast = true; st.overrides = []; }
    const c = record(op, paths.length, paths);
    if (rec.scalars.length || rec.knife) st.records[c.id] = rec;
    return c;
  };
  /** settings.rs Knife::after: the key the bind leaves joins the set; only the user takes one out. Refused while the file is unknown. */
  const knifeAfter = (patch: ServerPatch): Knife | null => {
    const bind = patch.knifeBind;
    if (!bind && !patch.stopUnbinding?.length) return null;
    if (knifeStatus() === "missing") throw `${KNIFE_CFG} is missing, so the keys Bot Mode keeps unbound are unknown; repair it first. Nothing was written.`;
    if (knifeStatus() === "unreadable") throw `${KNIFE_CFG}: stream did not contain valid UTF-8; replace it first. Nothing was written.`;
    if (knifeStatus() === "unsupported") throw `${KNIFE_CFG} has commands Bot Mode can't read (${unsupported(st.knifeFile!)}); replace it first. Nothing was written.`;
    const was = knifeNow();
    const held = patch.stopUnbinding?.find((k) => was.held?.some((h) => sameKey(h, k)));
    if (held) throw `${unbindallLine(st.knifeFile!)}: an unbindall line in the knife file unbinds every key, so Stop unbinding can't take ${held} out; replace the file to remove it. Nothing was written.`;
    let unbound = [...was.unbound];
    if (bind && !sameKey(keyOf(was), bind.key)) unbound = withKey(unbound, keyOf(was));
    const next: Knife = { bind: bind ?? was.bind, unbound };
    next.unbound = next.unbound.filter((k) => !patch.stopUnbinding?.some((x) => sameKey(x, k)) && !sameKey(k, keyOf(next)));
    return next;
  };
  const valuesOf = (p: ServerPatch): [string, string][] => [
    ...(p.cosmetics ? [["br_dropped_knife_skins", String(+p.cosmetics.droppedKnifeSkins)], ["br_dropped_knife_premium", String(+p.cosmetics.droppedKnifePremium)], ["br_player_music_kit", String(p.cosmetics.musicKit)]] as [string, string][] : []),
    ...(p.botAim ? [["bot_aim", p.botAim]] as [string, string][] : []),
    ...(p.botNades ? [["bot_nades", p.botNades]] as [string, string][] : []),
  ];
  /** settings.rs prepare_undo */
  const prepareUndo = (id: string) => {
    const c = st.status.backups.find((b) => b.id === id);
    if (!c) throw `${id}: no such change`;
    if (c.status !== "complete") throw `${id} is not in effect, so there is nothing of it to undo`;
    const rec = st.records[id];
    if (!rec) throw `${id} kept no record of the settings it changed, so it can only be rolled back`;
    const changed: string[] = [];
    for (const s of rec.scalars) {
      const now = scalar(s.name);
      if ((now ?? SCALAR_DEFAULTS[s.name]) !== s.after) changed.push(`${s.name} (now ${now ?? `unset, so ${SCALAR_DEFAULTS[s.name]}`})`);
    }
    if (rec.knife && knifeSha() !== rec.knife.afterSha256) changed.push(`${KNIFE_CFG} (${st.knifeFile || st.knifeUnreadable ? "edited since" : "now missing"})`);
    const refused = changed.length ? `${changed.join(", ")} changed since this change, so Undo would overwrite ${changed.length === 1 ? "it" : "them"}. Nothing was written.` : null;
    const values: [string, string][] = rec.scalars.map((s) => [s.name, s.before ?? SCALAR_DEFAULTS[s.name]]);
    let knife: Knife | null = null;
    if (rec.knife) {
      const { before, after } = rec.knife;
      knife = { bind: before.bind ?? { key: "\\", knives: CATALOG.knives }, unbound: withKey(before.unbound, keyOf(after)).filter((k) => !sameKey(k, keyOf(before))) };
    }
    return { values, knife, refused };
  };
  /** settings.rs repair_source */
  const repairPlan = (): RepairPlan => {
    const status = knifeStatus();
    if (status !== "missing" && status !== "unreadable" && status !== "unsupported" && !(st.knifeFile && unbindallLine(st.knifeFile))) throw `${KNIFE_CFG} is neither missing nor unreadable; nothing to repair`;
    const replaces = status === "missing" ? null : knifeSha();
    // settings.rs Knife::canonical: the header, the unbind lines, the other knife binds, then the knife key's
    const canonical = (k: Knife) => [...KNIFE_HEADER, ...k.unbound.map((u) => `unbind ${u}`), ...[...(k.extra ?? []), ...(k.bind ? [k.bind] : [])].map(bindLine)];
    if (status === "ok" || status === "notRun") return { from: null, fromFile: true, lines: canonical(knifeNow()), replaces };
    for (const b of st.status.backups) {
      const k = b.status === "complete" ? st.records[b.id]?.knife : undefined;
      if (k) return { from: b.id, fromFile: false, lines: canonical(k.after), replaces };
    }
    return { from: null, fromFile: false, lines: canonical({ bind: { key: "\\", knives: CATALOG.knives }, unbound: [] }), replaces };
  };
  /** The backend's refusals for anything that writes the game folder. */
  const writable = () => {
    if (st.status.cs2Running) throw "CS2 is running. Close it first: Bot Mode never changes game files while the game is open.";
    if (st.session.supervised) throw "a Bot Mode session is running; wait until CS2 has exited";
    if (st.status.unfinished) throw `change ${st.status.unfinished.id} (${st.status.unfinished.operation}) is unfinished, so the game folder may be half-written; run \`botmode rollback\` first`;
  };
  const answer = (cmd: string, a: Record<string, unknown>): unknown => {
    switch (cmd) {
      case "botmode_status":
        if (st.statusError) throw st.statusError;
        return structuredClone(st.status);
      case "botmode_session": return structuredClone(st.session);
      case "botmode_recover": {
        // as session.rs recover: refused while CS2 runs or a session holds the game
        if (st.status.cs2Running) throw "CS2 is running. Close it first: Bot Mode never changes game files while the game is open.";
        if (st.session.supervised) throw "a Bot Mode session is running; wait until CS2 has exited";
        const prompt = st.session.recovery;
        if (a.action === "leave") {
          st.session = { ...st.session, recovery: null };
          st.status.notice = st.status.botMode ? NOTICES.managed : NOTICES.unprotected;
          return { change: null, message: "Bot Mode was not changed." };
        }
        if (!prompt) throw "No Bot Mode session was left unfinished, so there is nothing to recover. Bot Mode was not changed.";
        if (a.expectHash !== prompt.hash) throw NOTICES.changedSinceAsked;
        st.session = { ...st.session, recovery: null };
        st.status = { ...st.status, botMode: false, notice: NOTICES.unprotected };
        return { change: record("bot-mode-off", 1, ["gameinfo.gi"]), message: "Bot Mode is off." };
      }
      case "botmode_server_cfg": return structuredClone(serverOf());
      case "botmode_running": return structuredClone(st.running);
      case "botmode_overlay_plan": {
        const entries = Object.entries(FORKS).map(([name, [repo, reference, , target]]): PlannedEntry => ({ name, target, repo, reference, files: ["dll", "deps.json", "pdb"].map((x) => `${name}.${x}`) }));
        const plan: OverlayPlan = { sha256: st.manifestSha, entries };
        return plan;
      }
      case "botmode_change_files": {
        const f = st.files[a.id as string];
        if (!f) throw `${a.id as string}: no such change`;
        return f;
      }
      case "botmode_mod_commands": return COMMANDS_TXT;
      case "botmode_server_preview": return planSettings(valuesOf(a.patch as ServerPatch), knifeAfter(a.patch as ServerPatch)).preview;
      case "botmode_set_server_cfg": {
        writable();
        // as set_server_checked: the preview's bytes first, then the values the page read
        checkRead(a.read);
        const patch = a.patch as ServerPatch;
        const seen = a.seen as ServerSettings;
        if (JSON.stringify(seen) !== JSON.stringify(serverOf())) throw "cfg/gamemode_competitive_server.cfg: the Bot Mode settings changed since it was read; nothing was written";
        const bind = patch.knifeBind as KnifeBind | undefined;
        if (bind && (!KEY.test(bind.key) || !bind.knives.length)) throw `${JSON.stringify(bind.key)}: not a key name; use one character or a name such as mouse4 or kp_end`;
        if (patch.cosmetics) {
          const kit = patch.cosmetics.musicKit;
          // as the backend: only a kit this change sets is checked against the catalog
          if (kit > 0 && kit !== st.status.cosmetics.musicKit && !CATALOG.musicKits.some((k) => k.id === kit)) throw `music kit ${kit} is not in BotRandomizer's catalog`;
        }
        return writeSettings("server-cfg", valuesOf(patch), knifeAfter(patch));
      }
      case "botmode_server_undo_plan": {
        const u = prepareUndo(a.id as string);
        const plan: UndoPlan = { change: a.id as string, ...planSettings(u.values, u.knife).preview, refused: u.refused };
        return plan;
      }
      case "botmode_server_undo": {
        writable();
        const u = prepareUndo(a.id as string);
        if (u.refused) throw u.refused;
        checkRead(a.read);
        return writeSettings("server-cfg-undo", u.values, u.knife);
      }
      case "botmode_knife_repair_plan": return repairPlan();
      case "botmode_knife_repair": {
        writable();
        const plan = repairPlan();
        if (JSON.stringify(plan) !== JSON.stringify(a.seen)) throw `${KNIFE_CFG}: what Repair would write changed since it was read; nothing was written`;
        st.knifeFile = plan.lines.slice(KNIFE_HEADER.length);
        st.knifeUnreadable = false;
        return record("knife-repair", 1, [KNIFE_CFG]);
      }
      case "botmode_releases": return RELEASES;
      case "botmode_catalog": return st.status.components.length ? CATALOG : null;
      case "botmode_download": {
        const tag = a.tag as string;
        const r = RELEASES.find((x) => x.tag_name === tag);
        if (!r) throw `${tag}: no such release in ed0ard/CS2-Bot-Improver`;
        const index: ReleaseIndex = {
          tag, asset: "CS2BotImprover.zip", sha256: r.assets[0].digest!.slice(7), source: link("ed0ard/CS2-Bot-Improver", tag, "a1f4c2e9d7b3058e6c1a9f2d4b7e0c3a5f8d1b6e"),
          files: Object.fromEntries(Array.from({ length: 562 }, (_, i) => [`addons/f${i}`, sha(`${tag}${i}`)])),
          skipped: [{ path: "CS2BotImprover.exe", reason: "the Panel; Bot Mode replaces it and does not install it" }, { path: "gameinfo.gi", reason: "not copied; a launched Bot Mode session adds its two search paths to the game's gameinfo.gi and removes them when CS2 exits" }],
          botSearchPaths: ["Game csgo/addons", "Game csgo_bots"],
        };
        // the overlays whose files this release ships: the view says install replaces them
        for (const o of st.status.overlays) for (const f of Object.keys(o.files)) index.files[f] = sha(`${tag}${f}`);
        return index;
      }
      case "botmode_install": {
        writable();
        const tag = a.tag as string;
        const replaced = st.status.overlays.map((o) => o.name);
        const c = record(`install-${tag}`, 548);
        st.status.release = { ...st.status.release, installed: { tag, asset: "CS2BotImprover.zip", installedAt: c.created, source: link("ed0ard/CS2-Bot-Improver", tag, "a1f4c2e9d7b3058e6c1a9f2d4b7e0c3a5f8d1b6e") }, reference: tag, matching: 560, total: 562 };
        st.status.components = components(false);
        st.status.overlays = [];
        st.status.difficulty ??= "medium";
        const r: InstallReport = { change: c, tag, asset: "CS2BotImprover.zip", source: st.status.release.installed!.source, written: 548, unchanged: 14, skipped: [], kept: ["cfg/autoexec.cfg"], merged: ["cfg/gamemode_competitive_server.cfg"], userValuesKept: ["cfg/my_bot_normal_config.cfg"], difficultyKept: st.status.difficulty, overlaysReplaced: replaced };
        return r;
      }
      case "botmode_overlay": {
        writable();
        if (a.previewed && a.previewed !== st.manifestSha) throw `overlay.json: changed since it was read (it was previewed at another version); nothing was written`;
        const c = record("overlay", 18);
        st.status.components = components(true);
        st.status.overlays = initial("installed").status.overlays;
        const r: OverlayReport = { manifest: [OVERLAY_HOME, "AppData", "Roaming", "BotMatchStats", "botmode", "overlay.json"].join("\\"), change: c, entries: st.status.overlays.map((o) => ({ name: o.name, target: o.target, files: 3, written: 3, source: o.source, warnings: [] })) };
        return r;
      }
      case "botmode_rollback": {
        if (st.status.cs2Running) throw "CS2 is running. Close it first: Bot Mode never changes game files while the game is open.";
        const target = st.status.unfinished ?? st.status.backups.find((b) => b.status === "complete" && b.kind === "normal");
        if (!target) throw "nothing to roll back";
        if (a.id && a.id !== target.id) throw `${a.id as string} is not the newest change; roll back ${target.id} first`;
        st.status.unfinished = null;
        st.status.warnings = [];
        st.status.backups = st.status.backups.map((b) => (b.id === target.id ? { ...b, status: "rolledBack" } : b));
        const r: RollbackReport = { id: target.id, operation: target.operation, restored: target.files, removed: 0, unchanged: 0, warnings: [] };
        return r;
      }
      case "botmode_set_difficulty": {
        writable();
        const seenProfile = a.seen as { sha256: string | null } | undefined;
        if (seenProfile && seenProfile.sha256 !== st.status.activeProfile) throw "overrides/botprofile.vpk: changed since it was read; nothing was written";
        st.status.activeProfile = sha(`profile-${a.level as string}`);
        st.status.difficulty = a.level as Difficulty;
        return record(`difficulty-${a.level as string}`, 1, ["overrides/botprofile.vpk"]);
      }
      case "botmode_set_cosmetics": {
        writable();
        const want = a.cosmetics as Cosmetics;
        const seen = a.seen as Cosmetics | undefined;
        const now = st.status.cosmetics;
        if (seen && !sameCosmetics(seen, now)) {
          throw `cfg/gamemode_competitive_server.cfg: the Bot Mode cosmetics changed since it was read (now br_dropped_knife_skins ${+now.droppedKnifeSkins}, br_dropped_knife_premium ${+now.droppedKnifePremium}, br_player_music_kit ${now.musicKit}); nothing was written`;
        }
        if (want.musicKit > 0 && want.musicKit !== now.musicKit && !CATALOG.musicKits.some((k) => k.id === want.musicKit)) throw `music kit ${want.musicKit} is not in BotRandomizer's catalog`;
        return writeSettings("cosmetics", valuesOf({ cosmetics: want }), null);
      }
      case "botmode_set_launch_options": {
        const options = a.options as string;
        if (typeof a.seen === "string" && a.seen !== st.status.launchOptions) throw `the app's launch options changed since it was read (now ${JSON.stringify(st.status.launchOptions)}); nothing was written`;
        const bad = options.split(/\s+/).find((t) => /^[-+]{1,2}secure\b/i.test(t.replace(/"/g, "")));
        if (bad) throw `launch options contain ${bad}, which turns VAC on; Bot Mode only starts CS2 with -insecure`;
        if ((options.match(/"/g) ?? []).length % 2) throw `${options}: unbalanced quote`;
        st.status.launchOptions = options;
        return { launchOptions: options };
      }
      case "botmode_launch": {
        writable();
        if (!st.status.components.some((c) => c.name === "CounterStrikeSharp" && c.state !== "missing")) throw "the mod is not installed (addons/metamod.vdf, addons/counterstrikesharp/bin/win64/counterstrikesharp.dll missing); run `botmode install <tag>` first";
        // a stand-in session: nothing is started
        st.status.supervised = true;
        st.status.botMode = true;
        st.session = { supervised: true, notice: null, recovery: null, status: { ...lastSession(), runId: `r-${Date.now()}`, state: "waiting", message: "waiting for CS2 to start", verdicts: [], outcome: null, botModeOff: null, heartbeat: Math.floor(Date.now() / 1000) } };
        return structuredClone(st.session);
      }
      default:
        throw `mock: no command ${cmd}`;
    }
  };
  const call = (<T,>(cmd: string, args: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const run = () => { try { resolve(answer(cmd, args) as T); } catch (e) { reject(e); } };
      if (delay) setTimeout(run, delay); else queueMicrotask(run);
    })) as Call & { state: State };
  call.state = st;
  return call;
}

/** The Bot Mode commands answered by mockCall. */
export const mockBotmode = (scenario: Scenario, delay = 0): BotModeApi => botmodeOver(mockCall(scenario, delay));

export const isScenario = (s: string | null): s is Scenario => (SCENARIOS as readonly string[]).includes(s ?? "");
