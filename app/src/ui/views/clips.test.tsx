// @vitest-environment jsdom
// The Clips page (Clips.tsx) on hand-built moments and a stand-in clips host: every moment is listed
// with its state and the reason a demo is missing, only renderable moments can be chosen, a rendered
// clip's path is masked with personal info hidden, Render asks the host for a plan and launches
// nothing until its confirmation is pressed, and the page sends the host typed requests only.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipsHost, FinishRequest, Take } from "../../clips/host";
import type { JobRequest, RenderPlan } from "../../clips/plan";
import type { MomentRow } from "../../worker/protocol";
import type { MatchEntry } from "../data/match";
import { setHidePersonal } from "../data/privacy";

const VALVE = "valve/match730_0001/v-3.1.0-0123abcd", PLUGIN = "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz";
const ME = "76561190000000001";
const entry = (file: string, source: string) => ({ file, origin: "", hasAim: true, hasPos: true, match: { source, map: "de_mirage", date: "2026-10-24", startedAt: null, complete: true }, you: 0, players: [] }) as unknown as MatchEntry;
const row = (id: string, file: string, round: number, reason: string): MomentRow => ({
  id, file, round, reason, map: "de_mirage", start: 0, matchRank: 1, player: ME, side: "T", kinds: ["3k"], flicks: 0, clutch: null, swing: 0.3, place: "BombsiteB",
  kills: [{ tick: 1320, weapon: "ak47", headshot: true, wallbang: false, smoke: false, noscope: false, blind: null, inAir: null }],
  startTick: 1000, endTick: 1960, tickRate: 64, score: 6,
});
const READY = "c-00000000000000aa-r3", DONE = "c-00000000000000aa-r9", NODEMO = "c-00000000000000bb-r1", TAKEN = "c-00000000000000aa-r5";
const JOB = "job-20261026T180405123Z-a1b2c3";
let moments: MomentRow[] = [];
let launched: string[] = [];
/** each plan the page asked the host for, and whether it asked to save it */
let planned: { request: JobRequest; write: boolean }[] = [];
let finished: FinishRequest[] = [];
let takes: Take[] = [];
/** when set, the stand-in host's scan rejects with it */
let scanFails: string | null = null;

vi.mock("../data/provider", () => ({ useData: () => ({ matches: [entry(VALVE, "valve"), entry(PLUGIN, "local")], you: [ME], version: 0, client: null }) }));
vi.mock("../data/engine", async (orig) => ({ ...(await orig<object>()), careerEntries: (m: MatchEntry[]) => m }));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useYourQuery: () => ({ files: [VALVE, PLUGIN], filter: { player: ME } }),
  useCall: (method: string) => ({ data: method === "moments" ? moments : null, error: null, loading: false }),
}));
const CLIPS = "E:\\Data\\BotMatchStats\\clips";
const HLAE = "D:\\Tools\\HLAE\\HLAE.exe";

/** A plan as the host returns it (src-tauri/src/clips/job.rs Plan), for the dialog to show. */
function planOf(request: JobRequest, id: string): RenderPlan {
  const jobDir = `${CLIPS}\\jobs\\${id}`;
  const argv = [HLAE, "-noGui", "-autoStart", "-noConfig", "-afxDisableSteamStorage", "-customLoader", "-hookDllPath", "D:\\Tools\\HLAE\\x64\\AfxHookSource2.dll",
    "-programPath", "D:\\Steam\\cs2.exe", "-cmdLine", "-insecure -novid -condebug -console -sw -width 1920 -height 1080 +exec cs2stats_clips"];
  return {
    version: 2, id, created: "2026-10-26T18:04:05.123Z", settings: { width: 1920, height: 1080, fps: 60 }, jobDir, hlaeExe: argv[0], hookDll: argv[7], cs2Exe: argv[9], argv,
    powershell: ["&", ...argv.map((a) => `'${a}'`)].join(" "), cfgFile: "cs2stats_clips.cfg",
    cfgText: `mirv_script_load "${jobDir.replaceAll("\\", "/")}/director.js"\n`, directorFile: `${jobDir}\\director.js`,
    demos: request.clips.map((c) => ({ path: `D:\\replays\\${c.demo}`, tickRate: c.tickRate, clips: [{ id: c.id, steamid: c.steamid, start: c.startTick, end: c.endTick, reason: c.reason }] })),
    outputs: [], request,
  };
}

