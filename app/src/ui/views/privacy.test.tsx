// @vitest-environment jsdom
// "Hide personal info" (data/privacy.ts) over the whole app: the shell (sidebar, title bar, palette
// and overlay layers) with every page, every Profile tab and every match tab, rendered from the
// bundled samples with the user renamed to a sentinel, two bots turned into human strangers, and a
// host whose folders, Valve user and errors carry a sentinel path and SteamID. With the setting on, no
// sentinel may reach the page or the window title. The pages and tabs come from the router's own
// lists, so a page or tab added later is rendered here too, and fails if it reads names, SteamIDs or
// paths around the layer.
//
// The data goes through the real DataValue, useMatch and useCall; only the worker and the host are
// stood in for, answering from the samples as the worker would (as views.test.tsx does). The host's
// Leetify bridge answers with an imported profile and history named after another sentinel and keyed by
// the sentinel SteamID, one match of it joined to the Valve match by its share code, so Data & settings,
// Profile's Leetify card, the match page's Leetify card and Matches' Leetify-only rows are all drawn.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClipsHost, FinishRequest } from "../../clips/host";
import type { JobRequest, RenderPlan } from "../../clips/plan";
import type { Host, ValveFolder } from "../../host/host";
import type { ImportStatus, ImportStore } from "../../host/import-store";
import type { Baselines } from "../../stats/compare";
import { derive } from "../../stats/derive";
import type { MatchFacts } from "../../stats/facts";
import { flashTool } from "../../stats/flashes";
import { headToHead, mapZones, openingDuels, roundRatings } from "../../stats/matchviews";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import type { MatchFile } from "../../stats/plugin/schema";
import { rating3Of } from "../../stats/rating3";
import { rollup } from "../../stats/rollup";
import { WIN_CORRELATION_MIN } from "../../stats/correlation";
import { matchValues, trend } from "../../stats/trends";
import type { MatchTables } from "../../stats/tables";
import type { Client } from "../../worker/client";
import { matchCalls } from "../../worker/matchcalls";
import type { MomentRow, Query } from "../../worker/protocol";
import { addCareerMatch, botPopulation, rankingCalls, sideQuery } from "../../worker/ranking";
import { entryOf, matchBundle, metaOf, ratingsOf, roundBundle, rolled } from "../../worker/views";
import { Shell } from "../App";
import type { MatchEntry } from "../data/match";
import { setMeta } from "../data/meta";
import { hideText, setHidePersonal } from "../data/privacy";
import { dismissToast, toast } from "../components/overlay";
import { DataValue, type Data } from "../data/provider";
import { go, knownMatchFiles, MATCH_TABS, matchHref, matchId, PAGES, pageHref, PROFILE_TABS, profileHref, type Page } from "../router";
import { BarProvider } from "../shell/Bar";
import { rosterTables } from "../../stats/roster";
import type { LeetifyBridge } from "../../host/leetify";
import { encodeShareCode } from "../data/leetify/sharecode";
import { SYNTHETIC_MATCHES, syntheticPayload, syntheticProfile, type SyntheticMatch } from "../data/leetify/synthetic";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");
const PROS = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../public/baselines.json"), "utf8")) as Baselines;

// The sentinels. The path is joined at run time so this file holds no developer path itself
// (scripts/check-public-tree.mjs); the SteamID is allowlisted there as a synthetic one.
const NAME = "SENTINEL_NAME";
const MATE = "SENTINEL_MATE";
const OPPONENT = "SENTINEL_OPPONENT";
const ID = "76561190000000099";
const HOME_DIR = ["C:", "Users", "SENTINEL_USER"].join("\\");
const DATA_FOLDER = `${HOME_DIR}\\AppData\\Roaming\\BotMatchStats\\matches`;
const VALVE_FOLDER = `${HOME_DIR}\\AppData\\Roaming\\BotMatchStats\\valve`;
/** The player's name as Leetify has it, which the Leetify views show. */
const LEETIFY_NAME = "SENTINEL_LEETIFY";
const SENTINELS = [NAME, MATE, OPPONENT, ID, "SENTINEL_USER", LEETIFY_NAME];
/**
 * A file name the user chose, of an imported match and of a file that could not be read. With personal
 * info hidden it may not appear in the page's text, in any attribute (a link's target shows in the
 * status bar on hover), or in the address.
 */
const FILE = "SENTINEL_FILE";
/** A pro demo's players keep their names. */
const PRO_NAME = "KEPT_PRO";

