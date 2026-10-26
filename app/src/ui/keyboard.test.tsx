// @vitest-environment jsdom
// Keyboard contracts a mouse user never exercises: table rows, the row menu, the palette, opening
// a match without motion, and the spray gun picker. jsdom has no layout, so these check focus, events
// and state, not pixels.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./components/DataTable";
import { MenuLayer, openMenu } from "./components/overlay";
import { MATCH_TABS, matchTabOfKey, navWasInstant, openMatch, PROFILE_TABS } from "./router";
import type { Data } from "./data/provider";
import { Palette, SHORTCUTS } from "./shell/Palette";
import { NAV } from "./shell/Sidebar";
import { emptySummary } from "../stats/rollup";
import { CS2RB } from "../stats/model-params";
import { metaOf, rolled } from "../worker/views";
import type { Rolled } from "../worker/protocol";
import { setMeta } from "./data/meta";
import { AimPanels } from "./views/aim/AimPanels";

// The palette's data: no matches and no pro pack. The mock is typed against the provider's Data, so
// renaming a field the palette reads fails to compile here instead of failing at render (it once
// returned "summaries" after the provider had renamed it to "matches").
vi.mock("./data/provider", () => ({ useData: (): Pick<Data, "matches"> => ({ matches: [] }) }));
vi.mock("./data/packs", () => ({ usePros: () => ({ state: "missing" }), useAgents: () => null }));
// AimPanels' summaries: the worker's answer, set per test (no plugin file records sprays yet).
// One summary for every query, except a query for one gun alone, which gets that gun's own (perGun).
let scoped: Rolled | null = null;
let perGun: Record<string, Rolled> = {};
vi.mock("./data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useScoped: (_q: unknown, extra: { weapons?: string[] }[]) => (scoped ? extra.map((e) => (e.weapons?.length === 1 ? perGun[e.weapons[0]] ?? scoped! : scoped!)) : null),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = () => {}; // not in jsdom
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
// not in jsdom; the ids escaped here (data-v values, gun names) are plain words
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});
const render = (ui: JSX.Element) => act(() => root.render(ui));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(e); });
  return e;
};
const frame = () => act(() => new Promise((r) => setTimeout(r, 20)));

interface Row { id: string }
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
const table = (data: Row[], onOpen: (r: Row) => void, onRowContext?: (r: Row, at: { x: number; y: number }) => void) => (
  <DataTable<Row> label="Rows" rows={data} rowKey={(r) => r.id} onOpen={onOpen} onRowContext={onRowContext} maxHeight={400}
    columns={[{ key: "id", label: "Id", render: (r) => r.id }]} />
);

