// @vitest-environment jsdom
// The takeover switch and its mark (Takeover.tsx): one app-wide choice by pointer or keyboard, kept,
// and every number it changed marked with the game's figure while "You" is on.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyMeasures } from "../../stats/facts";
import { credited, setCredit, useCredit } from "../data/credit";
import { lineOf } from "../data/engine";
import { Moved, TakeoverSwitch } from "./Takeover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// not in jsdom; the segmented control measures its thumb and escapes its values (plain words here)
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;

const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
const render = (ui: JSX.Element) => act(() => root.render(ui));

const m = { ...emptyMeasures(), rounds: 10, kills: 5, deaths: 6, dmg: 700, assists: 2, takeoverKills: 2, takeoverDeaths: 1, takeoverDmg: 150 };
const BASE = lineOf({ m, v: { adr: 70, kpr: 0.5, dpr: 0.6, hs: 0, kast: 70 } }, 1.0);

/** A view's stat line: the switch, then K, A and ADR as the scoreboard draws them. */
function Board() {
  const l = credited(BASE, useCredit());
  return (
    <div>
      <TakeoverSwitch />
      <span data-k><Moved l={l} f="kills" game={String(l.game.kills)}>{l.kills}</Moved></span>
      <span data-a>{l.assists}</span>
      <span data-adr><Moved l={l} f="adr" game={l.game.adr!.toFixed(1)}>{l.adr!.toFixed(1)}</Moved></span>
    </div>
  );
}

const radio = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === name)!;
const cell = (k: string) => host.querySelector(`[data-${k}] .moved`) ?? host.querySelector(`[data-${k}]`)!;

beforeEach(() => { localStorage.clear(); act(() => { setCredit("bot"); }); });
// the choice is saved in localStorage, which outlives this file: leave it as the default
afterEach(() => { render(<></>); vi.useRealTimers(); act(() => { setCredit("bot"); }); localStorage.clear(); });

describe("TakeoverSwitch", () => {
  it("starts on Bot, the game's credit, with the numbers unmarked", () => {
    // fails if the default moves play, or marks a number that has not moved
    render(<Board />);
    expect(host.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe("Takeovers count for");
    expect([radio("Bot").getAttribute("aria-checked"), radio("You").getAttribute("aria-checked")]).toEqual(["true", "false"]);
    expect([cell("k").textContent, cell("adr").textContent]).toEqual(["5", "70.0"]);
    expect(host.querySelectorAll(".moved--on").length).toBe(0);
  });

  it("moves the play to you on a click, marks what moved with the game's figure, and keeps the choice", () => {
    // fails if a changed number is unmarked, if its tooltip or screen-reader text lacks the game's
    // count, if an unchanged number (assists) is marked, or if the choice is not saved
    render(<Board />);
    act(() => { radio("You").click(); });
    expect(radio("You").getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("cs2stats.takeoverCredit")).toBe("you");
    const k = cell("k");
    expect([k.className.includes("moved--on"), k.textContent]).toEqual([true, "7, with takeover play; the game's count is 5"]);
    expect(k.getAttribute("data-tip")).toBe("Includes your play in bots you took over. The game's count: 5.");
    expect(k.getAttribute("tabindex")).toBe("0");
    expect(cell("adr").textContent).toBe("85.0, with takeover play; the game's count is 70.0");
    expect(host.querySelector("[data-a]")!.innerHTML).toBe("2");
  });

  it("switches by keyboard, as a radio group", () => {
    // fails if the arrows do not move the choice, or the focus does not follow it
    render(<Board />);
    radio("Bot").focus();
    act(() => { radio("Bot").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect([radio("You").getAttribute("aria-checked"), document.activeElement]).toEqual(["true", radio("You")]);
    // the keyboard never animates (the motion table): the numbers change without the fade
    expect(cell("k").className).not.toContain("moved--fade");
    act(() => { radio("You").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect([radio("Bot").getAttribute("aria-checked"), cell("k").textContent]).toEqual(["true", "5"]);
  });

  it("leaves a rate the line hides as an unmarked dash under either credit", () => {
    // a thin log's line hides its rates (engine.ts coverEntry). Fails if "You" brings its ADR back from
    // the counts, or marks the dash as moved
    const thin = { ...BASE, adr: null, v: { ...BASE.v, adr: null } };
    function Thin() {
      const l = credited(thin, useCredit());
      return <span data-thin><Moved l={l} f="adr" game="–">{l.adr === null ? "–" : l.adr.toFixed(1)}</Moved></span>;
    }
    render(<><TakeoverSwitch /><Thin /></>);
    act(() => { radio("You").click(); });
    const el = host.querySelector("[data-thin]")!;
    expect([el.textContent, el.querySelector(".moved")]).toEqual(["–", null]);
  });

  it("is one choice for every view on the page", () => {
    // fails if a second view keeps its own credit
    render(<><Board /><Board /></>);
    act(() => { host.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1].click(); });
    expect([...host.querySelectorAll("[data-k] .moved--on")].length).toBe(2);
  });

  it("fades the moved numbers in when the switch flips by pointer, and not when a page opens", () => {
    // fails if opening a page under "You" plays the change, or a click does not
    vi.useFakeTimers();
    render(<Board />);
    // a pointer click: click() alone has no detail, which the segmented control reads as the keyboard
    act(() => { radio("You").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })); });
    expect(cell("k").className).toContain("moved--fade");
    render(<></>);
    vi.advanceTimersByTime(1000);
    render(<Board />);
    expect(cell("k").className).not.toContain("moved--fade");
    expect(cell("k").className).toContain("moved--on");
  });
});
