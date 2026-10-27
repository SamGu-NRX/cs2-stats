// @vitest-environment jsdom
// The Bot Mode page over a mocked Tauri invoke: Tauri's own mockIPC answers every command from
// botmode/mock.ts's scripted game folder, so the page goes through the real typed wrappers
// (botmode/commands.ts) and every argument the backend would receive is checked here. Covers each
// state the backend can report, the VAC state, the settings round trip with its stale-read
// refusal and its queue while CS2 runs, and that no action reaches the backend before a
// confirmation that lists its files. Nothing here can start CS2 or touch a game folder: the only
// backend is the mock.
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
const copied: string[] = [];
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { copied.push(t); } }, configurable: true });

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
  localStorage.clear();
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

/** The page over `scenario`; `fail` makes a command reject with the given text (it can change later). */
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
/** The checkbox whose label starts with `label`. */
const box = (label: string) => {
  const l = Array.from(document.querySelectorAll("label.check")).find((x) => x.textContent?.startsWith(label));
  if (!l) throw new Error(`no checkbox ${label}`);
  return l.querySelector("input")!;
};
const click = async (b: HTMLElement) => { act(() => b.click()); await settle(); };
const READS = ["botmode_status", "botmode_session", "botmode_catalog", "botmode_releases", "botmode_server_cfg", "botmode_running", "botmode_overlay_plan", "botmode_change_files", "botmode_mod_commands"];
const writes = () => calls.map(([c]) => c).filter((c) => !READS.includes(c));
const sent = (cmd: string) => calls.filter(([c]) => c === cmd).at(-1)![1];
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (target: Element, k: string) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
const dialog = () => $<HTMLDialogElement>("dialog.bm-dialog");