interface Fixture { file: string; facts: MatchFacts; tables: MatchTables; entry: MatchEntry }

/**
 * A sample as one of the user's matches: the user is the sentinel, one bot on each side is a human
 * stranger. `source` is the match's own tag (MatchInfo.source): "valve" for a Valve matchmaking demo,
 * "hltv" for a pro demo, whose players keep their names.
 */
async function fixture(f: string, file: string, source?: "valve" | "hltv"): Promise<Fixture> {
  const pro = source === "hltv";
  const m = await decodeMatch(gunzipSync(readFileSync(path.join(SAMPLES, f))), f);
  const you = m.players.isBot.findIndex((b) => !b);
  const realId = m.players.key[you];
  const json = JSON.stringify(m).replaceAll(`"${realId}"`, `"${ID}"`);
  const s = JSON.parse(json) as MatchFile;
  const side = s.players.startSide[you];
  const mate = s.players.startSide.findIndex((x, i) => i !== you && x === side);
  const opponent = s.players.startSide.findIndex((x) => x !== side);
  s.players.name[you] = pro ? `${PRO_NAME}_0` : NAME;
  for (const [i, name] of [[mate, pro ? `${PRO_NAME}_1` : MATE], [opponent, pro ? `${PRO_NAME}_2` : OPPONENT]] as const) {
    s.players.isBot[i] = false;
    s.players.name[i] = name;
  }
  // the samples predate the plugin's blind-to-flash link; give each blind its attacker's latest flash
  // detonation at most 1 s earlier (the plugin's own rule, SCHEMA.md), so the flash tool lists whom
  // each flash blinded
  s.blinds.flash = s.blinds.tick.map((tick, i) => {
    let best: number | null = null;
    s.grenades.tick.forEach((gt, j) => {
      if (s.grenades.type[j] === "flash" && s.grenades.ri[j] === s.blinds.ri[i] && s.grenades.thrower[j] === s.blinds.attacker[i] && gt <= tick && tick - gt <= 64 && (best === null || gt > s.grenades.tick[best])) best = j;
    });
    return best;
  });
  const tables = pluginToTables(s);
  const facts = derive(tables, CS2RB);
  if (source) facts.match = { ...facts.match, source };
  return { file, facts, tables, entry: entryOf(file, s.env.plugin ?? "", facts) };
}

const names = readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"));
const own = await Promise.all(names.map((f) => fixture(f, `samples/${f}`)));
// a Valve match is an extracted folder, so it has a replay (replay/support.ts) whose sidebar lists the round's kills
// named as the Valve importer names a demo's folder, so the Leetify match with its share code joins it
const VALVE_MATCH_ID = 3900000000000000042n;
const valve = await fixture("20261025T000642Z_de_dust2_9b00e592.json.gz", "valve/match730_003900000000000000042_0000027042_100/v1", "valve");
// a match from the development folder that is not a pro demo: its strangers are hidden like any other's
const devMatch = await fixture("20261024T223834Z_de_dust2_abe5d91c.json.gz", "dev/scrim");
// a match file the user imported and named
const imported = await fixture("20261024T231251Z_de_dust2_8ecfd307.json.gz", `imported/${FILE} vs friends.json.gz`);
const pro = await fixture("synthetic-demo.json.gz", "dev/pro-demo", "hltv");
const all = [...own, valve, devMatch, imported, pro];
const byFile = new Map(all.map((x) => [x.file, x]));
const main = own.find((x) => x.file === "samples/synthetic-demo.json.gz")!;

// ---------------------------------------------------------------- the worker, answered in process

