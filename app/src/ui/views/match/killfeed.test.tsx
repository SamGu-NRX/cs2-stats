// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Killfeed, type FeedKill } from "./Killfeed";

// icons need the host; without one they keep an empty box, which is all this test needs
vi.mock("../../data/provider", () => ({ useData: () => ({ host: null }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const kill: FeedKill = {
  t: 12, killer: { pi: 3, name: "hayanh", side: "T" }, victim: { pi: 0, name: "player1", side: "CT" }, assister: { pi: 4, name: "mAnGo", flash: true },
  weapon: "ak47", headshot: true, wallbang: false, smoke: false, noscope: false, blind: false, inAir: false, opening: true, tradeKill: false, swing: -0.2, mine: true,
};

describe("killfeed names", () => {
  it("renders killer, assister and victim through the drawer's name renderer, so their player cards open", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(<Killfeed kills={[kill]} name={(pi, name) => <a data-pi={pi}>{name}</a>} />));
    expect(Array.from(host.querySelectorAll("a[data-pi]")).map((a) => [a.getAttribute("data-pi"), a.textContent])).toEqual([["3", "hayanh"], ["4", "mAnGo"], ["0", "player1"]]);
    act(() => root.unmount());
  });
});
