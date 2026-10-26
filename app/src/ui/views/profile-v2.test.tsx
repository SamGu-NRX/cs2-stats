// @vitest-environment jsdom
// The Profile panels that read the metrics-v2 engine fields (#31): swing by source, the overall and
// per-map role, Aggression and Economy, Plays like's two markers and the multi-kill rounds. Each panel
// gets hand-built engine answers, so every expected figure is worked out by hand.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CS2RB } from "../../stats/model-params";
import { emptySummary } from "../../stats/rollup";
import type { Method, Rolled } from "../../worker/protocol";
import { metaOf, rolled } from "../../worker/views";
import { setMeta } from "../data/meta";
import { RoleCard } from "./profile/parts";
import { AggressionCard, DotTrack, EconomyCard, SwingSourcesChart } from "./profile/v2";

let answers: Partial<Record<Method, unknown>> = {};
vi.mock("../data/provider", () => ({ useData: () => ({ matches: [], you: [], version: 0, client: null, baselines: null }) }));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useCall: (method: Method, args: unknown[] | null) => ({ data: args ? answers[method] ?? null : null, error: null, loading: false }),
  useRollups: () => ({ data: null, error: null, loading: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setMeta(metaOf(CS2RB));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  answers = {};
});
const render = (ui: JSX.Element) => act(() => root.render(ui));
const Q = { files: ["a"], filter: { player: "x" } };
const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";
/** A rolled summary with these metric values set by hand. */
function withValues(v: Record<string, number | null>): Rolled {
  const r = rolled(emptySummary());
  return { ...r, v: { ...r.v, ...v } };
}
const pctOf = (s: string) => Number(s.replace("%", ""));

describe("swing by source", () => {
  it("starts each source's bar where the one before it ended, and ends the total at the sum", () => {
    // fails if a bar is drawn from zero instead of the running total, or the total row is not the sum
    // sources sum to +3 (kills +4, trades +1, damage +2, flashes 0, deaths −5, round end +1); the scale runs 0 to 7
    render(<SwingSourcesChart you={{ kills: 4, trades: 1, damage: 2, flashes: 0, deaths: -5, roundEnd: 1 }} bots={null} />);
    const bars = Array.from(host.querySelectorAll<HTMLElement>(".wfall__track i"));
    const at = bars.map((b) => [pctOf(b.style.left), pctOf(b.style.width)].map((x) => +x.toFixed(4)));
    const u = 100 / 7;
    expect(at.slice(0, 3)).toEqual([[0, +(4 * u).toFixed(4)], [+(4 * u).toFixed(4), +u.toFixed(4)], [+(5 * u).toFixed(4), +(2 * u).toFixed(4)]]);
    // deaths run back from 7 to 2
    expect(at[4]).toEqual([+(2 * u).toFixed(4), +(5 * u).toFixed(4)]);
    expect(text(host.querySelector(".wfall__row--total b"))).toBe("+3.00%");
    expect(at[6]).toEqual([0, +(3 * u).toFixed(4)]);
  });

  it("adds the bots' column only when the bots have a split", () => {
    render(<SwingSourcesChart you={{ kills: 1, trades: 0, damage: 0, flashes: 0, deaths: 0, roundEnd: 0 }} bots={{ kills: 2, trades: 0, damage: 0, flashes: 0, deaths: -1, roundEnd: 0 }} />);
    expect(text(host.querySelector(".wfall__row--total .faint"))).toBe("+1.00%");
    render(<SwingSourcesChart you={{ kills: 1, trades: 0, damage: 0, flashes: 0, deaths: 0, roundEnd: 0 }} bots={null} />);
    expect(host.querySelector(".wfall .faint")).toBeNull();
  });
});