describe("Bot Mode states", () => {
  it("installed and current: ready to launch, with the release check, the settings, the session and the history", async () => {
    await render("installed");
    expect(text("#bm-state")).toBe("Ready");
    expect(text(".bm-vac")).toBe("VAC on");
    expect(button(/Launch Bot Mode/).disabled).toBe(false);
    expect(text(".bm-ver")).toBe("v1.4.7Latest");
    expect(text(".bm-match")).toContain("551 of 562 files match v1.4.7");
    expect(Array.from(document.querySelectorAll(".bm-comps li[data-state]"), (li) => li.textContent)).toEqual([
      "BotRandomizerYour build · feat/combined-1.4.7", "BotStateYour build · fix/postplant-hold-and-carrier", "BotBuyYour build · feat/chatwheel-economy-calls",
      "BotMatchStatsYour build · main", "Mod cfgsChanged · 2 files differ",
    ]);
    expect(text(".bm-kit")).toBe("Crimson AssaultDaniel Sadowski");
    // the knife key: no bind of the user's yet, so the mod's \ spawns all 20
    expect(document.querySelectorAll(".bm-knife[aria-pressed='true']")).toHaveLength(20);
    expect(text(".bm-knifepick")).toContain("the mod's own \\ spawns every knife");
    expect(Array.from(document.querySelectorAll(".seg__item[data-on='true']"), (x) => x.textContent)).toEqual(["Mixed", "More", "Medium"]);
    expect($<HTMLInputElement>("#bm-launch-opts")!.value).toBe("+exec botmode");
    expect(text(".bm-line")).toBe("steam.exe -applaunch 730 -insecure +exec botmode then Steam's own -novid -fullscreen -w 1280 -h 960");
    expect(text(".bm-session .card__title")).toBe("Last session");
    // the history: changes of the user's (not session toggles), newest first, the newest undoable
    expect(Array.from(document.querySelectorAll(".bm-hist__what b"), (b) => b.textContent)).toEqual(["Settings", "Your builds applied", "Install v1.4.7"]);
    expect(Array.from(document.querySelectorAll(".bm-hist li"), (li) => li.querySelector("button")?.textContent ?? null)).toEqual(["Undo…", null, null]);
    expect(writes()).toEqual([]);
    // it read once, and polls nothing while no session runs
    const reads = calls.length;
    await act(async () => { await new Promise((r) => setTimeout(r, 2200)); });
    expect(calls.length).toBe(reads);
  }, 10_000);

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
    expect(button("Install v1.4.7…").disabled).toBe(false);
    expect(text(".bm-session")).toContain("No session yet");
  });

  it("session active: VAC off for this session, followed every two seconds, every write blocked", async () => {
    const fail: Record<string, string> = {};
    await render("session", fail);
    expect(text("#bm-state")).toBe("In session");
    expect(text(".bm-vac")).toBe("VAC off for this session");
    expect($(".bm-vac")!.dataset.tip).toContain("Every CS2 running (pid 22916) has -insecure, and Bot Mode is on in gameinfo.gi");
    expect(button(/Launch Bot Mode/).disabled).toBe(true);
    expect(text(".bm-session .chip")).toBe("Running");
    expect(button("Apply your builds…").disabled).toBe(true);
    backend.state.session.status = { ...backend.state.session.status!, message: "cs2.exe (pid 22916) has exited; turning Bot Mode off" };
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    expect(text(".bm-sess [role=status]")).toBe("cs2.exe (pid 22916) has exited; turning Bot Mode off");
    fail.botmode_session = "session-status.json: The process cannot access the file because it is being used by another process. (os error 32)";
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    expect(text(".bm-session [role=alert]")).toContain("The session's state could not be read, so what shows here may be out of date");
    // the session ends: everything is read again, and VAC is on once CS2 has exited
    delete fail.botmode_session;
    backend.state.session = { supervised: false, notice: null, status: { ...backend.state.session.status!, state: "done" } };
    backend.state.status = { ...backend.state.status, supervised: false, cs2Running: false, botMode: false };
    backend.state.running = [];
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); });
    await settle();
    expect(text("#bm-state")).toBe("Ready");
    expect(text(".bm-vac")).toBe("VAC on");
  }, 15_000);

  it("CS2 open outside a session: VAC on from its command line, cleanup's notice, writes blocked", async () => {
    await render("cs2-running");
    expect(text("#bm-state")).toBe("CS2 is open");
    expect(text(".bm-vac")).toBe("VAC on");
    expect(text(".bm-notes")).toContain("Bot Mode was left on by another tool; it's now off.");
    expect(text("#bm-launch-why")).toBe("CS2 is running. Close it to change game files.");
  });

  it("Steam's own launch options with -insecure: a warning, and the app never writes them", async () => {
    await render("installed");
    backend.state.status.steamLaunchOptions = "-novid -insecure";
    await click(button(/Check again/));
    expect(text(".bm-vac")).toBe("VAC off on Steam starts");
    expect($(".bm-vac")!.dataset.tip).toContain("This app never writes Steam's launch options");
    expect(writes()).toEqual([]);
  });

  it("a process list that can't be read: its own headline, no launch, no writes", async () => {
    await render("installed");
    backend.state.status.cs2Running = null;
    await click(button(/Check again/));
    expect(text("#bm-state")).toBe("Can't check CS2");
    expect(button(/Launch Bot Mode/).disabled).toBe(true);
    expect(text("#bm-launch-why")).toBe("The app could not check whether CS2 is running, so it changes nothing.");
  });

  it("a music kit the catalog no longer lists stays shown and does not block another setting", async () => {
    await render("installed");
    backend.state.status.cosmetics = { ...backend.state.status.cosmetics, musicKit: 41 };
    await click(button(/Check again/));
    expect(text(".bm-kit")).toBe("Kit 41");
    await click(box("Give dropped knives"));
    await click(button("Apply changes…"));
    await click(button("Apply"));
    expect(dialog()).toBeNull();
    expect(backend.state.status.cosmetics).toMatchObject({ droppedKnifeSkins: false, musicKit: 41 });
  });

  it("an interrupted change: rollback first, its warning not repeated", async () => {
    await render("unfinished");
    expect(text("#bm-state")).toBe("Interrupted");
    expect($(".bm-launch")).toBeNull();
    expect(text(".bm-hero")).not.toContain("botmode rollback");
  });

  it("errors: CS2 not found and an unreachable library each say so and can be tried again", async () => {
    await render("no-steam");
    expect(text("#bm-state")).toBe("Not available");
    expect(text("[role=alert]")).toContain("Bot Mode finds CS2 through Steam");
    backend.state.statusError = null;
    await click(button(/Try again/));
    expect(text("#bm-state")).toBe("Ready");

    await render("unreachable");
    expect(text("#bm-state")).toBe("Library unreachable");
    expect(text("[role=alert]")).toContain("took longer than 30 s");

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
  it("round trip: the dialog lists each file and line, then the server cfg goes as one change with what the page read", async () => {
    await render("installed");
    const sha256Before = backend.state.status.activeProfile;
    expect(button("Apply changes…").disabled).toBe(true);
    await click($(".bm-kit")!);
    const find = $<HTMLInputElement>(".bm-kitpop__input")!;
    type(find, "sharp");
    key(find, "Enter");
    await settle();
    expect(text(".bm-kit")).toBe("SharpenedNoisia");
    await click(box("Strongly favor"));
    await click(button("Head"));
    await click(button("Max"));
    await click(button("High"));
    // the knife key: two knives, on kp_end
    const knives = Array.from(document.querySelectorAll<HTMLButtonElement>(".bm-knife"));
    for (const k of knives) if (!["Karambit", "Butterfly Knife"].includes(k.dataset.tip!)) await click(k);
    type($<HTMLInputElement>(".bm-key")!, "kp_end");
    type($<HTMLInputElement>("#bm-launch-opts")!, "+exec botmode -novid ");
    expect(text(".bm-foot__state")).toBe("7 unsaved changes");
    expect(writes()).toEqual([]);

    await click(button("Apply changes…"));
    expect(Array.from(dialog()!.querySelectorAll(".bm-files li"), (li) => li.textContent)).toEqual([
      "br_dropped_knife_skins 1", "br_dropped_knife_premium 1", "br_player_music_kit 4", "bot_aim head", "bot_nades max",
      "unbind \\", 'bind kp_end "subclass_create 507;subclass_create 515"',
    ]);
    expect(text("dialog .bm-facts")).toContain("overrides/botprofile.vpk with the mod's high profile (overrides/High/botprofile.vpk); it is medium now");
    expect(text("dialog .bm-facts")).toContain("Launch options after -insecure: +exec botmode -novid");
    expect(writes()).toEqual([]);
    await click(button("Apply"));
    expect(calls.filter(([c]) => writes().includes(c))).toEqual([
      ["botmode_set_server_cfg", {
        patch: { cosmetics: { droppedKnifeSkins: true, droppedKnifePremium: true, musicKit: 4 }, botAim: "head", botNades: "max", knifeBind: { key: "kp_end", knives: [507, 515] } },
        seen: { cosmetics: { droppedKnifeSkins: true, droppedKnifePremium: false, musicKit: 3 }, botAim: null, botNades: "more", knifeBind: null, unboundKeys: [] },
      }],
      ["botmode_set_difficulty", { level: "high", seen: { sha256: sha256Before } }],
      ["botmode_set_launch_options", { options: "+exec botmode -novid", seen: "+exec botmode" }],
    ]);
    expect(dialog()).toBeNull();
    expect(text(".bm-foot__state")).toBe("Saved in the game folder");
    expect(Array.from(document.querySelectorAll(".seg__item[data-on='true']"), (x) => x.textContent)).toEqual(["Head", "Max", "High"]);
    expect(text(".bm-knifepick")).toContain("In game, kp_end spawns the lit knives");
    expect(Array.from(document.querySelectorAll(".bm-hist__what b"), (b) => b.textContent).slice(0, 2)).toEqual(["Bot difficulty high", "Settings"]);
  }, 15_000);

  it("a knife key the backend would refuse blocks Apply and says why", async () => {
    await render("installed");
    type($<HTMLInputElement>(".bm-key")!, "a;b");
    expect(text(".bm-foot__state")).toBe('"a;b" isn\'t a key name. Use one character or a name such as mouse4 or kp_end.');
    expect(button("Apply changes…").disabled).toBe(true);
    expect(button(/Launch Bot Mode/).disabled).toBe(true);
  });

  it("a stale read writes nothing, says why, and shows the current values; applying again goes through", async () => {
    await render("installed");
    await click(box("Give dropped knives"));
    // another tool changes the music kit after the change was made
    backend.state.status.cosmetics = { ...backend.state.status.cosmetics, musicKit: 5 };
    await click(button("Apply changes…"));
    await click(button("Apply"));
    expect(text("dialog [role=alert]")).toMatch(/^Nothing was saved\. Server cfg settings refused: .*changed since it was read.*Another program changed that file after you made your changes/);
    expect(backend.state.status.cosmetics).toMatchObject({ droppedKnifeSkins: true, musicKit: 5 });
    expect(text(".bm-kit")).toBe("InsurgencyRobert Allaire");
    expect(text(".bm-foot__state")).toBe("1 unsaved change");
    await click(button("Apply"));
    expect(sent("botmode_set_server_cfg")).toEqual({
      patch: { cosmetics: { droppedKnifeSkins: false, droppedKnifePremium: false, musicKit: 5 } },
      seen: { cosmetics: { droppedKnifeSkins: true, droppedKnifePremium: false, musicKit: 5 }, botAim: null, botNades: "more", knifeBind: null, unboundKeys: [] },
    });
    expect(backend.state.status.cosmetics.droppedKnifeSkins).toBe(false);
  });

  it("while CS2 runs, changes are kept and go in first when Bot Mode is next launched", async () => {
    await render("cs2-running");
    await click(button("High"));
    expect(text(".bm-foot__state")).toBe("CS2 is running. Close it to change game files. Your 1 change is kept and applies when you launch Bot Mode from here, or with Apply once CS2 has closed.");
    expect(button("Apply changes…").disabled).toBe(true);
    // kept across a visit to another page
    act(() => root.render(<div />));
    act(() => root.render(<DataValue value={data()}><BarProvider><BotModeView /></BarProvider></DataValue>));
    await settle();
    expect(text(".bm-foot__state")).toContain("Your 1 change is kept");
    // CS2 closes
    backend.state.status = { ...backend.state.status, cs2Running: false };
    backend.state.running = [];
    await click(button(/Check again/));
    await click(button(/Launch Bot Mode/));
    expect(text("dialog")).toContain("First, your 1 kept change:");
    expect(text("dialog")).toContain("overrides/botprofile.vpk with the mod's high profile");
    expect(writes()).toEqual([]);
    await click(button("Launch with -insecure"));
    expect(writes()).toEqual(["botmode_set_difficulty", "botmode_launch"]);
    expect(localStorage.getItem("cs2stats.botmode.pending")).toBeNull();
  });

  it("a change kept while CS2 ran is refused if the file it was previewed against changed meanwhile", async () => {
    await render("cs2-running");
    await click(button("High"));
    // another tool replaces the active bot profile before the next launch
    backend.state.status = { ...backend.state.status, cs2Running: false, activeProfile: "f".repeat(64) };
    backend.state.running = [];
    await click(button(/Check again/));
    await click(button(/Launch Bot Mode/));
    await click(button("Launch with -insecure"));
    expect(text("dialog [role=alert]")).toMatch(/^Nothing was saved\. Bot difficulty refused: overrides\/botprofile\.vpk: changed since it was read/);
    expect(sent("botmode_set_difficulty")).toEqual({ level: "high", seen: { sha256: mockCall("installed").state.status.activeProfile } });
    expect(writes()).toEqual(["botmode_set_difficulty"]);
    expect(backend.state.status.activeProfile).toBe("f".repeat(64));
    // previewed again against the file as it is now, the user confirms and it goes through
    await click(button("Launch with -insecure"));
    expect(sent("botmode_set_difficulty")).toEqual({ level: "high", seen: { sha256: "f".repeat(64) } });
    expect(writes()).toEqual(["botmode_set_difficulty", "botmode_set_difficulty", "botmode_launch"]);
  });

  it("the launch confirmation shows the command with the kept launch options", async () => {
    await render("cs2-running");
    type($<HTMLInputElement>("#bm-launch-opts")!, "-novid -tickrate 128");
    backend.state.status = { ...backend.state.status, cs2Running: false };
    backend.state.running = [];
    await click(button(/Check again/));
    await click(button(/Launch Bot Mode/));
    expect(text("dialog .bm-line")).toBe("steam.exe -applaunch 730 -insecure -novid -tickrate 128 then Steam's own -novid -fullscreen -w 1280 -h 960");
    expect(text(".bm-hero .bm-line")).toContain("-insecure -novid -tickrate 128 then");
  });

  it("a setting put back to its saved value is no change, and leaves no stale baseline", async () => {
    await render("installed");
    await click(button("High"));
    await click(button("Medium"));
    expect(text(".bm-foot__state")).toBe("Saved in the game folder");
    expect(localStorage.getItem("cs2stats.botmode.pending")).toBeNull();
    // another tool sets High; the page shows it, not an old draft
    backend.state.status = { ...backend.state.status, difficulty: "high", activeProfile: "f".repeat(64) };
    await click(button(/Check again/));
    expect(text(".seg__item[data-on='true'][data-v='high']")).toBe("High");
    expect(text(".bm-foot__state")).toBe("Saved in the game folder");
  });

  it("a partial apply names what was saved and what was refused", async () => {
    await render("installed");
    await click(button("Head"));
    await click(button("High"));
    type($<HTMLInputElement>("#bm-launch-opts")!, "-novid");
    // another tool replaces the profile after the changes were made
    backend.state.status.activeProfile = "f".repeat(64);
    await click(button("Apply changes…"));
    await click(button("Apply"));
    expect(text("dialog [role=alert]")).toMatch(/^Server cfg settings saved\. Bot difficulty refused: overrides\/botprofile\.vpk: changed since it was read.*\. Launch options not saved: the apply stopped at the refusal\./);
    expect(backend.state.server.botAim).toBe("head");
    expect(writes()).toEqual(["botmode_set_server_cfg", "botmode_set_difficulty"]);
    // what was saved is no longer a change; the other two still wait
    expect(text(".bm-foot__state")).toBe("2 unsaved changes");
  });

  it("a kept edit that the files now hold is dropped when the page reads them again", async () => {
    await render("cs2-running");
    await click(button("High"));
    expect(localStorage.getItem("cs2stats.botmode.pending")).toContain("high");
    // set to High elsewhere
    backend.state.status = { ...backend.state.status, difficulty: "high", activeProfile: "f".repeat(64) };
    await click(button(/Check again/));
    expect(localStorage.getItem("cs2stats.botmode.pending")).toBeNull();
    expect(text(".bm-foot__state")).toBe("CS2 is running. Close it to change game files.");
  });

  it("kept changes with a server cfg that can't be read block the launch, with a retry", async () => {
    await render("cs2-running", {});
    await click(button("High"));
    backend.state.status = { ...backend.state.status, cs2Running: false };
    backend.state.running = [];
    const fail: Record<string, string> = { botmode_server_cfg: "cfg/gamemode_competitive_server.cfg: access denied" };
    mockIPC((cmd, args) => {
      calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
      if (fail[cmd]) return Promise.reject(fail[cmd]);
      return backend(cmd, args as Record<string, unknown>);
    });
    await click(button(/Check again/));
    expect(button(/Launch Bot Mode/).disabled).toBe(true);
    expect(text("#bm-launch-why")).toMatch(/^You have kept changes, but the server cfg could not be read/);
    delete fail.botmode_server_cfg;
    await click(document.querySelector<HTMLButtonElement>("#bm-launch-why button")!);
    expect(button(/Launch Bot Mode/).disabled).toBe(false);
    expect(writes()).toEqual([]);
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
  });

  it("shows the backend's refusal as it is, and Discard puts the read values back", async () => {
    await render("installed");
    type($<HTMLInputElement>("#bm-launch-opts")!, "-novid -secure");
    await click(button("Apply changes…"));
    await click(button("Apply"));
    expect(text("dialog [role=alert]")).toBe("Nothing was saved. Launch options refused: launch options contain -secure, which turns VAC on; Bot Mode only starts CS2 with -insecure.");
    expect(backend.state.status.launchOptions).toBe("+exec botmode");
    await click(button("Cancel"));
    await click(button("Discard"));
    expect($<HTMLInputElement>("#bm-launch-opts")!.value).toBe("+exec botmode");
  });
});

