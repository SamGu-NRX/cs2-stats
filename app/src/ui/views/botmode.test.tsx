// @vitest-environment jsdom
// The Bot Mode page over a mocked Tauri invoke: Tauri's own mockIPC answers every command from
// botmode/mock.ts's scripted game folder, so the page goes through the real typed wrappers
// (botmode/commands.ts) and every argument the backend would receive is checked here. Covers each
// state the backend can report, the settings round trip with its stale-read refusal, and that no
// action reaches the backend before its confirmation. Nothing here can start CS2 or touch a game
// folder: the only backend is the mock.
import { invoke } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botmodeOver } from "../../botmode/commands";
import { mockCall, type Scenario } from "../../botmode/mock";
import type { Host } from "../../host/host";
import { setBotModeApi } from "../data/botmode";
import { setHidePersonal } from "../data/privacy";
import { DataValue, type Data } from "../data/provider";
import { BarProvider } from "../shell/Bar";
import BotModeView from "./BotMode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;
globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;

const data = (): Data => ({
  status: "ready", error: null, client: null, meta: true, matches: [], you: [], fileErrors: [], progress: null,
  baselines: null, baselinesError: null, version: 1, lastSync: null, refresh: () => {},
  host: { kind: "tauri", folder: null, valve: null, readPack: async () => null } as unknown as Host,
});

let root: Root;
let el: HTMLDivElement;
/** every command the page sent, with its arguments, in order */
let calls: [string, Record<string, unknown>][];
let backend: ReturnType<typeof mockCall>;

