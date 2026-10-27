// A scripted stand-in for the Bot Mode commands, answering as commands.rs would from an
// in-memory game folder. The view tests drive it through Tauri's mockIPC, and `vite dev` serves it
// for ?botmode=<scenario> (main.tsx), so the Bot Mode page can be built and screenshotted without
// touching CS2, Steam or the game folder. Builds never include it.
//
// It keeps the backend's refusals that the view relies on: every write is refused while CS2 runs
// or a session holds the game, and a cosmetics write whose `seen` no longer matches is refused as
// a stale read. The releases and catalog entries are copied from the public GitHub release list
// and the BotRandomizer catalog; the game folder, hashes and the session are made up.
import { botmodeOver, UNREACHABLE, type BotModeApi, type Call, type Catalog, type Change, type Component, type Cosmetics, type Difficulty, type GithubRelease, type InstallReport, type KnifeBind, type OverlayPlan, type OverlayReport, type PlannedEntry, type ReleaseIndex, type RollbackReport, type RunningCs2, type ServerPatch, type ServerSettings, type SessionStatus, type SessionView, type SourceLink, type Status } from "./commands";

export const SCENARIOS = ["installed", "outdated", "not-installed", "session", "cs2-running", "unfinished", "no-steam", "unreachable"] as const;
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
  /** the server cfg's other settings; its cosmetics are status.cosmetics */
  server: Omit<ServerSettings, "cosmetics">;
  running: RunningCs2[];
  /** what each recorded change wrote, by id */
  files: Record<string, string[]>;
  /** overlay.json's hash; a test changes it to stand in for an edit after the preview */
  manifestSha: string;
}

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
const KEY = /^(?:[a-z0-9\\`[\]\-=,./']|[a-z0-9_]{2,16})$/;

function initial(s: Scenario): State {
  const installedTag = s === "outdated" ? "v1.4.6" : "v1.4.7";
  const installed = s !== "not-installed";
  const backups = installed ? [change(9, "cosmetics", "2026-10-26T00:31:02Z", 1), change(8, "bot-mode-off", "2026-10-26T00:20:46Z", 1, "complete", "session"), change(6, "overlay", "2026-10-25T22:31:40Z", 18), change(5, `install-${installedTag}`, "2026-10-25T22:30:12Z", 551)] : [];
  const status: Status = {
    csgo: CSGO, steam: String.raw`C:\Program Files (x86)\Steam`, buildId: "20577134",
    cs2Running: s === "session" || s === "cs2-running",
    botMode: s === "session",
    supervised: s === "session",
    notice: "Launch Bot Mode from this app. Starting CS2 from Steam while Bot Mode is on is not protected.",
    release: installed
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
    ? { supervised: true, notice: null, status: { ...lastSession(), runId: "r-1761530000", state: "running", message: "cs2.exe (pid 22916) started with -insecure; watching it until it exits", verdicts: [{ verdict: "safe", pid: 22916, commandLine: `"${CS2_EXE}" -insecure -novid -fullscreen -w 1280 -h 960 +exec botmode` }], outcome: null, botModeOn: change(11, "bot-mode-on", new Date(Date.now() - 25 * 60_000).toISOString().slice(0, 19) + "Z", 1, "complete", "session"), botModeOff: null, heartbeat: Math.floor(Date.now() / 1000) } }
    : { supervised: false, notice: s === "cs2-running" ? "Bot Mode was left on by another tool; it's now off. Launch Bot Mode from this app." : null, status: installed ? lastSession() : null };
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
    server: { botAim: null, botNades: installed ? "more" : null, knifeBind: null },
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
  const serverOf = (): ServerSettings => ({ cosmetics: { droppedKnifeSkins: st.status.cosmetics.droppedKnifeSkins, droppedKnifePremium: st.status.cosmetics.droppedKnifePremium, musicKit: st.status.cosmetics.musicKit }, ...st.server });
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
      case "botmode_set_server_cfg": {
        writable();
        const patch = a.patch as ServerPatch;
        const seen = a.seen as ServerSettings;
        if (JSON.stringify(seen) !== JSON.stringify(serverOf())) throw "cfg/gamemode_competitive_server.cfg: the Bot Mode settings changed since it was read; nothing was written";
        const bind = patch.knifeBind as KnifeBind | undefined;
        if (bind && (!KEY.test(bind.key) || !bind.knives.length)) throw `${JSON.stringify(bind.key)}: not a key name; use one character or a name such as mouse4 or kp_end`;
        if (patch.cosmetics) {
          const kit = patch.cosmetics.musicKit;
          // as the backend: only a kit this change sets is checked against the catalog
          if (kit > 0 && kit !== st.status.cosmetics.musicKit && !CATALOG.musicKits.some((k) => k.id === kit)) throw `music kit ${kit} is not in BotRandomizer's catalog`;
          st.status.cosmetics = { ...patch.cosmetics, cfgPresent: true };
        }
        if (patch.botAim) st.server.botAim = patch.botAim;
        if (patch.botNades) st.server.botNades = patch.botNades;
        if (bind) st.server.knifeBind = bind;
        return record("server-cfg", 1, ["cfg/gamemode_competitive_server.cfg"]);
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
        if (want.musicKit > 0 && !CATALOG.musicKits.some((k) => k.id === want.musicKit)) throw `music kit ${want.musicKit} is not in BotRandomizer's catalog`;
        st.status.cosmetics = { ...want, cfgPresent: true };
        return record("cosmetics", 1, ["cfg/gamemode_competitive_server.cfg"]);
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
        st.session = { supervised: true, notice: null, status: { ...lastSession(), runId: `r-${Date.now()}`, state: "waiting", message: "waiting for CS2 to start", verdicts: [], outcome: null, botModeOff: null, heartbeat: Math.floor(Date.now() / 1000) } };
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
