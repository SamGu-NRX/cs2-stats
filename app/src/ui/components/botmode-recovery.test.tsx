// @vitest-environment jsdom
// The Bot Mode recovery prompt over a mocked Tauri invoke (Tauri's own mockIPC), so the prompt
// goes through the real typed wrappers in botmode/commands.ts and every argument the backend would
// receive is checked. Everything renders under StrictMode, as the app does. Nothing here reaches a
// game folder: the only backend is the mock.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Recovery } from "../../botmode/commands";
import { setHidePersonal } from "../data/privacy";
import { BotModeRecovery } from "./BotModeRecovery";
import { ToastLayer } from "./overlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROMPT = "Bot Mode is on after CS2 Stats closed unexpectedly. If you didn't turn it on with another tool, turn it off.";
const CHANGED = "gameinfo.gi changed after CS2 Stats asked about it, so Bot Mode was not changed. Check Bot Mode again before turning it off.";
const FILE = String.raw`C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\gameinfo.gi`;
const asked = (hash: string): Recovery => ({ message: PROMPT, file: FILE, hash });
const view = (recovery: Recovery | null) => ({ supervised: false, status: null, notice: null, recovery });
const answered = (a: Record<string, unknown>) => ({ change: null, message: a.action === "off" ? "Bot Mode is off." : "Bot Mode was not changed." });

let root: Root;
let el: HTMLDivElement;
/** every recover call, with its arguments */
let answers: Record<string, unknown>[];
let sessionCalls: number;