beforeEach(() => {
  el = document.body.appendChild(document.createElement("div"));
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
  document.body.innerHTML = "";
  clearMocks();
  setBotModeApi(undefined);
  act(() => { setHidePersonal(false); });
});

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** The page over `scenario`; `fail` makes a command reject with the given text. */
async function render(scenario: Scenario, fail: Record<string, string> = {}) {
  backend = mockCall(scenario);
  calls = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
    if (fail[cmd]) return Promise.reject(fail[cmd]);
    return backend(cmd, args as Record<string, unknown>);
  });
  // a fresh set of wrappers over the real invoke, so GitHub's release list is not cached between tests
  setBotModeApi(botmodeOver(invoke));
  act(() => root.render(<DataValue value={data()}><BarProvider><BotModeView /></BarProvider></DataValue>));
  await settle();
}

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => $(sel)?.textContent ?? "";
const button = (label: string | RegExp) => {
  const b = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((x) => (typeof label === "string" ? x.textContent === label : label.test(x.textContent ?? "")));
  if (!b) throw new Error(`no button ${label}; buttons: ${Array.from(document.querySelectorAll("button"), (x) => x.textContent).join(" | ")}`);
  return b;
};
/** The checkbox whose label reads `label`. */
const box = (label: string) => {
  const l = Array.from(document.querySelectorAll("label.check")).find((x) => x.textContent === label);
  if (!l) throw new Error(`no checkbox ${label}`);
  return l.querySelector("input")!;
};
const click = async (b: HTMLElement) => { act(() => b.click()); await settle(); };
const writes = () => calls.map(([c]) => c).filter((c) => !["botmode_status", "botmode_session", "botmode_catalog", "botmode_releases"].includes(c));
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (target: Element, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

describe("Bot Mode states", () => {
  it("installed and current: ready to launch, with the release check, the settings and the last session", async () => {
    await render("installed");
    expect(text("#bm-state")).toBe("Ready");
    expect(button(/Launch Bot Mode/).disabled).toBe(false);
    expect(text(".bm-ver")).toBe("v1.4.7Latest");
    expect(text(".bm-match")).toContain("551 of 562 files match v1.4.7");
    // every component off the release is named, with the user's builds linked to their branch
    expect(Array.from(document.querySelectorAll(".bm-comps li[data-state]"), (li) => li.textContent)).toEqual([
      "BotRandomizerYour build · feat/combined-1.4.7", "BotStateYour build · fix/postplant-hold-and-carrier", "BotBuyYour build · feat/chatwheel-economy-calls",
      "BotMatchStatsYour build · main", "Mod cfgsChanged · 2 files differ",
    ]);
    expect(text(".bm-kit")).toBe("Crimson AssaultDaniel Sadowski");
    expect($<HTMLInputElement>(".bm-knives")?.dataset.on).toBe("true");
    expect(document.querySelectorAll(".bm-knives li")).toHaveLength(20);
    expect(text(".seg__item[data-on='true']")).toBe("Medium");
    expect($<HTMLInputElement>("#bm-launch-opts")!.value).toBe("+exec botmode");
    expect(text(".bm-line")).toBe("steam.exe -applaunch 730 -insecure +exec botmode then Steam's own -novid -fullscreen -w 1280 -h 960");
    expect(text(".bm-session .card__title")).toBe("Last session");
    expect(text(".bm-checks")).toContain("Started with -insecure");
    expect(writes()).toEqual([]);
  });

  it("outdated: offers the newer release", async () => {
    await render("outdated");
    expect(text(".bm-ver")).toBe("v1.4.6v1.4.7 is out");
    expect(button("Update to v1.4.7…").disabled).toBe(false);
  });

  it("not installed: no launch, no settings, an install of the newest release", async () => {
    await render("not-installed");
    expect(text("#bm-state")).toBe("Not installed");
    expect(button(/Launch Bot Mode/).disabled).toBe(true);
    expect(text("#bm-launch-why")).toBe("Install the mod first.");
    expect(text(".bm-setup")).toContain("Install the mod to set your music kit");
    expect($(".bm-kit")).toBeNull();
    expect(button("Install v1.4.7…").disabled).toBe(false);
    expect(text(".bm-session")).toContain("No session yet");
  });

  it("session active: follows the session and blocks every write until CS2 exits", async () => {
    await render("session");
    expect(text("#bm-state")).toBe("In session");
    expect(text(".bm-hero__sub")).toBe("cs2.exe (pid 22916) started with -insecure; watching it until it exits");
    expect(button(/Launch Bot Mode/).disabled).toBe(true);
    expect(text(".bm-session .card__title")).toBe("This session");
    expect(text(".bm-session .chip")).toBe("Running");
    expect(button("Apply your builds…").disabled).toBe(true);
    expect(text(".bm-foot__state")).toBe("A Bot Mode session is running. Changes wait until CS2 exits.");
  });

  it("follows a running session, and says when its state stops reading instead of showing it as current", async () => {
    const fail: Record<string, string> = {};
    await render("session", fail);
    backend.state.session.status = { ...backend.state.session.status!, message: "cs2.exe (pid 22916) has exited; turning Bot Mode off" };
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    expect(text(".bm-sess [role=status]")).toBe("cs2.exe (pid 22916) has exited; turning Bot Mode off");
    fail.botmode_session = "session-status.json: The process cannot access the file because it is being used by another process. (os error 32)";
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    expect(text(".bm-session [role=alert]")).toContain("The session's state could not be read, so what shows here may be out of date: session-status.json: The process cannot access the file");
    // the session ends: Bot Mode reads the whole state again
    delete fail.botmode_session;
    backend.state.session = { supervised: false, notice: null, status: { ...backend.state.session.status!, state: "done" } };
    backend.state.status = { ...backend.state.status, supervised: false, cs2Running: false, botMode: false };
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    await settle();
    expect($(".bm-session [role=alert]")).toBeNull();
    expect(text("#bm-state")).toBe("Ready");
  }, 15_000);

  it("CS2 open outside a session: says so, shows what cleanup did, and blocks writes", async () => {
    await render("cs2-running");
    expect(text("#bm-state")).toBe("CS2 is open");
    expect(text(".bm-notes")).toContain("Bot Mode was left on by another tool; it's now off.");
    expect(button(/Launch Bot Mode/).disabled).toBe(true);
    expect(text("#bm-launch-why")).toBe("CS2 is running. Close it to change game files.");
  });

  it("an interrupted change: rollback first, its warning not repeated", async () => {
    await render("unfinished");
    expect(text("#bm-state")).toBe("Interrupted");
    expect($(".bm-launch")).toBeNull();
    expect(button("Roll back the change…")).toBeTruthy();
    expect(text(".bm-hero")).not.toContain("botmode rollback");
  });

  it("errors: a status that fails names why and can be tried again; a release list that fails says so", async () => {
    await render("no-steam");
    expect(text("#bm-state")).toBe("Not available");
    expect(text("[role=alert]")).toContain("Bot Mode finds CS2 through Steam");
    backend.state.statusError = null;
    await click(button(/Try again/));
    expect(text("#bm-state")).toBe("Ready");

    await render("not-installed", { botmode_releases: "error sending request for url (https://api.github.com/repos/ed0ard/CS2-Bot-Improver/releases)" });
    expect(text(".bm-releases")).toContain("GitHub's release list didn't load: error sending request");
    expect(() => button(/^Install v/)).toThrow();
  });

  it("in a browser, without the desktop backend, says where Bot Mode runs", async () => {
    setBotModeApi(null);
    act(() => root.render(<DataValue value={data()}><BarProvider><BotModeView /></BarProvider></DataValue>));
    await settle();
    expect(text(".empty")).toContain("Bot Mode runs in the desktop app");
  });
});

describe("settings", () => {
  it("round trip: each changed setting goes to its command once, cosmetics with what the page read", async () => {
    await render("installed");
    expect(button("Apply changes").disabled).toBe(true);
    // the music kit, by typing in the picker and Enter
    await click($(".bm-kit")!);
    const find = $<HTMLInputElement>(".bm-kitpop__input")!;
    expect(document.activeElement).toBe(find);
    type(find, "sharp");
    expect(Array.from(document.querySelectorAll(".bm-kitopt"), (o) => o.textContent)).toEqual(["SharpenedNoisia"]);
    key(find, "Enter");
    await settle();
    expect($(".bm-kitpop")).toBeNull();
    expect(document.activeElement).toBe($(".bm-kit"));
    expect(text(".bm-kit")).toBe("SharpenedNoisia");
    await click(box("Strongly favor expensive finishes"));
    await click(button("High"));
    type($<HTMLInputElement>("#bm-launch-opts")!, "+exec botmode -novid ");
    expect(text(".bm-foot__state")).toBe("4 unsaved changes");
    expect(writes()).toEqual([]);

    await click(button("Apply changes"));
    expect(calls.filter(([c]) => writes().includes(c))).toEqual([
      ["botmode_set_cosmetics", { cosmetics: { droppedKnifeSkins: true, droppedKnifePremium: true, musicKit: 4 }, seen: { droppedKnifeSkins: true, droppedKnifePremium: false, musicKit: 3 } }],
      ["botmode_set_difficulty", { level: "high" }],
      ["botmode_set_launch_options", { options: "+exec botmode -novid" }],
    ]);
    // read back from the backend
    expect(text(".bm-foot__state")).toBe("Saved in the game folder");
    expect(text(".bm-kit")).toBe("SharpenedNoisia");
    expect(text(".seg__item[data-on='true']")).toBe("High");
    expect($<HTMLInputElement>("#bm-launch-opts")!.value).toBe("+exec botmode -novid");
    expect(text(".bm-line")).toContain("-insecure +exec botmode -novid");
  });

  it("a stale read writes nothing, says why, and shows the current values; applying again goes through", async () => {
    await render("installed");
    await click(box("Give dropped knives a random finish"));
    // another tool changes the music kit after the page read the cfg
    backend.state.status.cosmetics = { ...backend.state.status.cosmetics, musicKit: 5 };
    await click(button("Apply changes"));
    expect(text(".bm-setup [role=alert]")).toMatch(/^Something else changed these settings after the page read them, so nothing was saved \(.*br_player_music_kit 5\); nothing was written\)/);
    expect(backend.state.status.cosmetics).toMatchObject({ droppedKnifeSkins: true, musicKit: 5 });
    expect(text(".bm-kit")).toBe("InsurgencyRobert Allaire");
    // the edit is kept and now sent with what the cfg holds
    expect(text(".bm-foot__state")).toBe("1 unsaved change");
    await click(button("Apply changes"));
    expect(calls.filter(([c]) => c === "botmode_set_cosmetics").at(-1)![1]).toEqual({ cosmetics: { droppedKnifeSkins: false, droppedKnifePremium: false, musicKit: 5 }, seen: { droppedKnifeSkins: true, droppedKnifePremium: false, musicKit: 5 } });
    expect(backend.state.status.cosmetics.droppedKnifeSkins).toBe(false);
  });

  it("shows the backend's refusal as it is, and Discard puts the read values back", async () => {
    await render("installed");
    type($<HTMLInputElement>("#bm-launch-opts")!, "-novid -secure");
    await click(button("Apply changes"));
    expect(text(".bm-setup [role=alert]")).toBe("launch options contain -secure, which turns VAC on; Bot Mode only starts CS2 with -insecure");
    expect(backend.state.status.launchOptions).toBe("+exec botmode");
    await click(button("Discard"));
    expect($<HTMLInputElement>("#bm-launch-opts")!.value).toBe("+exec botmode");
    expect($(".bm-setup [role=alert]")).toBeNull();
  });

  it("the kit picker works from the keyboard: Down opens, arrows move, Escape closes and returns focus", async () => {
    await render("installed");
    const kit = $(".bm-kit")!;
    kit.focus();
    key(kit, "ArrowDown");
    await settle();
    const find = $<HTMLInputElement>(".bm-kitpop__input")!;
    expect(find.getAttribute("role")).toBe("combobox");
    const active = () => document.getElementById(find.getAttribute("aria-activedescendant")!)?.textContent;
    expect(active()).toBe("Crimson AssaultDaniel Sadowski");
    key(find, "ArrowDown");
    expect(active()).not.toBe("Crimson AssaultDaniel Sadowski");
    key(find, "Escape");
    await settle();
    expect($(".bm-kitpop")).toBeNull();
    expect(document.activeElement).toBe(kit);
    expect(text(".bm-kit")).toBe("Crimson AssaultDaniel Sadowski");
  });
});

