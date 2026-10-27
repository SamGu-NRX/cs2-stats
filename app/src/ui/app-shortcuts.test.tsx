// @vitest-environment jsdom
// The shell's global shortcuts, driven through App's own keydown listener (App.tsx Body). The views
// are stubs: this file checks where a shortcut navigates, not what the page draws.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { App } from "./App";
import { go, parseHash, PROFILE_TABS } from "./router";

vi.mock("./data/provider", () => ({
  DataProvider: ({ children }: { children: ReactNode }) => children,
  useData: () => ({ status: "ready", error: null, matches: [], you: [], refresh() {}, meta: {}, progress: null, lastSync: null }),
}));
vi.mock("./data/packs", () => ({ usePros: () => ({ state: "missing" }), useAgents: () => null }));
vi.mock("./data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useRatings: () => ({ data: null, error: null, loading: false }),
  useYourQuery: () => null,
}));
vi.mock("./views/Profile", () => ({ default: ({ tab }: { tab: string }) => <p data-profile={tab} /> }));
vi.mock("./views/Home", () => ({ HomeView: () => <p data-home /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= function () {};
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