describe("role", () => {
  it("leads with the overall role and lists each map's overall, T and CT roles", () => {
    // fails if the headline falls back to the two sides, or a map loses a side
    const blend = (b: Record<string, number> | null, side: "T" | "CT") => ({ side, blend: b, evidence: [], rounds: 10, awp: null, loadoutRounds: 0 });
    answers.roles = { T: blend({ Entry: 0.7, Lurker: 0.3 }, "T"), CT: blend({ Anchor: 0.6, Rotator: 0.4 }, "CT"), all: { blend: { Entry: 0.35, Anchor: 0.3, Lurker: 0.15, Rotator: 0.2 }, rounds: { T: 10, CT: 10 } } };
    answers.rolesByMap = [{ map: "de_dust2", T: blend({ Lurker: 1 }, "T"), CT: blend(null, "CT"), all: { blend: { Lurker: 1 }, rounds: { T: 10, CT: 0 } } }];
    render(<RoleCard q={Q} />);
    expect(text(host.querySelector(".role__name"))).toBe("Entry");
    expect(text(host.querySelector(".role__overall .meta"))).toBe("35% of all rounds");
    const cells = Array.from(host.querySelectorAll(".rmaps--all li > *")).map(text);
    expect(cells).toEqual(["Dust II", "Lurker100%", "T", "Lurker100%", "CT", "–"]);
  });

  it("shows no overall headline when neither side has a blend", () => {
    const blend = (side: "T" | "CT") => ({ side, blend: null, evidence: [], rounds: 3, awp: null, loadoutRounds: 0 });
    answers.roles = { T: blend("T"), CT: blend("CT"), all: { blend: null, rounds: { T: 3, CT: 3 } } };
    render(<RoleCard q={Q} />);
    expect(host.querySelector(".role__overall")).toBeNull();
  });
});

describe("aggression", () => {
  it("places the score on the track at 50% plus a quarter per pro SD, capped at two SDs", () => {
    // fails if the pros' mean is not the track's middle, or a score past 2 SDs runs off the track
    render(<AggressionCard s={withValues({ aggressionScore: 1, peekTravel: 300, duelExposure: null, firedFirst: 55, engageDistance: 700 })} />);
    expect(host.querySelector<HTMLElement>(".aggro__scale .dtrack__dot")!.style.left).toBe("75%");
    expect(text(host.querySelector(".aggro__score b"))).toBe("+1.00");
    // duelExposure has no value, so three parts show
    expect(host.querySelectorAll(".mrow")).toHaveLength(3);
    render(<AggressionCard s={withValues({ aggressionScore: -3, peekTravel: null, duelExposure: null, firedFirst: null, engageDistance: null })} />);
    expect(host.querySelector<HTMLElement>(".aggro__scale .dtrack__dot")!.style.left).toBe("0%");
  });

  it("does not render without any value, as on files without line of sight", () => {
    render(<AggressionCard s={withValues({ aggressionScore: null, peekTravel: null, duelExposure: null, firedFirst: null, engageDistance: null })} />);
    expect(host.innerHTML).toBe("");
  });
});

describe("economy", () => {
  it("draws the bot percentile where the engine has one, and the reason where it has none", () => {
    // fails if a withheld percentile (too few saved rounds) draws a dot, or the reason is lost
    answers.style = { p: { buyDeviation: { id: "buyDeviation", value: 410, pct: 80, pool: "all", reason: null, n: null }, saveConversion: { id: "saveConversion", value: 2000, pct: null, pool: "all", reason: "1 of the 10 saved rounds a percentile needs", n: 1 } } };
    render(<EconomyCard q={Q} s={withValues({ buyDeviation: 410, saveConversion: 2000 })} side="both" />);
    const rows = Array.from(host.querySelectorAll(".mrow"));
    expect(rows[0].querySelector<HTMLElement>(".dtrack__dot")!.style.left).toBe("80%");
    expect(rows[1].querySelector(".dtrack")).toBeNull();
    expect(rows[1].querySelector(".mrow__why")!.getAttribute("data-tip")).toBe("1 of the 10 saved rounds a percentile needs");
    // a research metric without a value takes no row
    render(<EconomyCard q={Q} s={withValues({ buyDeviation: 410, saveConversion: null })} side="both" />);
    expect(host.querySelectorAll(".mrow")).toHaveLength(1);
    render(<EconomyCard q={Q} s={withValues({ buyDeviation: null, saveConversion: null })} side="both" />);
    expect(host.innerHTML).toBe("");
  });
});

describe("dot track", () => {
  it("draws your marker and a hollow second marker, clamped to the track", () => {
    render(<DotTrack at={120} ghost={-5} label="x" />);
    expect(host.querySelector<HTMLElement>(".dtrack__dot")!.style.left).toBe("100%");
    expect(host.querySelector<HTMLElement>(".dtrack__ghost")!.style.left).toBe("0%");
    render(<DotTrack at={null} label="x" />);
    expect(host.querySelector(".dtrack__dot")).toBeNull();
  });
});