describe("actions wait for their confirmation", () => {
  const dialog = () => $<HTMLDialogElement>("dialog.bm-dialog");
  const cancelByEscape = async () => { act(() => { dialog()!.dispatchEvent(new Event("cancel", { cancelable: true })); }); await settle(); };

  it("launch: the dialog says it starts CS2 with -insecure; Cancel and Escape start nothing; confirming starts the supervised session", async () => {
    await render("installed");
    await click(button(/Launch Bot Mode/));
    expect(text(".bm-dialog__title")).toBe("Start CS2 in Bot Mode?");
    expect(text(".bm-dialog__lead")).toContain("CS2 starts with -insecure, which turns VAC off for this session.");
    expect(text("dialog .bm-line")).toBe("steam.exe -applaunch 730 -insecure +exec botmode then Steam's own -novid -fullscreen -w 1280 -h 960");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(writes()).toEqual([]);
    await click(button("Cancel"));
    expect(dialog()).toBeNull();
    await click(button(/Launch Bot Mode/));
    await cancelByEscape();
    expect(dialog()).toBeNull();
    expect(writes()).toEqual([]);

    await click(button(/Launch Bot Mode/));
    await click(button("Launch with -insecure"));
    expect(writes()).toEqual(["botmode_launch"]);
    expect(dialog()).toBeNull();
    expect(text("#bm-state")).toBe("In session");
    expect(text(".bm-session .chip")).toBe("Waiting for CS2");
  });

  it("update: downloads into the app folder to say what it changes, installs only on confirmation, and keeps the replaced builds in view", async () => {
    await render("outdated");
    await click(button("Update to v1.4.7…"));
    expect(writes()).toEqual(["botmode_download"]);
    expect(calls.find(([c]) => c === "botmode_download")![1]).toMatchObject({ tag: "v1.4.7" });
    const facts = text("dialog .bm-facts");
    expect(facts).toContain("Up to 566 files from CS2BotImprover.zip into the CS2 folder");
    expect(facts).toContain("Your builds of BotRandomizer, BotState, BotBuy, BotMatchStats with the release's");
    expect(facts).toContain("SHA-256 effb3c9c76301f74da1582fb167b44fa12b86772c2cacc91848767c27db92e67");
    await click(button("Cancel"));
    expect(writes()).toEqual(["botmode_download"]);

    await click(button("Update to v1.4.7…"));
    await click(button("Update to v1.4.7"));
    expect(writes()).toEqual(["botmode_download", "botmode_download", "botmode_install"]);
    expect(calls.find(([c]) => c === "botmode_install")![1]).toMatchObject({ tag: "v1.4.7" });
    expect(text(".bm-ver")).toBe("v1.4.7Latest");
    // the install took the user's builds off: the page says so until they are applied again
    expect(text(".bm-install [role=status]")).toBe("The install replaced your builds of BotRandomizer, BotState, BotBuy, BotMatchStats. Apply your builds to put them back.");
    await click(button("Apply your builds…"));
    expect(text("dialog .bm-facts")).toContain("overlay.json");
    await click(button("Apply builds"));
    expect(writes().at(-1)).toBe("botmode_overlay");
    expect(text(".bm-install")).not.toContain("The install replaced your builds");
  });

  it("an install that fails keeps its dialog open with the backend's reason", async () => {
    await render("not-installed", { botmode_install: "CS2 is running. Close it first: Bot Mode never changes game files while the game is open." });
    await click(button("Install v1.4.7…"));
    await click(button("Install v1.4.7"));
    expect(text("dialog [role=alert]")).toBe("CS2 is running. Close it first: Bot Mode never changes game files while the game is open.");
    expect(button("Install v1.4.7").disabled).toBe(false);
  });

  it("rollback: names the interrupted change and rolls back exactly that one", async () => {
    await render("unfinished");
    const id = backend.state.status.unfinished!.id;
    await click(button("Roll back the change…"));
    expect(text("dialog .bm-facts")).toContain(id);
    expect(writes()).toEqual([]);
    await click(button("Roll back"));
    expect(calls.find(([c]) => c === "botmode_rollback")![1]).toMatchObject({ id });
    expect(text("#bm-state")).toBe("Ready");
  });

  it("opened from the keyboard, a dialog appears without motion", async () => {
    await render("installed");
    // a click event with detail 0 is what Enter or Space on a focused button sends
    act(() => { button(/Launch Bot Mode/).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })); });
    await settle();
    expect(dialog()!.classList.contains("is-instant")).toBe(true);
    await click(button("Cancel"));
    act(() => { button(/Launch Bot Mode/).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
    await settle();
    expect(dialog()!.classList.contains("is-instant")).toBe(false);
  });

  it("nothing that writes can be started while CS2 runs", async () => {
    await render("cs2-running");
    for (const b of document.querySelectorAll<HTMLButtonElement>(".bm-actions button, .bm-launch")) expect(b.disabled, b.textContent ?? "").toBe(true);
    type($<HTMLInputElement>("#bm-launch-opts")!, "-novid");
    expect(button("Apply changes").disabled).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe("privacy", () => {
  it("hides the game folder and the session's command line", async () => {
    act(() => { setHidePersonal(true); });
    await render("installed");
    expect(text(".bm-folder")).toBe("CS2 folder <path>");
    expect(text(".bm-checks__detail")).toBe("\"<path>\" -insecure -novid -fullscreen -w 1280 -h 960");
    expect(document.body.innerHTML).not.toContain("steamapps");
  });
});