const host: ClipsHost = {
  env: async () => ({
    clipsDir: CLIPS, font: "C:/Windows/Fonts/seguisb.ttf",
    cs2: { path: "D:\\Steam\\cs2.exe", error: null }, replays: { path: "D:\\replays", error: null },
    hlae: { path: HLAE, error: null }, ffmpeg: { path: "D:\\Tools\\ffmpeg.exe", error: null },
  }),
  demos: async (names) => names.map((name) => ({ name, path: `D:\\replays\\${name}`, size: 1 })),
  scan: async () => {
    if (scanFails) throw new Error(scanFails);
    return { finished: [{ id: DONE, path: `${CLIPS}\\${DONE}.mp4`, size: 1, mtime: 1 }], takes, reels: [] };
  },
  plan: async (request, write) => { planned.push({ request, write }); return planOf(request, write ? JOB : "job-20261026T180405000Z-000000"); },
  launch: async (job) => { launched.push(job); return { pid: 4242, cfg: "x", ffmpegIni: null }; },
  finish: async (r) => { finished.push(r); return { code: 0, error: null, output: `${CLIPS}\\${r.id}.mp4` }; },
  reel: async () => ({ code: 0, error: null, output: `${CLIPS}\\reels\\reel.mp4` }),
};
vi.mock("../../clips/host", async (orig) => ({ ...(await orig<object>()), clipsHost: async () => host }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;
// jsdom has <dialog> without the modal methods
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  moments = [row(READY, VALVE, 3, "3K on B Site, +30% round impact"), row(DONE, VALVE, 9, "Ace on Mid, +90% round impact"), row(NODEMO, PLUGIN, 1, "1v2 clutch, +51% round impact")];
  launched = []; planned = []; finished = []; takes = []; scanFails = null;
  el = document.body.appendChild(document.createElement("div"));
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => { setHidePersonal(false); });
  document.body.innerHTML = "";
});
const { default: ClipsView, clock } = await import("./Clips");
const { BarProvider } = await import("../shell/Bar");
/** Renders the page and lets the stand-in host answer. */
const render = async () => { await act(async () => root.render(<BarProvider><ClipsView /></BarProvider>)); await act(async () => {}); };
const rowOf = (reason: string) => [...el.querySelectorAll<HTMLElement>(".clip")].find((r) => r.querySelector(".clip__reason")?.textContent === reason)!;
const click = (b: Element | null | undefined) => act(async () => { (b as HTMLElement).click(); });
const button = (scope: ParentNode, text: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.startsWith(text));

it("writes a clip's length as m:ss, rounding before it splits minutes from seconds", () => {
  // fails if 59.6 s reads 0:60, or the rounding moves a whole second elsewhere
  expect([0, 9.4, 59.4, 59.6, 60, 119.5, 600].map(clock)).toEqual(["0:00", "0:09", "0:59", "1:00", "1:00", "2:00", "10:00"]);
});