beforeEach(() => {
  localStorage.clear();
  answers = [];
  sessionCalls = 0;
  el = document.body.appendChild(document.createElement("div"));
  root = createRoot(el);
});
afterEach(async () => {
  // the toast store lives for the app's life: close what a test left showing
  for (const b of document.querySelectorAll<HTMLButtonElement>(".toast__close")) act(() => b.click());
  await wait(200);
  act(() => root.unmount());
  el.remove();
  clearMocks();
  act(() => { setHidePersonal(false); });
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function settle() {
  for (let i = 0; i < 6; i++) await wait(0);
}

/** A promise the test settles by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

/**
 * The app's layers over a backend. botmode_session answers `before` until the first recover call
 * and `after` from then on (an Error rejects); `recover` answers botmode_recover.
 */
async function start(before: Recovery | null, recover: (args: Record<string, unknown>) => unknown = answered, after: Recovery | null | Error = before) {
  mockIPC((cmd, args) => {
    if (cmd === "botmode_session") {
      sessionCalls++;
      const s = answers.length ? after : before;
      if (s instanceof Error) throw s.message;
      return view(s);
    }
    if (cmd === "botmode_recover") {
      answers.push({ ...(args as Record<string, unknown>) });
      return recover(args as Record<string, unknown>);
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  act(() => root.render(<StrictMode><main tabIndex={-1} /><ToastLayer /><BotModeRecovery /></StrictMode>));
  await settle();
}

const buttons = (scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLButtonElement>("button"));
const button = (label: string, scope: ParentNode = document) => {
  const b = buttons(scope).find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"; buttons: ${buttons(scope).map((x) => x.textContent || x.getAttribute("aria-label")).join(" | ")}`);
  return b;
};
const prompts = () => Array.from(document.querySelectorAll(".toast:not(.is-out)")).filter((t) => t.textContent?.includes(PROMPT));
const prompt = () => prompts()[0] ?? null;
const dialog = () => document.querySelector<HTMLDialogElement>("dialog.dialog");
const toastTexts = () => Array.from(document.querySelectorAll(".toast__text"), (t) => t.textContent);
const press = async (b: HTMLButtonElement) => { act(() => b.click()); await settle(); };
const escape = async (d: HTMLDialogElement) => { act(() => { d.dispatchEvent(new Event("cancel", { cancelable: true })); }); await settle(); };

it("asks once at startup, even with StrictMode running the effect twice", async () => {
  await start(asked("h1"));
  expect(sessionCalls, "StrictMode ran the startup check twice").toBe(2);
  expect(prompts()).toHaveLength(1);
  const p = prompt()!;
  expect(p.closest("[role=alert]"), "announced").not.toBeNull();
  expect(buttons(p).map((b) => b.textContent)).toEqual(["Turn off Bot Mode", "Leave it on", ""]);
});

it("turns Bot Mode off only after a confirmation that names the file, then gives the focus to the page", async () => {
  act(() => { setHidePersonal(true); });
  await start(asked("h1"));
  const opener = button("Turn off Bot Mode", prompt()!);
  opener.focus();
  await press(opener);
  const d = dialog()!;
  expect(d.open).toBe(true);
  expect(d.textContent).toContain("<path>");
  expect(document.body.innerHTML, "the folder is hidden with personal info hidden").not.toContain("steamapps");
  expect(document.activeElement).toBe(button("Cancel", d));
  expect(answers).toEqual([]);

  // Cancel closes it unanswered, and the focus goes back to the prompt's button
  await press(button("Cancel", d));
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(button("Turn off Bot Mode", prompt()!));

  await press(button("Turn off Bot Mode", prompt()!));
  await press(button("Turn off Bot Mode", dialog()!));
  expect(answers).toEqual([{ action: "off", expectHash: "h1" }]);
  expect(dialog()).toBeNull();
  // the prompt's button is on its way out; the focus is on the page, not lost with it
  expect(document.activeElement).toBe(document.querySelector("main"));
  await wait(200);
  expect(prompt(), "answered, so gone").toBeNull();
  expect(toastTexts()).toContain("Bot Mode is off.");
});

it("leaves Bot Mode on without a confirmation, since nothing is written", async () => {
  await start(asked("h1"));
  await press(button("Leave it on", prompt()!));
  expect(answers).toEqual([{ action: "leave" }]);
  expect(dialog()).toBeNull();
  await wait(200);
  expect(prompt()).toBeNull();
  expect(toastTexts()).toContain("Bot Mode was not changed.");
});

it("runs one answer at a time", async () => {
  const leaving = deferred<unknown>();
  await start(asked("h1"), (a) => (a.action === "leave" ? leaving.promise : answered(a)));
  const leaveButton = button("Leave it on", prompt()!);
  // two presses in the same frame: the second is refused before any re-render
  act(() => { leaveButton.click(); leaveButton.click(); });
  await settle();
  expect(answers).toEqual([{ action: "leave" }]);
  expect(buttons(prompt()!).filter((b) => b.disabled).map((b) => b.textContent)).toEqual(["Turn off Bot Mode", "Leave it on"]);
  // the confirmation cannot open while the answer is in flight
  act(() => { button("Turn off Bot Mode", prompt()!).click(); });
  await settle();
  expect(dialog()).toBeNull();
  await act(async () => { leaving.resolve(answered({ action: "leave" })); });
  await settle();
  expect(answers).toHaveLength(1);
});

it("keeps the confirmation open on Escape while turning off is in flight, and closes it otherwise", async () => {
  const off = deferred<unknown>();
  await start(asked("h1"), () => off.promise);
  await press(button("Turn off Bot Mode", prompt()!));
  await escape(dialog()!);
  expect(dialog(), "Escape cancels").toBeNull();
  expect(prompt()).not.toBeNull();

  await press(button("Turn off Bot Mode", prompt()!));
  await press(button("Turn off Bot Mode", dialog()!));
  await escape(dialog()!);
  expect(dialog(), "not while the answer is in flight").not.toBeNull();
  expect(button("Cancel", dialog()!).disabled).toBe(true);
  expect(buttons(prompt()!).filter((b) => b.disabled)).toHaveLength(2);
  await act(async () => { off.resolve(answered({ action: "off" })); });
  await settle();
  expect(dialog()).toBeNull();
});

it("shows a refusal in the confirmation and asks about the file as it is now", async () => {
  let calls = 0;
  await start(asked("h1"), (a) => {
    if (calls++ === 0) throw CHANGED;
    return answered(a);
  }, asked("h2"));
  await press(button("Turn off Bot Mode", prompt()!));
  await press(button("Turn off Bot Mode", dialog()!));
  expect(dialog()!.querySelector("[role=alert]")!.textContent).toBe(CHANGED);
  expect(prompt(), "still asking").not.toBeNull();
  await press(button("Turn off Bot Mode", dialog()!));
  expect(answers).toEqual([{ action: "off", expectHash: "h1" }, { action: "off", expectHash: "h2" }]);
  expect(dialog()).toBeNull();
});

it("keeps the prompt when reading the state again fails, and shows that error with personal info hidden", async () => {
  act(() => { setHidePersonal(true); });
  const readFailed = new Error(String.raw`D:\Games\BotMatchStats\botmode\bot-mode-session.json: access denied`);
  await start(asked("h1"), () => { throw CHANGED; }, readFailed);
  await press(button("Turn off Bot Mode", prompt()!));
  await press(button("Turn off Bot Mode", dialog()!));
  const problem = dialog()!.querySelector("[role=alert]")!.textContent!;
  expect(problem).toContain(CHANGED);
  expect(problem).toContain("Reading Bot Mode's state again failed: <path>");
  expect(document.body.innerHTML).not.toContain("Games");
  expect(prompt(), "the controls stay").not.toBeNull();
  expect(button("Turn off Bot Mode", dialog()!).disabled).toBe(false);
  // the answer still names the hash the user was asked about
  await press(button("Turn off Bot Mode", dialog()!));
  expect(answers).toEqual([{ action: "off", expectHash: "h1" }, { action: "off", expectHash: "h1" }]);
});

it("asks nothing when no session died with Bot Mode on", async () => {
  await start(null);
  expect(prompt()).toBeNull();
  expect(document.querySelector(".toast")).toBeNull();
  expect(answers).toEqual([]);
});
