// @vitest-environment jsdom
// The shell's global shortcuts, driven through App's own keydown listener (App.tsx Body). The views
// are stubs: this file checks where a shortcut navigates, not what the page draws.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { App } from "./App";
import { go, openMatch, parseHash, PROFILE_TABS } from "./router";
import { NAV } from "./shell/Sidebar";

vi.mock("./data/provider", () => ({
  DataProvider: ({ children }: { children: ReactNode }) => children,
  useData: () => ({ status: "ready", error: null, matches: [], you: [], fileErrors: [], refresh() {}, meta: {}, progress: null, lastSync: null }),
}));
vi.mock("./data/packs", () => ({ usePros: () => ({ state: "missing" }), useAgents: () => null }));
vi.mock("./data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useRatings: () => ({ data: null, error: null, loading: false }),
  useYourQuery: () => null,
}));
vi.mock("./views/Profile", () => ({ default: ({ tab }: { tab: string }) => <p data-profile={tab} /> }));
vi.mock("./views/Home", () => ({ HomeView: () => <p data-home /> }));
// every page a test here opens is a stub: a real lazy page (App.tsx) would keep loading its modules after
// the test ends, into the next test file's fresh module registry, before that file's vi.mock calls apply
vi.mock("./views/Clips", () => ({ default: () => <p data-clips /> }));
vi.mock("./views/match/MatchView", () => ({ default: () => <p data-match /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= function () {};
// jsdom has no PointerEvent; the tooltip layer checks for one on every focus (components/overlay.tsx)
globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
globalThis.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  act(() => go("#/"));
});

describe("Alt+1 to Alt+7 on Profile", () => {
  it("opens each tab and keeps the map, matches, side and comparison, leaving the tab's own keys behind", async () => {
    // fails if the shortcut drops the page's scope (#39 review), or carries a section or attribute
    act(() => go("#/profile/overview?map=de_dust2&n=10&side=t&cmp=bots&sec=style&attr=entrying"));
    await act(async () => root.render(<App />));
    const scope = { map: "de_dust2", n: "10", side: "t", cmp: "bots" };
    for (const [i, tab] of PROFILE_TABS.entries()) {
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: String(i + 1), altKey: true, bubbles: true })); });
      const r = parseHash(location.hash);
      expect([r.ptab, Object.fromEntries(r.query)], tab).toEqual([tab, scope]);
    }
  });
});

describe("a new page", () => {
  it("moves focus to the pane, named for the page, and leaves focus alone on the first page", async () => {
    // fails if keyboard and screen-reader users stay on the sidebar link after a page change, or the
    // first page load takes focus away from where the browser put it
    const before = document.body.appendChild(document.createElement("button"));
    before.focus();
    await act(async () => root.render(<App />));
    expect(document.activeElement).toBe(before);
    const side = host.querySelector<HTMLElement>('a[data-page="profile"]')!;
    side.focus();
    expect(document.activeElement).toBe(side);
    await act(async () => { go("#/profile/overview"); });
    const pane = host.querySelector("main.pane");
    expect(document.activeElement).toBe(pane);
    expect(pane?.getAttribute("aria-label")).toBe("Profile");
  });
});

describe("a click while a match opens", () => {
  it("reaches its target while the match page is still fading in", async () => {
    // fails if opening a match hands the page to a View Transition: the browser drops every click on the
    // page while one runs, and the stub here, like the browser, holds the new page back until it ends
    const transition = vi.fn(() => ({ finished: new Promise(() => {}) }));
    Object.assign(document, { startViewTransition: transition });
    // motion allowed: with reduced motion the old morph never ran, so it would not show here
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    try {
      await act(async () => root.render(<App />));
      // the match page's code is loaded once, as it is after the first match a session opens
      await act(async () => { go("#/match/a.json.gz/overview"); });
      await act(async () => { go("#/"); });
      window.dispatchEvent(new Event("pointerdown"));
      act(() => openMatch("#/match/a.json.gz/overview"));
      expect(transition).not.toHaveBeenCalled();
      // the page is there and its fade is running
      expect(host.querySelector("[data-match]")?.closest(".view-in")).not.toBeNull();
      const changed = new Promise((r) => addEventListener("hashchange", r, { once: true }));
      await act(async () => { host.querySelector<HTMLAnchorElement>('a[data-page="profile"]')!.click(); await changed; });
      expect(parseHash(location.hash).page).toBe("profile");
      expect(host.querySelector("[data-profile]")).not.toBeNull();
    } finally {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
      vi.unstubAllGlobals();
    }
  });
});

describe("shortcuts while a confirmation is open", () => {
  it("navigate nowhere until the dialog closes", async () => {
    Element.prototype.scrollTo ??= () => {};
    // fails if Ctrl+1 can leave Bot Mode with a confirmation open or its action running (#47 review)
    act(() => go("#/profile/overview"));
    await act(async () => root.render(<App />));
    const dialog = document.body.appendChild(document.createElement("dialog"));
    dialog.setAttribute("open", "");
    const ctrl = (key: string) => act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true })); });
    ctrl("1");
    expect(parseHash(location.hash).page).toBe("profile");
    // Ctrl+R would reload the window under the confirmation: its default is held back
    const reload = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(reload); });
    expect(reload.defaultPrevented).toBe(true);
    dialog.remove();
    ctrl("1");
    expect(parseHash(location.hash).page).toBe("home");
  });
});

describe("Ctrl and a digit", () => {
  it("opens each sidebar page by its key, Clips on Ctrl+5 after Bot Mode's Ctrl+4", async () => {
    // fails if Clips and Bot Mode share a key, or Ctrl+5 is not handled
    Element.prototype.scrollTo ??= () => {};
    act(() => go("#/profile/overview"));
    await act(async () => root.render(<App />));
    expect(NAV.map((n) => [n.page, n.key])).toEqual([["home", "1"], ["matches", "2"], ["profile", "3"], ["botmode", "4"], ["clips", "5"]]);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "5", ctrlKey: true, bubbles: true })); });
    expect(parseHash(location.hash).page).toBe("clips");
    expect(host.querySelector("[data-clips]")).not.toBeNull();
  });
});
