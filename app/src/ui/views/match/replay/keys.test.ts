// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { keyAction } from "./keys";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...mods });

let root: HTMLElement;
const q = (sel: string) => document.querySelector(sel)!;

beforeEach(() => {
  document.body.innerHTML = `
    <nav><a href="#/" id="nav">Home</a><button id="outside">Outside</button></nav>
    <div class="replay">
      <canvas id="canvas"></canvas>
      <button id="next">Next round</button>
      <a href="#k" id="link">kill</a>
      <div role="slider" tabindex="0" id="scrub"></div>
      <div role="radiogroup"><button role="radio" id="speed">1x</button></div>
      <label><input type="checkbox" id="names"></label>
      <div id="plain" tabindex="0"></div>
    </div>`;
  root = q(".replay") as HTMLElement;
});

describe("keyAction", () => {
  it("plays with Space when nothing is focused or a plain part of the replay is", () => {
    expect(keyAction(key(" "), document.body, root, false)).toBe("toggle");
    expect(keyAction(key(" "), null, root, false)).toBe("toggle");
    expect(keyAction(key(" "), q("#plain"), root, false)).toBe("toggle");
    expect(keyAction(key(" "), q("#scrub"), root, false)).toBe("toggle");
  });

  it("leaves Space to a focused button, link, radio or checkbox, however it got focus", () => {
    for (const id of ["#next", "#link", "#speed", "#names"]) expect(keyAction(key(" "), q(id), root, false)).toBe(null);
  });

  it("ignores keys whose focus is outside the replay", () => {
    expect(keyAction(key(" "), q("#outside"), root, true)).toBe(null);
    expect(keyAction(key("ArrowRight"), q("#nav"), root, true)).toBe(null);
    expect(keyAction(key("n"), q("#outside"), root, true)).toBe(null);
  });

  it("changes round with the arrows, except in a control that uses them", () => {
    expect(keyAction(key("ArrowLeft"), document.body, root, false)).toBe("prev");
    expect(keyAction(key("ArrowRight"), q("#next"), root, false)).toBe("next");
    expect(keyAction(key("ArrowRight"), q("#scrub"), root, false)).toBe(null);
    expect(keyAction(key("ArrowRight"), q("#speed"), root, false)).toBe(null);
  });

  it("switches floor only on a map with two, and shows names", () => {
    expect(keyAction(key("l"), document.body, root, true)).toBe("floor");
    expect(keyAction(key("L"), document.body, root, false)).toBe(null);
    expect(keyAction(key("N"), document.body, root, false)).toBe("names");
  });

  it("leaves typing and modified keys alone", () => {
    expect(keyAction(key("n"), q("#names"), root, false)).toBe(null);
    expect(keyAction(key(" ", { ctrlKey: true }), document.body, root, false)).toBe(null);
    expect(keyAction(key("ArrowLeft", { altKey: true }), document.body, root, false)).toBe(null);
    expect(keyAction(key(" ", { defaultPrevented: true }), document.body, root, false)).toBe(null);
  });
});
