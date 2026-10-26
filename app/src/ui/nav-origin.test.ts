// @vitest-environment jsdom
// Which navigations count as a click (router.ts navWasPointer), which gates the Luck tab's one draw-in,
// and which fields keep their keys from the app's shortcuts (router.ts isTextEntry, read by App.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh router module: its input and navigation flags start as on first load. */
const fresh = async () => {
  vi.resetModules();
  return import("./router");
};
const follow = (hash: string) => {
  history.pushState(null, "", hash);
  dispatchEvent(new Event("hashchange"));
};

beforeEach(() => history.replaceState(null, "", "#/"));

describe("navigations from a pointer", () => {
  it("is not one on first load or a deep link", async () => {
    const r = await fresh();
    expect(r.navWasPointer()).toBe(false);
    follow("#/match/a.json.gz/luck");
    expect(r.navWasPointer()).toBe(false);
  });

  it("counts a clicked link, and not the same link followed with Enter", async () => {
    // fails if Enter on a focused tab plays motion meant for a click (the keydown comes before the hashchange)
    const r = await fresh();
    dispatchEvent(new Event("pointerdown"));
    follow("#/match/a.json.gz/luck");
    expect(r.navWasPointer()).toBe(true);
    dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    follow("#/match/a.json.gz/overview");
    expect(r.navWasPointer()).toBe(false);
  });

  it("does not count a keyboard shortcut's go, even after a click", async () => {
    const r = await fresh();
    dispatchEvent(new Event("pointerdown"));
    r.go("#/match/a.json.gz/luck", { instant: true });
    expect(r.navWasPointer()).toBe(false);
    r.go("#/match/a.json.gz/rounds");
    expect(r.navWasPointer()).toBe(true);
  });
});

describe("text entry", () => {
  it("covers inputs, text areas, selects and editable content, not other elements", async () => {
    const { isTextEntry } = await import("./router");
    document.body.innerHTML = `<input id="i"><textarea id="t"></textarea><select id="s"></select><div contenteditable id="c"><b id="cb"></b></div>
      <div contenteditable="false" id="cf"></div><a href="#" id="a"></a><button id="b"></button>`;
    const at = (id: string) => isTextEntry(document.getElementById(id)!);
    expect(["i", "t", "s", "c", "cb"].map(at)).toEqual([true, true, true, true, true]);
    expect(["cf", "a", "b"].map(at)).toEqual([false, false, false]);
  });
});