describe("actions wait for a confirmation that lists their files", () => {
  const cancelByEscape = async () => { act(() => { dialog()!.dispatchEvent(new Event("cancel", { cancelable: true })); }); await settle(); };

  it("launch: says it starts CS2 with -insecure and changes gameinfo.gi; Cancel and Escape start nothing", async () => {
    await render("installed");
    await click(button(/Launch Bot Mode/));
    expect(text(".bm-dialog__title")).toBe("Start CS2 in Bot Mode?");
    expect(text(".bm-dialog__lead")).toContain("CS2 starts with -insecure, which turns VAC off for this session.");
    expect(text("dialog .bm-facts")).toContain("gameinfo.gi: two search paths turn Bot Mode on.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(button("Cancel"));
    expect(dialog()).toBeNull();
    // focus goes back to the button that opened it (a pointer click focuses it first, as a browser does)
    button(/Launch Bot Mode/).focus();
    await click(button(/Launch Bot Mode/));
    await click(button("Cancel"));
    expect(document.activeElement).toBe(button(/Launch Bot Mode/));
    await click(button(/Launch Bot Mode/));
    await cancelByEscape();
    expect(dialog()).toBeNull();
    expect(writes()).toEqual([]);
    await click(button(/Launch Bot Mode/));
    await click(button("Launch with -insecure"));
    expect(writes()).toEqual(["botmode_launch"]);
    expect(text("#bm-state")).toBe("In session");
  });

  it("update: downloads into the app folder, lists every file and the builds it replaces, and keeps them in view after", async () => {
    await render("outdated");
    await click(button("Update to v1.4.7…"));
    expect(writes()).toEqual(["botmode_download"]);
    expect(text("dialog .bm-files-more summary")).toBe("Show all 566 files");
    expect(dialog()!.querySelectorAll(".bm-files li")).toHaveLength(566);
    expect(text("dialog .bm-facts")).toContain("Your builds of BotRandomizer, BotState, BotBuy, BotMatchStats with the release's");
    await click(button("Update to v1.4.7"));
    expect(writes()).toEqual(["botmode_download", "botmode_install"]);
    expect(text(".bm-install [role=status]")).toBe("The install replaced your builds of BotRandomizer, BotState, BotBuy, BotMatchStats. Apply your builds to put them back.");
    // applying them lists, per build, where each file goes
    await click(button("Apply your builds…"));
    expect(Array.from(dialog()!.querySelectorAll("dt"), (d) => d.textContent).slice(0, 4)).toEqual(["BotRandomizer", "BotState", "BotBuy", "BotMatchStats"]);
    expect(text("dialog .bm-facts")).toContain("addons/counterstrikesharp/plugins/BotRandomizer/BotRandomizer.dll");
    await click(button("Apply builds"));
    expect(writes().at(-1)).toBe("botmode_overlay");
    expect(text(".bm-install")).not.toContain("The install replaced your builds");
  });

  it("a read that a launch overtook can't put back the state from before it", async () => {
    await render("installed");
    // the next status read is slow, and answers with the state before the launch
    let release!: () => void;
    const before = structuredClone(backend.state.status);
    let held = false;
    mockIPC((cmd, args) => {
      calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
      if (cmd === "botmode_status" && !held) { held = true; return new Promise((r) => { release = () => r(before); }); }
      return backend(cmd, args as Record<string, unknown>);
    });
    await click(button(/Check again/));
    await click(button(/Launch Bot Mode/));
    await click(button("Launch with -insecure"));
    expect(text("#bm-state")).toBe("In session");
    await act(async () => { release(); });
    await settle();
    expect(text("#bm-state")).toBe("In session");
  });

  it("builds: an overlay.json edited after the preview is refused, shown again, then applied as shown", async () => {
    await render("installed");
    await click(button("Apply your builds…"));
    const previewed = backend.state.manifestSha;
    backend.state.manifestSha = "e".repeat(64);
    await click(button("Apply builds"));
    expect(sent("botmode_overlay")).toMatchObject({ previewed });
    expect(text("dialog [role=alert]")).toMatch(/^overlay\.json changed after this list was shown, so nothing was copied/);
    expect(calls.filter(([c]) => c === "botmode_overlay_plan")).toHaveLength(2);
    await click(button("Apply builds"));
    expect(sent("botmode_overlay")).toMatchObject({ previewed: "e".repeat(64) });
    expect(dialog()).toBeNull();
  });

  it("undo and roll back can't be confirmed until the change's file list has loaded", async () => {
    await render("installed", { botmode_change_files: "entries.jsonl: access denied" });
    await click(button("Undo…"));
    expect(text("dialog .bm-facts")).toContain("entries.jsonl: access denied");
    expect(button("Undo").disabled).toBe(true);
    await click(button("Cancel"));
    // a list still loading: the confirm waits for it
    let release!: (v: string[]) => void;
    mockIPC((cmd, args) => {
      calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
      if (cmd === "botmode_change_files") return new Promise<string[]>((r) => { release = r; });
      return backend(cmd, args as Record<string, unknown>);
    });
    await click(button("Undo…"));
    expect(button("Undo").disabled).toBe(true);
    await act(async () => { release(["cfg/gamemode_competitive_server.cfg"]); });
    await settle();
    expect(button("Undo").disabled).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("the change Undo would take off shows even past the first five", async () => {
    await render("installed");
    const undone = Array.from({ length: 6 }, (_, i) => ({ ...backend.state.status.backups[0], seq: 40 + i, id: `00${40 + i}-x-cosmetics`, status: "rolledBack" as const }));
    backend.state.status.backups = [...undone, ...backend.state.status.backups];
    await click(button(/Check again/));
    expect(document.querySelectorAll(".bm-hist li")).toHaveLength(6);
    expect(text(".bm-hist li:last-child")).toMatch(/^Settings.*Undo…$/);
  });

  it("repair is offered for a missing mod cfg, not for the user's own values", async () => {
    await render("installed");
    expect(() => button(/^Repair/)).toThrow();
    backend.state.status.components = backend.state.status.components.map((c) => (c.name === "Mod cfgs" ? { ...c, missing: ["cfg/bot_buy.cfg"] } : c));
    await click(button(/Check again/));
    expect(button("Repair: reinstall v1.4.7…").disabled).toBe(false);
  });

  it("undo: the newest change, one button away, its files listed from its journal", async () => {
    await render("installed");
    const newest = backend.state.status.backups[0];
    await click(button("Undo…"));
    expect(text(".bm-dialog__title")).toBe("Undo settings?");
    expect(Array.from(dialog()!.querySelectorAll(".bm-files li"), (li) => li.textContent)).toEqual(["cfg/gamemode_competitive_server.cfg"]);
    expect(writes()).toEqual([]);
    await click(button("Undo"));
    expect(sent("botmode_rollback")).toMatchObject({ id: newest.id });
    expect(text(".bm-hist li")).toContain("undone");
  });

  it("an interrupted change: rolls back exactly that one, its files listed", async () => {
    await render("unfinished");
    const id = backend.state.status.unfinished!.id;
    await click(button("Roll back the change…"));
    expect(text("dialog .bm-facts")).toContain(id);
    expect(dialog()!.querySelectorAll(".bm-files li")).toHaveLength(212);
    await click(button("Roll back"));
    expect(sent("botmode_rollback")).toMatchObject({ id });
    expect(text("#bm-state")).toBe("Ready");
  });

  it("an install that fails keeps its dialog open with the backend's reason", async () => {
    await render("not-installed", { botmode_install: "CS2 is running. Close it first: Bot Mode never changes game files while the game is open." });
    await click(button("Install v1.4.7…"));
    await click(button("Install v1.4.7"));
    expect(text("dialog [role=alert]")).toBe("CS2 is running. Close it first: Bot Mode never changes game files while the game is open.");
  });

  it("opened from the keyboard, a dialog appears without motion", async () => {
    await render("installed");
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
    for (const b of document.querySelectorAll<HTMLButtonElement>(".bm-actions button, .bm-launch, .bm-hist button")) expect(b.disabled, b.textContent ?? "").toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe("console commands", () => {
  it("loads only when asked, at the installed tag, filters, and copies a command or a team's lineup", async () => {
    await render("installed");
    expect(calls.some(([c]) => c === "botmode_mod_commands")).toBe(false);
    await click(button("Show the commands"));
    expect(sent("botmode_mod_commands")).toEqual({ tag: "v1.4.7" });
    expect(Array.from(document.querySelectorAll(".bm-cmds__group h3"), (h) => h.textContent)).toEqual(["Game mode", "Bot aim style", "Bot management", "Coordinated buy"]);
    type($<HTMLInputElement>(".bm-cmds__find input")!, "vita");
    expect(Array.from(document.querySelectorAll(".bm-team"), (t) => t.textContent)).toEqual(["Team Vitality"]);
    await click(button("CT"));
    expect(copied.at(-1)).toMatch(/^bot_add_ct "apEX";.*mp_teamname_1 Team Vitality$/);
    type($<HTMLInputElement>(".bm-cmds__find input")!, "bot_aim h");
    await click(button("bot_aim head"));
    expect(copied.at(-1)).toBe("bot_aim head");
  });
});

describe("keys Bot Mode keeps unbound", () => {
  it("moving the knife key off \\ keeps \\ unbound; Stop unbinding takes a key back, previewed first", async () => {
    await render("installed");
    expect($(".bm-unbound")).toBeNull();
    type($<HTMLInputElement>(".bm-key")!, "k");
    await click(button("Apply changes…"));
    expect(Array.from(dialog()!.querySelectorAll(".bm-files li"), (li) => li.textContent)).toEqual(["unbind \\", 'bind k "' + Array.from({ length: 20 }, (_, i) => `subclass_create ${[500, 503, 505, 506, 507, 508, 509, 512, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 525, 526][i]}`).join(";") + '"']);
    await click(button("Apply"));
    expect(Array.from(document.querySelectorAll(".bm-unbound li .kbd"), (k) => k.textContent)).toEqual(["\\"]);
    // k -> l: k joins, \ stays
    type($<HTMLInputElement>(".bm-key")!, "l");
    await click(button("Apply changes…"));
    await click(button("Apply"));
    expect(Array.from(document.querySelectorAll(".bm-unbound li .kbd"), (k) => k.textContent)).toEqual(["\\", "k"]);
    // a launch that fails takes nothing out
    backend.state.status.cs2Running = false;
    await act(async () => {});
    await click(button(/Launch Bot Mode/));
    mockIPC((cmd, args) => {
      calls.push([cmd, (args ?? {}) as Record<string, unknown>]);
      if (cmd === "botmode_launch") return Promise.reject("Steam did not start CS2");
      return backend(cmd, args as Record<string, unknown>);
    });
    await click(button("Launch with -insecure"));
    expect(text("dialog [role=alert]")).toBe("Steam did not start CS2");
    await click(button("Cancel"));
    await click(button(/Check again/));
    expect(Array.from(document.querySelectorAll(".bm-unbound li .kbd"), (k) => k.textContent)).toEqual(["\\", "k"]);
    // the user takes k back
    await click($<HTMLButtonElement>("button[aria-label='Stop unbinding k']")!);
    expect(text(".bm-unbound li[data-leaving='true']")).toContain("Unbinding stops when you apply");
    await click(button("Apply changes…"));
    expect(text("dialog .bm-facts")).toContain("Takes out:unbind k");
    await click(button("Apply"));
    expect(sent("botmode_set_server_cfg")).toMatchObject({ patch: { stopUnbinding: ["k"] } });
    expect(Array.from(document.querySelectorAll(".bm-unbound li .kbd"), (k) => k.textContent)).toEqual(["\\"]);
  });
});

describe("console commands after an update", () => {
  it("starts over for the new tag, and a load that fails ends in an error with a retry", async () => {
    await render("outdated", { botmode_mod_commands: "https://api.github.com/repos/ed0ard/CS2-Bot-Improver/contents/Commands.txt?ref=v1.4.6: timeout: global" });
    await click(button("Show the commands"));
    expect(sent("botmode_mod_commands")).toEqual({ tag: "v1.4.6" });
    expect(text(".bm-cmds [role=alert]")).toContain("The list didn't load: https://api.github.com/repos/ed0ard/CS2-Bot-Improver/contents/Commands.txt?ref=v1.4.6: timeout: global");
    expect(button("Try again")).toBeTruthy();
    await click(button("Update to v1.4.7…"));
    await click(button("Update to v1.4.7"));
    // the card for v1.4.7 is a new one: nothing loaded, nothing failed
    expect(text(".bm-cmds .card__aside")).toBe("The mod's Commands.txt at v1.4.7");
    expect($(".bm-cmds [role=alert]")).toBeNull();
    expect(button("Show the commands")).toBeTruthy();
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
