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
  /** A roles-v2 decision: a gated primary with its probability, or the top two, or neither with a reason. */
  const side = (sideName: "T" | "CT", d: { primary?: string; probability?: number; top2?: [string, string]; reason?: string; dist?: Record<string, number | null> | null; cal?: Record<string, string> }) => ({
    side: sideName, primary: d.primary ?? null, probability: d.probability ?? null, top2: d.top2 ?? null, reason: d.reason ?? null,
    distribution: d.dist ?? null, blend: d.dist ?? null, calibrationStatus: d.cal ?? {}, metrics: [], evidence: [], rounds: 40, awp: null, loadoutRounds: 0, tips: {},
  });
  const overall = (d: Parameters<typeof side>[1]) => ({ ...side("T", d), rounds: { T: 40, CT: 40 } });

  it("leads with the engine's overall decision, fit-labelled, and lists each map's overall, T and CT roles", () => {
    // fails if the card infers a role from the distribution, drops the "fit" label on an uncalibrated share,
    // or a map loses a side
    answers.roles = {
      T: side("T", { primary: "Entry", probability: 0.62, dist: { Entry: 0.62, Trader: 0.38 } }),
      CT: side("CT", { top2: ["Anchor", "Rotator"], reason: "Anchor leads Rotator by 4 points.", dist: { Anchor: 0.45, Rotator: 0.41, AWPer: null } }),
      all: overall({ primary: "Entry", probability: 0.31, dist: { Entry: 0.31 } }),
    };
    answers.rolesByMap = [{ map: "de_dust2", T: side("T", { primary: "Lurker", probability: 1 }), CT: side("CT", { reason: "12 of the 30 CT rounds a role needs." }), all: overall({ primary: "Lurker", probability: 1 }) }];
    render(<RoleCard q={Q} />);
    expect(text(host.querySelector(".role__name"))).toBe("Entry");
    expect(text(host.querySelector(".role__overall .meta"))).toBe("31% fit over all rounds");
    // CT's lead is narrow: "A / B" with the tag, no share
    const ct = Array.from(host.querySelectorAll(".rfit")).find((el) => text(el.querySelector(".rfit__side")) === "CT")!;
    expect(text(ct.querySelector(".rfit__role"))).toBe("Anchor / RotatorNarrow lead");
    expect(text(ct.querySelector(".rfit__pct"))).toBe("");
    // the unknown AWPer share is null: no segment, rather than a 0% one
    expect(Array.from(ct.querySelectorAll(".rfit__bar i")).map((el) => el.getAttribute("aria-label"))).toEqual(["Anchor 45% fit.", "Rotator 41% fit."]);
    const cells = Array.from(host.querySelectorAll(".rmaps--all li > *")).map(text);
    expect(cells).toEqual(["Dust II", "Lurker100%", "T", "Lurker100%", "CT", "–"]);
    expect(host.querySelector(".rmaps--all .faint")!.getAttribute("data-tip")).toBe("12 of the 30 CT rounds a role needs.");
  });

  it("says why when the engine withholds the overall role, and never shows Mixed", () => {
    answers.roles = { T: side("T", { reason: "Too few rounds." }), CT: side("CT", { reason: "Too few rounds." }), all: overall({ reason: "Too few rounds on either side." }) };
    answers.rolesByMap = [];
    render(<RoleCard q={Q} />);
    expect(host.querySelector(".role__name")).toBeNull();
    expect(text(host.querySelector(".role__overall"))).toBe("Too few rounds on either side.");
    expect(host.textContent).not.toContain("Mixed");
  });
});

describe("aggression", () => {
  it("places the score on the track at 50% plus a quarter per pro SD, capped at two SDs", () => {
    // fails if the pros' mean is not the track's middle, or a score past 2 SDs runs off the track
    render(<AggressionCard s={withValues({ aggressionScore: 1, peekTravel: 300, duelExposure: null, firedFirst: 55, engageDistance: 700 })} />);
    expect(host.querySelector<HTMLElement>(".aggro__scale .trk__dot")!.style.left).toBe("75%");
    expect(text(host.querySelector(".aggro__score b"))).toBe("+1.00");
    // duelExposure has no value, so three parts show
    expect(host.querySelectorAll(".mrow")).toHaveLength(3);
    render(<AggressionCard s={withValues({ aggressionScore: -3, peekTravel: null, duelExposure: null, firedFirst: null, engageDistance: null })} />);
    expect(host.querySelector<HTMLElement>(".aggro__scale .trk__dot")!.style.left).toBe("0%");
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
    expect(rows[0].querySelector<HTMLElement>(".trk__dot")!.style.left).toBe("80%");
    expect(rows[1].querySelector(".trk")).toBeNull();
    expect(rows[1].getAttribute("data-tip")).toContain("1 of the 10 saved rounds a percentile needs.");
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
    expect(host.querySelector<HTMLElement>(".trk__dot")!.style.left).toBe("100%");
    expect(host.querySelector<HTMLElement>(".trk__ref")!.style.left).toBe("0%");
    render(<DotTrack at={null} label="x" />);
    expect(host.querySelector(".trk__dot")).toBeNull();
  });
});
