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
// stood in for, answering from the samples as the worker would (as views.test.tsx does).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Host, ValveFolder } from "../../host/host";
import type { ImportStatus, ImportStore } from "../../host/import-store";
import type { Baselines } from "../../stats/compare";
import { derive } from "../../stats/derive";
import type { MatchFacts } from "../../stats/facts";
import { headToHead, mapZones, openingDuels, roundRatings } from "../../stats/matchviews";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import type { MatchFile } from "../../stats/plugin/schema";
import { rating3Of } from "../../stats/rating3";
import { rollup } from "../../stats/rollup";
import type { MatchTables } from "../../stats/tables";
import type { Client } from "../../worker/client";
import { matchCalls } from "../../worker/matchcalls";
import type { Query } from "../../worker/protocol";
import { addCareerMatch, botPopulation, rankingCalls, sideQuery } from "../../worker/ranking";
import { entryOf, matchBundle, metaOf, ratingsOf, roundBundle, rolled } from "../../worker/views";
import { Shell } from "../App";
import type { MatchEntry } from "../data/match";
import { setMeta } from "../data/meta";
import { setHidePersonal } from "../data/privacy";
import { DataValue, type Data } from "../data/provider";
import { go, MATCH_TABS, matchHref, pageHref, PROFILE_TABS, profileHref } from "../router";
import { BarProvider } from "../shell/Bar";

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
const SENTINELS = [NAME, MATE, OPPONENT, ID, "SENTINEL_USER"];
/** A pro demo's players keep their names. */
const PRO_NAME = "KEPT_PRO";

interface Fixture { file: string; facts: MatchFacts; tables: MatchTables; entry: MatchEntry }

/** A sample as the user's own match: the user is the sentinel, one bot on each side is a human stranger. */
async function fixture(f: string, file: string, pro = false): Promise<Fixture> {
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
  const tables = pluginToTables(s);
  const facts = derive(tables, CS2RB);
  return { file, facts, tables, entry: entryOf(file, s.env.plugin ?? "", facts) };
}

const names = readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz"));
const own = await Promise.all(names.map((f) => fixture(f, `samples/${f}`)));
const pro = await fixture("synthetic-demo.json.gz", "dev/pro-demo", true);
const all = [...own, pro];
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
  headToHead: (file: string) => headToHead(byFile.get(file)!.tables, byFile.get(file)!.facts),
  mapZones: (file: string, player: string) => mapZones(byFile.get(file)!.tables, player),
  openingDuels: (file: string, player: string) => openingDuels(byFile.get(file)!.facts, player),
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

const failedImport: ImportStatus = { running: false, at: null, error: null, last: { code: 2, summary: null, error: `valve_import.py: cannot read ${VALVE_FOLDER}\\demo.dem for ${ID}` } };
function hostWith(valve: ValveFolder): Host {
  const imports: ImportStore = { get: () => failedImport, subscribe: () => () => {}, onFinish: () => () => {}, start: async () => {}, sync: async () => {} };
  return {
    kind: "web", folder: DATA_FOLDER, valve, imports,
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
    fileErrors: [{ file: "valve/demo/v1", message: `${VALVE_FOLDER}\\demo\\v1\\match.parquet: the recording player (match pov ${ID}) is not among the players` }],
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
Element.prototype.scrollIntoView ??= () => {};
setMeta(metaOf(CS2RB));

/** Every route: each page, each Profile tab, each tab of an own match and of a pro demo. */
const ROUTES = [
  pageHref("home"), pageHref("matches"), pageHref("settings"),
  ...PROFILE_TABS.map((t) => profileHref(t)),
  ...MATCH_TABS.map((t) => matchHref(main.file, t)),
  ...own.filter((x) => x !== main).map((x) => matchHref(x.file)),
  matchHref(pro.file),
];

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
  return { html: document.documentElement.outerHTML, title: document.title };
}

const found = (text: string) => SENTINELS.filter((s) => text.includes(s));

describe("Hide personal info", () => {
  it("finds the lazily loaded views to load", () => {
    expect(lazyViews.length).toBeGreaterThanOrEqual(12);
  });

  it("leaves no name, SteamID or path of the user or of strangers on any page, tab or window title", async () => {
    hidePersonal(true);
    const leaks: string[] = [];
    let union = "";
    for (const href of ROUTES) {
      const { html, title } = await show(href, dataWith());
      union += html;
      for (const s of found(html)) leaks.push(`${href}: ${s}`);
      for (const s of found(title)) leaks.push(`${href} (title): ${s}`);
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
  }, 120_000);

  it("hides them in failures too: the failed scan, the Valve folder's error and the importer's", async () => {
    hidePersonal(true);
    const error = `ENOENT: no such file or directory, scandir '${DATA_FOLDER}' (pov ${ID})`;
    const broken = dataWith({ status: "error", error, matches: [], host: hostWith({ folder: VALVE_FOLDER, user: null, userError: null, error: `${VALVE_FOLDER} for ${ID} could not be listed`, skipped: [] }) });
    for (const href of [pageHref("home"), pageHref("settings")]) {
      const { html, title } = await show(href, broken);
      expect(found(html + title)).toEqual([]);
    }
    expect(document.body.textContent).toContain("<path>");
  }, 30_000);

  it("reaches the page with the setting off, so the check above is not vacuous", async () => {
    let union = "";
    for (const href of ROUTES) union += (await show(href, dataWith())).html;
    expect(found(union).sort()).toEqual([...SENTINELS].sort());
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
});
