// @vitest-environment jsdom
// The Clips page (Clips.tsx) on hand-built moments and a stand-in clips host: every moment is listed
// with its state and the reason a demo is missing, only renderable moments can be chosen, a rendered
// clip's path is masked with personal info hidden, and Render shows the plan and launches nothing
// until its confirmation is pressed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipsHost } from "../../clips/host";
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
const READY = "c-00000000000000aa-r3", DONE = "c-00000000000000aa-r9", NODEMO = "c-00000000000000bb-r1";
let moments: MomentRow[] = [];
let launched: string[] = [];
let saved: string[] = [];

vi.mock("../../worker/views", async (orig) => orig());
vi.mock("../data/provider", () => ({ useData: () => ({ matches: [entry(VALVE, "valve"), entry(PLUGIN, "local")], you: [ME], version: 0, client: null }) }));
vi.mock("../data/engine", async (orig) => ({ ...(await orig<object>()), careerEntries: (m: MatchEntry[]) => m }));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useYourQuery: () => ({ files: [VALVE, PLUGIN], filter: { player: ME } }),
  useCall: (method: string) => ({ data: method === "moments" ? moments : null, error: null, loading: false }),
}));
const CLIPS = String.raw`E:\Data\BotMatchStats\clips`;
const host: ClipsHost = {
  env: async () => ({
    clipsDir: CLIPS, font: "C:/Windows/Fonts/seguisb.ttf",
    cs2: { path: String.raw`D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe`, error: null },
    replays: { path: String.raw`D:\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\replays`, error: null },
    hlae: { path: String.raw`D:\Tools\HLAE\HLAE.exe`, error: null }, ffmpeg: { path: String.raw`D:\Tools\ffmpeg.exe`, error: null },
  }),
  demos: async (names) => names.map((name) => ({ name, path: `D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\replays\\${name}`, size: 1 })),
  scan: async () => ({ finished: [{ id: DONE, path: `${CLIPS}\\${DONE}.mp4`, size: 1, mtime: 1 }], takes: [], reels: [] }),
  saveJob: async (job) => { saved.push(job); return `${CLIPS}\\jobs\\${job}`; },
  launch: async (job) => { launched.push(job); return { pid: 4242, cfg: "x", ffmpegIni: null }; },
  ffmpeg: async () => ({ code: 0, error: null }),
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
  moments = [row(READY, VALVE, 3, "3K on B Site, +30% swing"), row(DONE, VALVE, 9, "Ace on Mid, +90% swing"), row(NODEMO, PLUGIN, 1, "1v2 clutch, +51% swing")];
  launched = []; saved = [];
  el = document.body.appendChild(document.createElement("div"));
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => { setHidePersonal(false); });
  document.body.innerHTML = "";
});
const { default: ClipsView } = await import("./Clips");
const { BarProvider } = await import("../shell/Bar");
/** Renders the page and lets the stand-in host answer. */
const render = async () => { await act(async () => root.render(<BarProvider><ClipsView /></BarProvider>)); await act(async () => {}); };
const rowOf = (reason: string) => [...el.querySelectorAll<HTMLElement>(".clip")].find((r) => r.querySelector(".clip__reason")?.textContent === reason)!;
const click = (b: Element | null | undefined) => act(async () => { (b as HTMLElement).click(); });

describe("the Clips page", () => {
  it("lists every moment best first with its state, says why a demo is missing, and lets only renderable ones be chosen", async () => {
    // fails if a moment without a demo is dropped or choosable, the states are wrong, or the why is not said
    await render();
    const rows = [...el.querySelectorAll(".clip")];
    expect(rows.map((r) => [r.querySelector(".clip__rank")!.textContent, r.querySelector(".cstate")!.textContent])).toEqual([["1", "Ready to render"], ["2", "Rendered"], ["3", "Needs a demo"]]);
    expect(rowOf("1v2 clutch, +51% swing").querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(rowOf("3K on B Site, +30% swing").querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(el.querySelector(".clips__whys")!.textContent).toMatch(/1 moment needs a demo\. The plugin records match data, not a demo/);
    // each moment opens its round in the Rounds drawer and in the replay
    expect([...rowOf("3K on B Site, +30% swing").querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      `#/match/valve/match730_0001/v-3.1.0-0123abcd/rounds?round=3`, `#/match/valve/match730_0001/v-3.1.0-0123abcd/replay?round=3`,
    ]);
  });

  it("masks a rendered clip's folder with personal info hidden", async () => {
    // fails if the clips folder, which holds the user's name, shows in the page or its tooltip
    act(() => { setHidePersonal(true); });
    await render();
    const path = rowOf("Ace on Mid, +90% swing").querySelector(".clip__path")!;
    expect(path.textContent).toBe(`${DONE}.mp4`);
    expect(path.getAttribute("data-tip")).toBe(`<clips folder>\\${DONE}.mp4\nCopy the path`);
  });

  it("shows the plan and the -insecure warning, and starts CS2 only when the launch is confirmed", async () => {
    // fails if choosing or opening the dialog launches anything, the plan or warning is missing, or Launch does not save the job first
    await render();
    await act(async () => { rowOf("3K on B Site, +30% swing").querySelector<HTMLInputElement>("input")!.click(); });
    await click([...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Render 1 clip")));
    const dlg = document.querySelector("dialog.rdlg")!;
    expect(dlg.hasAttribute("open")).toBe(true);
    expect(dlg.querySelector(".rdlg__warn")!.textContent).toMatch(/This starts CS2 with -insecure/);
    expect(dlg.querySelector(".rdlg__cmd")!.textContent).toMatch(/HLAE\.exe -noGui .* -cmdLine "-insecure /);
    expect([launched, saved]).toEqual([[], []]);
    await click([...dlg.querySelectorAll("button")].find((b) => b.textContent === "Launch CS2 with -insecure"));
    expect(saved).toHaveLength(1);
    expect(launched).toEqual(saved);
    expect(dlg.querySelector(".rdlg__done")!.textContent).toMatch(/process 4242/);
  });
});