const summary = (q: Query) => rollup(q.files.map((f) => byFile.get(f)!.facts), q.filter);
const ranking = rankingCalls({
  summary: async (q) => summary(q),
  pros: async () => PROS,
  careers: async (q) => {
    const careers = new Map<string, Parameters<typeof botPopulation>[0][number]>();
    const matches: Parameters<typeof botPopulation>[1] = [];
    for (const f of q.files) addCareerMatch(careers, matches, byFile.get(f)!.facts, {});
    return botPopulation([...careers.values()], matches, "test");
  },
});
const perMatch = matchCalls(async (files, visit) => { for (const f of files) visit(byFile.get(f)!.facts, f); }, async (q) => summary(q));
const answers: Partial<Record<keyof Client, (...a: never[]) => unknown>> = {
  ...ranking,
  ...perMatch,
  match: (file: string) => matchBundle(byFile.get(file)!.entry, byFile.get(file)!.facts),
  rounds: (file: string) => byFile.get(file)!.facts.rounds.map((r) => roundBundle(byFile.get(file)!.facts, r.number)),
  rollup: (qs: Query[]) => qs.map((q) => rolled(summary(q))),
  ratings: (qs: Query[]) => qs.map((q) => ratingsOf({ both: summary(sideQuery(q, "both")), T: summary(sideQuery(q, "T")), CT: summary(sideQuery(q, "CT")) })),
  headToHead: (file: string) => headToHead(rosterTables(byFile.get(file)!.tables), byFile.get(file)!.facts),
  mapZones: (file: string, player: string) => mapZones(rosterTables(byFile.get(file)!.tables), player),
  flashes: (file: string, player: string) => flashTool(rosterTables(byFile.get(file)!.tables), byFile.get(file)!.facts, player),
  openingDuels: (file: string, player: string) => openingDuels(byFile.get(file)!.facts, player),
  // Overview's "Moves with winning": each match's value from the engine, the sentinel match among
  // them. The samples hold fewer decided matches than the card's minimum, so the correlation answer
  // claims WIN_CORRELATION_MIN for every stat: the rows, the trend line and its match links render.
  matchValues: (q: Query, id: string) => Object.fromEntries(q.files.map((f) => [f, matchValues(byFile.get(f)!.facts, q.filter, [id])?.[id] ?? null])),
  winCorrelation: (q: Query, ids: string[]) => Object.fromEntries(ids.map((id, i) => [id, { r: 0.6 - 0.15 * i, n: WIN_CORRELATION_MIN, reason: null }])),
  trends: (series: (number | null)[][]) => series.map((values) => trend(values.map((value, i) => ({ match: String(i), date: null, value, won: null })))),
  ratingBreakdown: (file: string, player: string) => {
    const f = byFile.get(file)!.facts;
    const match = rating3Of(rollup([f], { player }));
    return { rows: roundRatings(f, player, match.value), match, average: match.value };
  },
};
// a method without an answer here stays loading, which draws a skeleton
const client = new Proxy({} as Client, {
  get: (_, method: string) => (...args: never[]) => {
    const fn = answers[method as keyof Client];
    return fn ? Promise.resolve().then(() => fn(...args)) : new Promise(() => {});
  },
});

// ---------------------------------------------------------------- the host

/**
 * The desktop app's clips commands, for the test that renders the Render dialog and finishes a clip;
 * null elsewhere, as in a browser. Its folders, demos and command carry the sentinel path.
 */
let clipsStandIn: ClipsHost | null = null;
vi.mock("../../clips/host", async (orig) => ({ ...(await orig<object>()), clipsHost: async () => clipsStandIn }));

const failedImport: ImportStatus = { running: false, at: null, error: null, last: { code: 2, summary: null, error: `valve_import.py: cannot read ${VALVE_FOLDER}\\demo.dem for ${ID}` } };
// an import whose demos failed validation, which names them
const failedDemos: ImportStatus = {
  running: false, at: null, error: null,
  last: { code: 1, error: null, summary: { demos: 2, ok: 1, results: [{ demo: `${FILE} scrim.dem`, ok: false, user_in_match: true }, { demo: "match730_1.dem", ok: true, user_in_match: true }] } },
};
// The imported Leetify data: the user under the Leetify sentinel name and the sentinel SteamID, one match
// joined to the Valve match, the rest Leetify-only; and a key store error that names a sentinel path.
const leetifyMatches: SyntheticMatch[] = [
  { ...SYNTHETIC_MATCHES[0], id: "5e7a1c00-0000-4000-8000-0000000000a1", sourceId: encodeShareCode({ matchId: VALVE_MATCH_ID, reservationId: 1n, tvPort: 27042 }), finished: "2026-10-01T20:00:00.000Z" },
  ...SYNTHETIC_MATCHES.slice(1),
].map((m) => ({ ...m, steam64: ID, name: LEETIFY_NAME }));
const LEETIFY: LeetifyBridge = {
  status: async () => ({ player: { kind: "steam", id: ID }, hasKey: false, keyStore: true, keyError: `could not read ${HOME_DIR}\\AppData\\credential for ${ID}`, cooldownS: null }),
  saveKey: async () => {}, clearKey: async () => {}, disconnect: async () => {}, discard: async () => {}, badge: async () => null,
  connect: async () => ({ kind: "steam", id: ID }),
  load: async () => ({ ...syntheticPayload(Date.now(), leetifyMatches), player: { kind: "steam", id: ID }, profile: syntheticProfile({ name: LEETIFY_NAME, steam64_id: ID }) }),
};

