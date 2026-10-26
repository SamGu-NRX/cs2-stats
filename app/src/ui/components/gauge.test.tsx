// @vitest-environment jsdom
// The gauge counts up on the session's first view only. Its own file: the "already counted" flag is
// module state, so this file's first render is the session's first view.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Gauge } from "./charts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.unstubAllGlobals());

it("counts up on the first view, then sets a new value (a side switch) at once, even mid-count", () => {
  // fails if a later value counts up from zero again, or waits for the first count to finish
  let now = 0;
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => { frames.length = 0; });
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const frame = (t: number) => act(() => { now = t; frames.splice(0).forEach((cb) => cb(t)); });

  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const value = () => host.querySelector(".gauge__v")!.textContent;
  act(() => root.render(<Gauge value={1.2} verdict="good" label="Rating" />));
  expect(value()).toBe("0.00");
  frame(300);
  const mid = Number(value());
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(1.2);
  // a side switch mid-count: the new value at once, and no frame is left to move it
  act(() => root.render(<Gauge value={0.85} verdict="avg" label="Rating" />));
  expect(value()).toBe("0.85");
  frame(600);
  expect(value()).toBe("0.85");
  // a remount later in the session (the card reloading after a filter change) does not count again
  act(() => root.unmount());
  const again = createRoot(host);
  act(() => again.render(<Gauge value={1.1} verdict="good" label="Rating" />));
  expect(value()).toBe("1.10");
  act(() => again.unmount());
});