describe("table rows from the keyboard", () => {
  it("J and K move the active row and Enter opens it", () => {
    const onOpen = vi.fn();
    render(table(rows(5), onOpen));
    const body = host.querySelector("tbody")!;
    act(() => body.focus());
    key(body, "j"); key(body, "j"); key(body, "j"); key(body, "k");
    expect(host.querySelector('tr[data-active="true"]')?.getAttribute("data-i")).toBe("2");
    key(body, "Enter");
    expect(onOpen).toHaveBeenCalledWith({ id: "r2" });
  });
  it("Shift+F10 and the menu key open the active row's menu", () => {
    const onRowContext = vi.fn();
    render(table(rows(5), vi.fn(), onRowContext));
    const body = host.querySelector("tbody")!;
    act(() => body.focus());
    key(body, "j");
    expect(key(body, "F10", { shiftKey: true }).defaultPrevented).toBe(true);
    key(body, "j");
    key(body, "ContextMenu");
    expect(onRowContext.mock.calls.map((c) => c[0])).toEqual([{ id: "r1" }, { id: "r2" }]);
  });
  it("a right-click opens the menu of the row under the pointer", () => {
    const onRowContext = vi.fn();
    render(table(rows(5), vi.fn(), onRowContext));
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
    act(() => { host.querySelector('tr[data-i="3"] td')!.dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(true);
    expect(onRowContext).toHaveBeenCalledWith({ id: "r3" }, { x: 40, y: 50 });
  });
});

describe("row menu", () => {
  it("focuses its first item, skips disabled items, runs on Enter and gives focus back", () => {
    const run = vi.fn();
    render(<><button>opener</button><MenuLayer /></>);
    const opener = host.querySelector("button")!;
    act(() => opener.focus());
    act(() => openMenu({ x: 10, y: 10 }, [
      { label: "Open", run: vi.fn() }, { label: "Locked", run: vi.fn(), disabled: true }, { label: "Copy", run },
    ]));
    expect(document.activeElement?.textContent).toBe("Open");
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Copy");
    key(document.activeElement!, "Enter");
    expect(run).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("Esc closes it and gives focus back", () => {
    render(<><button>opener</button><MenuLayer /></>);
    const opener = host.querySelector("button")!;
    act(() => opener.focus());
    act(() => openMenu({ x: 10, y: 10 }, [{ label: "Open", run: vi.fn() }]));
    key(document.activeElement!, "Escape");
    expect(document.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("command palette", () => {
  it("is modal: focus starts in the search, Tab stays there, the app is inert, and focus returns on close", async () => {
    const onClose = vi.fn();
    const ui = (open: boolean) => <div className="shell"><button>opener</button><Palette open={open} onClose={onClose} actions={[]} /></div>;
    render(ui(false));
    const opener = host.querySelector("button")!;
    act(() => opener.focus());
    render(ui(true));
    await frame();
    const input = document.querySelector<HTMLInputElement>(".palette input")!;
    expect(document.activeElement).toBe(input);
    expect(host.querySelector(".shell")!.hasAttribute("inert")).toBe(true);
    expect(key(input, "Tab").defaultPrevented).toBe(true);
    expect(key(input, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    key(input, "Escape");
    expect(onClose).toHaveBeenCalled();
    render(ui(false));
    expect(host.querySelector(".shell")!.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe("opening a match", () => {
  const transition = vi.fn((cb: () => void) => { cb(); return { finished: Promise.resolve() }; });
  beforeEach(() => {
    transition.mockClear();
    Object.assign(document, { startViewTransition: transition });
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
  });
  it("from the keyboard is instant: no view transition, no view fade", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    openMatch("#/match/a.json.gz/overview");
    expect(location.hash).toBe("#/match/a.json.gz/overview");
    expect(transition).not.toHaveBeenCalled();
    expect(navWasInstant()).toBe(true);
  });
  it("from a click morphs through a view transition", () => {
    window.dispatchEvent(new Event("pointerdown"));
    openMatch("#/match/b.json.gz/overview");
    expect(location.hash).toBe("#/match/b.json.gz/overview");
    expect(transition).toHaveBeenCalledOnce();
  });
});

describe("spray gun picker", () => {
  it("lists every sprayed gun, most sprayed first, as one tab stop; arrows, Home and End pick and move focus", () => {
    setMeta(metaOf(CS2RB));
    // four guns fired; the deagle never sprayed, so it gets no button; the cz75a has no pro path and still lists
    const fired = ["ak47", "famas", "galilar", "cz75a", "deagle"];
    const sprays: Record<string, number> = { galilar: 60, famas: 50, ak47: 40, cz75a: 5, deagle: 0 };
    const s = rolled(emptySummary());
    for (const w of fired) s.weapons[w] = { rounds: 1, shots: 10, hits: 1, groups: [0, 0, 0, 0, 0, 0, 0, 0], dmg: 0, kills: 0, hsKills: 0, deaths: 0 };
    scoped = s;
    perGun = Object.fromEntries(fired.map((w) => {
      const g = rolled(emptySummary());
      g.aim.sprays = sprays[w];
      g.aim.path = sprays[w] ? { [w]: { n: [sprays[w], sprays[w] - 1, sprays[w] - 2], dp: [1, 2, 3], dy: [0, 0.5, 1] } } : {};
      return [w, g];
    }));
    render(<AimPanels query={{ files: [], filter: { player: "x" } }} label="test" visibility={false} />);
    const radios = () => Array.from(host.querySelectorAll<HTMLElement>('[aria-label="Gun"] [role=radio]'));
    const picked = () => radios().find((b) => b.getAttribute("aria-checked") === "true")?.dataset.w;
    const order = ["galilar", "famas", "ak47", "cz75a"];
    expect(radios().map((b) => b.dataset.w)).toEqual(order);
    expect(radios().filter((b) => b.tabIndex === 0).map((b) => b.dataset.w)).toEqual([order[0]]);
    act(() => radios()[0].focus());
    key(document.activeElement!, "ArrowRight");
    expect([picked(), (document.activeElement as HTMLElement).dataset.w]).toEqual([order[1], order[1]]);
    key(document.activeElement!, "End");
    const last = order[order.length - 1];
    expect([picked(), (document.activeElement as HTMLElement).dataset.w]).toEqual([last, last]);
    key(document.activeElement!, "ArrowDown");
    expect(picked()).toBe(order[0]);
    key(document.activeElement!, "ArrowUp");
    expect(picked()).toBe(last);
    key(document.activeElement!, "Home");
    expect([picked(), (document.activeElement as HTMLElement).dataset.w]).toEqual([order[0], order[0]]);
    expect(radios().filter((b) => b.tabIndex === 0).map((b) => b.dataset.w)).toEqual([order[0]]);
    scoped = null;
    perGun = {};
  });
  it("puts the Ideal pull and Spread toggles in the tab order as native checkboxes, so Space flips them", () => {
    // fails if a toggle becomes a div or a button outside the tab order: jsdom does not run a checkbox's
    // Space activation, so the contract checked is the element the browser gives it to
    setMeta(metaOf(CS2RB));
    const s = rolled(emptySummary());
    s.weapons.ak47 = { rounds: 1, shots: 10, hits: 1, groups: [0, 0, 0, 0, 0, 0, 0, 0], dmg: 0, kills: 0, hsKills: 0, deaths: 0 };
    s.aim.sprays = 4;
    s.aim.path = { ak47: { n: [4, 4], dp: [4, 8], dy: [0, 4] } };
    s.aim.spread = { ak47: { pp: [8, 20], yy: [0, 8] } };
    scoped = s;
    render(<AimPanels query={{ files: [], filter: { player: "x" } }} label="test" visibility={false} />);
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>(".spray-toggles input"));
    expect(boxes.map((b) => [b.type, b.tabIndex, b.disabled, b.closest("label")?.textContent])).toEqual([["checkbox", 0, false, "Ideal pull"], ["checkbox", 0, false, "Spread"]]);
    scoped = null;
  });
});

describe("the shortcut list (palette and Data & settings)", () => {
  it("names the keys the app binds", () => {
    // fails if the list drifts from the bindings again: it said Ctrl 1–6 with three views and Alt 1–8 with ten match tabs
    const keys = Object.fromEntries(SHORTCUTS.map(([k, label]) => [label, k]));
    expect(keys["Views"]).toBe(`Ctrl 1–${NAV.length}`);
    expect(keys["Profile tabs"]).toBe(`Alt 1–${PROFILE_TABS.length}`);
    expect(keys["Match tabs"]).toBe("Alt 1–9 / 0");
    expect(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map(matchTabOfKey)).toEqual([...MATCH_TABS]);
  });
});