function hostWith(valve: ValveFolder, status = failedDemos): Host {
  const imports: ImportStore = { get: () => status, subscribe: () => () => {}, onFinish: () => () => {}, start: async () => {}, sync: async () => {} };
  return {
    kind: "web", folder: DATA_FOLDER, valve, imports, leetify: LEETIFY,
    list: async () => [],
    read: async (file) => { throw new Error(`${DATA_FOLDER}\\${file} could not be read`); },
    importFiles: async () => ({ imported: [], skipped: [] }),
    readPack: async (name) => { if (name === "pros.json") throw new Error(`${HOME_DIR}\\packs\\pros.json: access denied`); return null; },
  };
}

function dataWith(over: Partial<Data> = {}): Data {
  return {
    status: "ready", error: null, host: hostWith({ folder: VALVE_FOLDER, user: ID, userError: null, skipped: [] }), client, meta: true,
    matches: all.map((x) => x.entry), you: [ID],
    fileErrors: [{ file: "valve/demo/v1", message: `${VALVE_FOLDER}\\demo\\v1\\match.parquet: the recording player (match pov ${ID}) is not among the players` },
      { file: `picked/${FILE}.json.gz`, message: `picked/${FILE}.json.gz: not a match file` }],
    progress: null,
    baselines: { source: PROS.source, built: PROS.built, n: PROS.n, model: PROS.model ?? "", pool: "local", localError: `${HOME_DIR}\\packs\\baselines.local.json is not valid JSON` },
    baselinesError: null, version: 1, lastSync: Date.now(), refresh: () => {},
    ...over,
  };
}

// ---------------------------------------------------------------- rendering

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= class { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } } as unknown as typeof IntersectionObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;
globalThis.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
// jsdom has no canvas; the replay's radar draws nothing, and its names are read from the same map the drawing reads
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
Element.prototype.scrollTo ??= () => {};
globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
Element.prototype.scrollIntoView ??= () => {};
// jsdom has <dialog> without the modal methods (the Clips page's Render dialog)
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
setMeta(metaOf(CS2RB));

// The replay asks its worker for a round's positions; this one never answers, so the replay stays on
// its loading state with its killfeed sidebar drawn.
globalThis.Worker ??= class { onmessage = null; onerror = null; onmessageerror = null; postMessage() {} terminate() {} } as unknown as typeof Worker;

/**
 * Every route, from the router's own list of pages: each page, each Profile tab, each tab of a
 * recorded match and of a Valve match, the Valve match's round drawer and replay on one round, and
 * the other matches' overviews. A page added to PAGES is rendered here without editing this list.
 */
const ROUND = 2;
function routesOf(page: Page): string[] {
  switch (page) {
    case "match":
      return [
        ...MATCH_TABS.flatMap((t) => [matchHref(main.file, t), matchHref(valve.file, t)]),
        matchHref(valve.file, "rounds", { round: ROUND }), matchHref(valve.file, "replay", { round: ROUND }),
        ...all.filter((x) => x !== main && x !== valve).map((x) => matchHref(x.file)),
      ];
    case "profile":
      return PROFILE_TABS.map((t) => profileHref(t));
    default:
      return [pageHref(page)];
  }
}
const ROUTES = PAGES.flatMap(routesOf);

let root: Root;
let el: HTMLDivElement;
beforeAll(() => {
  el = document.body.appendChild(document.createElement("div"));
  root = createRoot(el);
});
afterAll(() => act(() => root.unmount()));
const hidePersonal = (on: boolean) => act(() => setHidePersonal(on));
afterEach(() => hidePersonal(false));