describe("the Clips page", () => {
  it("lists every moment best first with its state, says why a demo is missing, and lets only renderable ones be chosen", async () => {
    // fails if a moment without a demo is dropped or choosable, the states are wrong, or the why is not said
    await render();
    const rows = [...el.querySelectorAll(".clip")];
    expect(rows.map((r) => [r.querySelector(".clip__rank")!.textContent, r.querySelector(".cstate")!.textContent])).toEqual([["1", "Ready to render"], ["2", "Rendered"], ["3", "Needs a demo"]]);
    expect(rowOf("1v2 clutch, +51% round impact").querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(rowOf("3K on B Site, +30% round impact").querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(el.querySelector(".clips__whys")!.textContent).toMatch(/1 moment needs a demo\. The plugin records match data, not a demo/);
    // what round impact means: on the reason, and once on the page for keyboard and screen-reader users
    expect(rowOf("3K on B Site, +30% round impact").querySelector(".clip__reason")!.getAttribute("data-tip")).toMatch(/can pass 100%/);
    expect(el.querySelector(".clips__head")!.textContent).toMatch(/Round impact adds up/);
    // each moment opens its round in the Rounds drawer and in the replay
    expect([...rowOf("3K on B Site, +30% round impact").querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      `#/match/valve/match730_0001/v-3.1.0-0123abcd/rounds?round=3`, `#/match/valve/match730_0001/v-3.1.0-0123abcd/replay?round=3`,
    ]);
  });

  it("stays the desktop app when the first scan fails, and says why at the top of the page", async () => {
    // fails if a rejected scan drops the host (the page then claims rendering needs the desktop app and
    // disables Render), or the error shows only inside the list
    scanFails = `${CLIPS}\\jobs: access denied`;
    await render();
    expect(el.textContent).not.toMatch(/Rendering runs in the desktop app/);
    const alert = el.querySelector(".clips__error")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(`Checking the clips folder and tools failed: Error: ${CLIPS}\\jobs: access denied`);
    // it sits between the page head and the list, not inside the list
    expect(alert.previousElementSibling?.className).toBe("clips__head");
    // the host is kept: ready moments can still be chosen and rendered, and Check again is there
    await act(async () => { rowOf("3K on B Site, +30% round impact").querySelector<HTMLInputElement>("input")!.click(); });
    expect(button(el, "Render 1 clip")!.hasAttribute("disabled")).toBe(false);
    expect(button(el, "Check again")).toBeDefined();
    // with personal info hidden, the folder in the error is masked
    act(() => { setHidePersonal(true); });
    await act(async () => {});
    expect(el.querySelector(".clips__error")!.textContent).toBe("Checking the clips folder and tools failed: Error: <path>: access denied");
  });

  it("masks a rendered clip's folder with personal info hidden", async () => {
    // fails if the clips folder, which holds the user's name, shows in the page or its tooltip
    act(() => { setHidePersonal(true); });
    await render();
    const path = rowOf("Ace on Mid, +90% round impact").querySelector(".clip__path")!;
    expect(path.textContent).toBe(`${DONE}.mp4`);
    expect(path.getAttribute("data-tip")).toBe(`<clips folder>\\${DONE}.mp4\nCopy the path`);
  });

  it("asks the host for the plan, shows it with the -insecure warning, and starts CS2 only when the launch is confirmed", async () => {
    // fails if opening the dialog writes or launches anything, the request carries a path instead of
    // the demo's name, the plan or warning is missing, or Launch does not save the job first
    await render();
    await act(async () => { rowOf("3K on B Site, +30% round impact").querySelector<HTMLInputElement>("input")!.click(); });
    await click(button(el, "Render 1 clip"));
    await act(async () => {});
    const dlg = document.querySelector("dialog.rdlg")!;
    expect(dlg.hasAttribute("open")).toBe(true);
    expect(dlg.querySelector(".rdlg__warn")!.textContent).toMatch(/This starts CS2 with -insecure/);
    expect(dlg.querySelector(".rdlg__cmd")!.textContent).toMatch(/^& '.*HLAE\.exe' '-noGui' .* '-cmdLine' '-insecure /);
    expect(planned).toEqual([{ write: false, request: { hlae: HLAE, clips: [{ id: READY, demo: "match730_0001.dem", steamid: ME, round: 3, startTick: 1000, endTick: 1960, tickRate: 64, reason: "3K on B Site, +30% round impact" }] } }]);
    expect(launched).toEqual([]);
    await click(button(dlg, "Launch CS2 with -insecure"));
    expect(planned.map((p) => p.write)).toEqual([false, true]);
    expect(launched).toEqual([JOB]);
    expect(dlg.querySelector(".rdlg__done")!.textContent).toMatch(/process 4242/);
  });

  it("finishes a recorded take by sending the host the clip, its job and the lower third's text", async () => {
    // fails if the page sends anything but the typed request, or the lower third's text differs from the moment's
    takes = [{ id: TAKEN, job: JOB, take: "take0001", video: `${CLIPS}\\jobs\\${JOB}\\raw\\${TAKEN}\\take0001\\video.mp4`, audio: null, mtime: 2 }];
    moments = [...moments, row(TAKEN, VALVE, 5, "4K on A Site, +70% round impact")];
    await render();
    await act(async () => { rowOf("4K on A Site, +70% round impact").querySelector<HTMLInputElement>("input")!.click(); });
    await click(button(el, "Finish 1 clip"));
    expect(finished).toEqual([{ id: TAKEN, job: JOB, take: "take0001", reason: "4K on A Site, +70% round impact", subline: "Mirage · Round 5 · Oct 24", durationS: 15 }]);
  });
});