// Every view the app loads lazily, found by its lazy(() => import(...)) anywhere under src/ui and
// loaded once here, so each route draws its own view within a few turns.
const UI = path.resolve(import.meta.dirname, "..");
const lazyViews = readdirSync(UI, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  .flatMap((f) => [...readFileSync(path.join(UI, f), "utf8").matchAll(/lazy\(\(\) => import\("([^"]+)"\)\)/g)]
    .map((m) => `./${path.relative(import.meta.dirname, path.resolve(UI, path.dirname(f), m[1])).split(path.sep).join("/")}`));
await Promise.all(lazyViews.map((m) => import(m)));

/** Lets lazy views load and worker answers arrive: until the page has not changed for a while. */
async function settle() {
  let last = "", still = 0;
  for (let i = 0; i < 400 && still < 8; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const now = document.body.innerHTML;
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

async function show(href: string, data: Data) {
  act(() => go(href, { instant: true }));
  act(() => root.render(<DataValue value={data}><BarProvider><Shell /></BarProvider></DataValue>));
  await settle();
  // the page drew its own view, not the loading state of a page or tab (App.tsx FirstScan, MatchView.tsx TabSkeleton)
  expect(document.querySelector(".pane .first-scan, .pane [aria-busy='true']"), href).toBeNull();
  const attrs = Array.from(document.querySelectorAll("*"), (n) => Array.from(n.attributes, (a) => `${a.name}=${a.value}`).join(" "));
  return { html: document.documentElement.outerHTML, title: document.title, visible: [document.body.textContent, ...attrs, document.title, location.hash].join(" ") };
}

const found = (text: string) => SENTINELS.filter((s) => text.includes(s));

/** A clips host on a machine whose user folder is the sentinel's, as the Rust host would answer there. */
function clipsOnSentinelMachine(takeOf: string, finished: FinishRequest[]): ClipsHost {
  const clipsDir = `${HOME_DIR}\\AppData\\Roaming\\BotMatchStats\\clips`;
  const hlae = `${HOME_DIR}\\Tools\\HLAE\\HLAE.exe`;
  const cs2 = `${HOME_DIR}\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe`;
  const plan = (request: JobRequest): RenderPlan => {
    const jobDir = `${clipsDir}\\jobs\\job-20261026T180405123Z-a1b2c3`;
    const argv = [hlae, "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader", "-hookDllPath", `${HOME_DIR}\\Tools\\HLAE\\x64\\AfxHookSource2.dll`, "-programPath", cs2, "-cmdLine", "-insecure +exec cs2stats_clips"];
    return {
      version: 2, id: "job-20261026T180405123Z-a1b2c3", created: "2026-10-26T18:04:05.123Z", settings: { width: 1920, height: 1080, fps: 60 }, jobDir, hlaeExe: hlae, hookDll: argv[7], cs2Exe: cs2, argv,
      powershell: ["&", ...argv.map((a) => `'${a}'`)].join(" "), cfgFile: "cs2stats_clips.cfg", cfgText: `mirv_script_load "${jobDir.replaceAll("\\", "/")}/director.js"\n`,
      directorFile: `${jobDir}\\director.js`, outputs: [], request,
      demos: request.clips.map((c) => ({ path: `${HOME_DIR}\\replays\\${c.demo}`, tickRate: c.tickRate, clips: [{ id: c.id, steamid: c.steamid, start: c.startTick, end: c.endTick, reason: c.reason }] })),
    };
  };
  return {
    env: async () => ({
      clipsDir, font: "C:/Windows/Fonts/seguisb.ttf", cs2: { path: cs2, error: null }, replays: { path: `${HOME_DIR}\\replays`, error: null },
      hlae: { path: hlae, error: null }, ffmpeg: { path: `${HOME_DIR}\\scoop\\shims\\ffmpeg.exe`, error: null },
    }),
    demos: async (names) => names.map((name) => ({ name, path: `${HOME_DIR}\\replays\\${name}`, size: 1 })),
    scan: async () => ({ finished: [], reels: [], takes: [{ id: takeOf, job: "job-20261026T180405123Z-a1b2c3", take: "take0000", video: `${clipsDir}\\jobs\\x\\video.mp4`, audio: null, mtime: 1 }] }),
    plan: async (request) => plan(request),
    launch: async () => { throw new Error("the sentinel test never launches"); },
    finish: async (r) => { finished.push(r); return { code: 0, error: null, output: `${clipsDir}\\${r.id}.mp4` }; },
    reel: async () => ({ code: 0, error: null, output: `${clipsDir}\\reels\\r.mp4` }),
  };
}

describe("Hide personal info", () => {
  it("finds the lazily loaded views to load", () => {
    expect(lazyViews.length).toBeGreaterThanOrEqual(12);
  });

  it("leaves no name, SteamID or path of the user or of strangers on any page, tab or window title", async () => {
    hidePersonal(true);
    const leaks: string[] = [];
    let union = "";
    for (const href of ROUTES) {
      const { html, title, visible } = await show(href, dataWith());
      union += html;
      for (const s of found(html)) leaks.push(`${href}: ${s}`);
      for (const s of found(title)) leaks.push(`${href} (title): ${s}`);
      if (visible.includes(FILE)) leaks.push(`${href}: ${FILE}`);
    }
    expect(leaks).toEqual([]);
    // what replaced them, and what stays
    expect(union).toContain("You");
    expect(union).toContain("Teammate 1");
    expect(union).toContain("Opponent 1");
    expect(union).toContain("Rip");
    expect(union).toContain(`${PRO_NAME}_1`);
    expect(union).toContain("&lt;data folder&gt;");
    expect(union).toContain("&lt;SteamID&gt;");
    expect(union).toContain("picked/&lt;file&gt;.json.gz");
    expect(union).toContain(`href="${matchHref(imported.file)}"`);
    expect(union).toContain("&lt;file&gt;.dem");
    // the Leetify views were drawn: the connect card, Profile's card, the joined match's card and the Leetify-only rows
    expect(union).toContain("Data Provided by Leetify");
    expect(union).toContain("Aim Rating");
    expect(union).toContain("Leetify, this match");
    expect(union).toContain("lt-row");
  }, 120_000);

  it("hides them in Overview's win correlation rows and its trend's match links", async () => {
    // fails if the card's rows never render here, or its per-match line links a match by its file path
    hidePersonal(true);
    const { html } = await show(profileHref("overview"), dataWith());
    expect(document.querySelectorAll(".wcor__row").length).toBeGreaterThan(0);
    const links = Array.from(document.querySelectorAll(".wcor__panel a.ms__hit"), (a) => a.getAttribute("href")!);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((h) => /^#\/match\/m-[0-9a-f]+(-[0-9a-f]+)?\/overview$/.test(h)), links.join(" ")).toBe(true);
    expect(found(html)).toEqual([]);
  }, 30_000);

  it("hides them in the killfeeds read straight from a match's facts: the round drawer and the replay's sidebar", async () => {
    hidePersonal(true);
    for (const [href, sel] of [[matchHref(valve.file, "rounds", { round: ROUND }), ".drawer"], [matchHref(valve.file, "replay", { round: ROUND }), ".replay__feed"]] as const) {
      const { html } = await show(href, dataWith());
      const part = document.querySelector(sel);
      expect(part, `${href} draws ${sel}`).not.toBeNull();
      expect(part!.querySelectorAll(".kfeed__n, .kf__p").length, `${href} lists kills`).toBeGreaterThan(0);
      expect(found(html)).toEqual([]);
      expect(part!.outerHTML).toMatch(/Teammate 1|Opponent 1|You/);
    }
  }, 30_000);

  it("hides them in the flash tool's victims, the clutch list and the highlight lists, whose links open rounds by id", async () => {
    // fails if one of these views names a player from raw facts or links a round by its file path:
    // each is drawn with rows, a flash opened to list whom it blinded, and checked for every sentinel
    hidePersonal(true);
    const leaks: string[] = [];
    let opened = 0;
    let masked = "";
    const check = (where: string, html: string, visible: string) => {
      for (const s of found(html)) leaks.push(`${where}: ${s}`);
      if (visible.includes(FILE)) leaks.push(`${where}: ${FILE}`);
    };
    for (const x of [main, valve]) {
      let { html, visible } = await show(matchHref(x.file, "utility"), dataWith());
      // open every flash that blinded someone, and check each opened list
      const blinding = Array.from(document.querySelectorAll<HTMLButtonElement>(".fl-row__btn")).filter((b) => !/0 enemies blinded, 0 teammates/.test(b.getAttribute("aria-label") ?? ""));
      for (const row of blinding) {
        opened++;
        act(() => row.click());
        const detail = document.querySelector(".fl-detail")!;
        masked += Array.from(detail.querySelectorAll(".fl-blind__who"), (n) => n.textContent).join(" ");
        check(`${x.file} utility, a flash opened`, document.documentElement.outerHTML, [document.body.textContent, ...Array.from(document.querySelectorAll("*"), (n) => Array.from(n.attributes, (a) => a.value).join(" "))].join(" "));
      }
      for (const a of document.querySelectorAll<HTMLAnchorElement>(".fl-row__go")) expect(a.getAttribute("href")).toContain(matchId(x.file));
      check(`${x.file} utility`, html, visible);
      ({ html, visible } = await show(matchHref(x.file, "advanced"), dataWith()));
      expect(document.querySelector(".clutchtbl"), `${x.file} draws every clutch`).not.toBeNull();
      for (const a of document.querySelectorAll<HTMLAnchorElement>(".clutchtbl__r")) expect(a.getAttribute("href")).toContain(matchId(x.file));
      check(`${x.file} advanced`, html, visible);
    }
    expect(opened, "a flash was opened to list whom it blinded").toBeGreaterThan(0);
    // the strangers a flash blinded are listed under their placeholders
    expect(masked).toMatch(/Teammate 1|Opponent 1/);
    for (const href of [profileHref("overview"), pageHref("home")]) {
      const { html, visible } = await show(href, dataWith());
      const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>(".hlr"));
      expect(rows.length, `${href} lists highlights`).toBeGreaterThan(0);
      for (const a of rows) expect(a.getAttribute("href")).toMatch(/^#\/match\/[^/]+\/rounds\?round=\d+$/);
      for (const a of rows) expect(all.some((y) => a.getAttribute("href")!.includes(matchId(y.file)))).toBe(true);
      check(href, html, visible);
    }
    expect(leaks).toEqual([]);
  }, 60_000);

  it("opens a match by its id while hiding personal info, and by its file path too", async () => {
    hidePersonal(true);
    const href = matchHref(imported.file);
    expect(href).not.toContain(FILE);
    await show(href, dataWith());
    expect(document.querySelector(".mhero__name")?.textContent).toContain("You");
    expect(document.querySelector(".pane .error-box")).toBeNull();
    // an address that names the file, such as an old bookmark, opens the same match and is rewritten to the id
    act(() => { location.hash = `#/match/imported/${encodeURIComponent(`${FILE} vs friends.json.gz`)}/rounds`; });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await show(location.hash, dataWith());
    expect(location.hash).not.toContain(FILE);
    expect(document.querySelector(".mhero__name")).not.toBeNull();
    expect(document.querySelector(".pane .error-box")).toBeNull();
  }, 30_000);

  it("opens an id link on a cold start: loading while the list loads, then the match, the address untouched", async () => {
    hidePersonal(true);
    knownMatchFiles(all.map((x) => x.file));
    const id = matchId(imported.file);
    knownMatchFiles([]);
    act(() => { location.hash = `#/match/${id}/rounds`; });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    act(() => root.render(<DataValue value={dataWith({ status: "syncing", matches: [], fileErrors: [] })}><BarProvider><Shell /></BarProvider></DataValue>));
    await settle();
    expect(document.querySelector(".pane .first-scan")).not.toBeNull();
    expect(document.querySelector(".pane .error-box")).toBeNull();
    expect(location.hash).toBe(`#/match/${id}/rounds`);
    await show(location.hash, dataWith());
    expect(document.querySelector(".mhero__name")?.textContent).toContain("You");
    expect(document.querySelector(".pane .error-box")).toBeNull();
    expect(location.hash).toBe(`#/match/${id}/rounds`);
  }, 30_000);

  it("rewrites the open match's address to its file path when the setting goes off, and back to the id when it comes on", async () => {
    hidePersonal(true);
    await show(matchHref(imported.file, "economy"), dataWith());
    const id = matchId(imported.file);
    expect(location.hash).toBe(`#/match/${id}/economy`);
    hidePersonal(false);
    expect(location.hash).toBe(`#/match/imported/${encodeURIComponent(`${FILE} vs friends.json.gz`)}/economy`);
    hidePersonal(true);
    expect(location.hash).toBe(`#/match/${id}/economy`);
  }, 30_000);

  it("hides them in a toast and a tooltip already open when the setting comes on", async () => {
    await show(pageHref("home"), dataWith());
    act(() => { toast(`${FILE}.json.gz was not imported: ${FILE}.json.gz: already imported`, "poor", 6000, [`${FILE}.json.gz`]); });
    const toastText = () => document.querySelector(".toasts")?.textContent ?? "";
    expect(toastText()).toContain(FILE);
    // the sidebar's identity carries the user's name in its tooltip
    const me = document.querySelector(".side__me")!;
    await act(async () => {
      me.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
    });
    const tip = document.getElementById("app-tip")!;
    expect(tip.classList.contains("is-on")).toBe(true);
    expect(tip.textContent).toContain(NAME);
    hidePersonal(true);
    expect(toastText()).not.toContain(FILE);
    expect(toastText()).toContain("<file>.json.gz was not imported");
    // the open tooltip closed; opened again, it reads the page's new text
    expect(tip.classList.contains("is-on")).toBe(false);
    await act(async () => {
      me.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
      me.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(tip.textContent).not.toContain(NAME);
    expect(tip.textContent).toContain("You");
    act(() => { for (let i = 1; i < 100; i++) dismissToast(i); });
  }, 30_000);

  it("hides them in failures too: the failed scan, the Valve folder's error and the importer's", async () => {
    hidePersonal(true);
    const error = `ENOENT: no such file or directory, scandir '${DATA_FOLDER}' (pov ${ID})`;
    const broken = dataWith({ status: "error", error, matches: [], host: hostWith({ folder: VALVE_FOLDER, user: null, userError: null, error: `${VALVE_FOLDER} for ${ID} could not be listed`, skipped: [] }, failedImport) });
    for (const href of [pageHref("home"), pageHref("settings")]) {
      const { html, title } = await show(href, broken);
      expect(found(html + title)).toEqual([]);
    }
    expect(document.body.textContent).toContain("<path>");
  }, 30_000);

  it("reaches the page with the setting off, so the check above is not vacuous", async () => {
    let union = "", visible = "";
    for (const href of ROUTES) { const r = await show(href, dataWith()); union += r.html; visible += r.visible; }
    expect(found(union).sort()).toEqual([...SENTINELS].sort());
    expect(visible).toContain(FILE);
  }, 120_000);

  it("replaces identity, never numbers: the scoreboard's figures are the same either way", async () => {
    const figures = async () => {
      await show(matchHref(main.file, "overview"), dataWith());
      return Array.from(document.querySelectorAll(".pane .num"), (n) => n.textContent);
    };
    const shown = await figures();
    hidePersonal(true);
    expect(await figures()).toEqual(shown);
    expect(shown.length).toBeGreaterThan(20);
  }, 30_000);

  it("hides them in the Clips page's Render dialog and in the lower third's text a clip is finished with", async () => {
    // fails if the dialog shows the command, folders or demo paths of a user whose folder carries a
    // sentinel, or the lower third burns a name or path into the video. One of the Valve match's
    // moments names a path in its reason (a place name is the map maker's text), and that moment
    // has a take to finish; another is ready to render.
    const all = (perMatch.moments as (q: Query) => Promise<MomentRow[]>);
    const rows = await all({ files: [valve.file], filter: { player: ID } });
    expect(rows.length, "the Valve match has two moments or more").toBeGreaterThanOrEqual(2);
    const [taken, ready] = rows;
    const named = `${taken.reason}, from ${HOME_DIR}\\x`;
    const before = answers.moments;
    answers.moments = (async (q: Query) => (await all(q)).map((m) => (m.id === taken.id ? { ...m, reason: named } : m))) as never;
    const finished: FinishRequest[] = [];
    clipsStandIn = clipsOnSentinelMachine(taken.id, finished);
    try {
      hidePersonal(true);
      await show(pageHref("clips"), dataWith());
      const rowOf = (id: string) => document.querySelector<HTMLElement>(`.clip[data-clip="${id}"]`)!;
      // the list shows the reason through the layer too
      expect(rowOf(taken.id).querySelector(".clip__reason")!.textContent).toBe(hideText(named));
      await act(async () => { rowOf(ready.id).querySelector<HTMLInputElement>("input")!.click(); });
      await act(async () => { Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Render 1 clip"))!.click(); });
      await settle();
      const dlg = document.querySelector("dialog.rdlg");
      expect(dlg?.querySelector(".rdlg__cmd")?.textContent, "the dialog shows the plan").toMatch(/-insecure/);
      expect(found(dlg!.outerHTML)).toEqual([]);
      expect(dlg!.outerHTML).toContain("&lt;path&gt;");
      await act(async () => { Array.from(dlg!.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!.click(); });
      await act(async () => { rowOf(ready.id).querySelector<HTMLInputElement>("input")!.click(); });
      await act(async () => { rowOf(taken.id).querySelector<HTMLInputElement>("input")!.click(); });
      await act(async () => { Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.startsWith("Finish 1 clip"))!.click(); });
      await settle();
      expect(finished.map((f) => f.id)).toEqual([taken.id]);
      expect(found(JSON.stringify(finished))).toEqual([]);
      expect(finished[0].reason).toBe(hideText(named));
      expect(finished[0].reason).toContain("<path>");
      expect(found(document.body.innerHTML)).toEqual([]);
    } finally {
      answers.moments = before;
      clipsStandIn = null;
    }
  }, 30_000);
});
