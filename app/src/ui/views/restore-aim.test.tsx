// @vitest-environment jsdom
// The aim slice's restored elements (REMOVALS.md, E20). The aim panels read one hand-built summary
// (its metric values from the engine's own valuesOf), so every expected figure is worked out by hand.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIT_GROUPS } from "../../stats/facts";
import { CS2RB } from "../../stats/model-params";
import { emptySummary, type Summary, type WeaponTotals } from "../../stats/rollup";
import type { Rolled } from "../../worker/protocol";
import { metaOf, rolled } from "../../worker/views";
import { targetControl } from "../components/charts";
import { setMeta } from "../data/meta";
import { BarProvider } from "../shell/Bar";
import type { Data } from "../data/provider";
import { AimPanels } from "./aim/AimPanels";
import CareerAim from "./CareerAim";

let scoped: Rolled | null = null;
vi.mock("../data/provider", () => ({ useData: (): Pick<Data, "matches" | "you"> & { version: number; client: null } => ({ matches: [], you: [], version: 0, client: null }) }));
vi.mock("../data/packs", () => ({ usePros: () => ({ state: "missing" }), useAgents: () => null }));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useScoped: (_q: unknown, extra: unknown[]) => (scoped ? extra.map(() => scoped) : null),
  useRollups: () => ({ data: null, error: null, loading: false }),
  useCall: () => ({ data: null, error: null, loading: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;

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
  scoped = null;
});
const render = (ui: JSX.Element) => act(() => root.render(ui));
const QUERY = { files: [], filter: { player: "x" } };

const gun = (o: Partial<WeaponTotals>): WeaponTotals => ({ rounds: 1, shots: 0, hits: 0, groups: HIT_GROUPS.map(() => 0), dmg: 0, kills: 0, hsKills: 0, deaths: 0, ...o });
/** A summary with an AK, a knife and these aim fields. */
function summary(aim: Partial<Summary["aim"]> = {}): Rolled {
  const s = emptySummary();
  s.weapons = {
    // 10 gun hits, 4 on the head; 10 gun kills, 7 headshots
    ak47: gun({ shots: 40, hits: 10, groups: [4, 0, 6, 0, 0, 0, 0, 0], kills: 10, hsKills: 7 }),
    // a knife's head hits and kills stay out of the gun figures
    knife: gun({ hits: 5, groups: [5, 0, 0, 0, 0, 0, 0, 0], kills: 5, hsKills: 0 }),
  };
  Object.assign(s.aim, { shots: 40, hits: 10 }, aim);
  return rolled(s);
}
/** The text of the hero figure or disclosure row labelled `label`. */
const fig = (label: string) => Array.from(host.querySelectorAll(".fig")).find((f) => f.querySelector(".fig__l")?.textContent === label);
const row = (label: string) => Array.from(host.querySelectorAll(".drow")).find((r) => r.querySelector("span")?.firstChild?.textContent === label);
const rowValue = (label: string) => row(label)?.querySelector("b")?.textContent;

describe("aim hero, restored figures", () => {
  it("shows head accuracy and headshot kills over guns only, the headshot share coloured", () => {
    // fails if the knife counts, or the verdict colour is lost or computed from the wrong share
    scoped = summary();
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(fig("Head accuracy")?.querySelector(".fig__v")?.textContent).toBe("40.0%");
    const hsk = fig("Headshot kills")!.querySelector<HTMLElement>(".fig__v")!;
    expect(hsk.textContent).toBe("70.0%");
    // 70% is past 45 + 25, the end of the scale: full good-text green
    expect(hsk.style.color).toBe("rgb(45, 186, 42)");
  });

  it("leaves the headshot figure uncoloured without gun kills", () => {
    scoped = summary();
    scoped.weapons.ak47.kills = 0;
    scoped.weapons.ak47.hsKills = 0;
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(fig("Headshot kills")!.querySelector<HTMLElement>(".fig__v")!.style.color).toBe("");
  });

  it("marks the visibility rows Validating, focusably, only where mesh visibility exists", () => {
    // fails if the chip shows on files without line of sight, or cannot take keyboard focus
    scoped = summary({ sight: 20, sightHits: 5, adj: 10, adjHits: 4 });
    render(<AimPanels query={QUERY} label="t" visibility />);
    expect(rowValue("Accuracy at visible enemies")).toBe("25.0%");
    expect(rowValue("Adjusted accuracy")).toBe("40.0%");
    const chips = Array.from(host.querySelectorAll(".drow .chip"));
    expect(chips.map((c) => c.textContent)).toEqual(["Validating", "Validating"]);
    expect(chips.every((c) => c.getAttribute("tabindex") === "0" && c.getAttribute("data-tip"))).toBe(true);
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(host.querySelectorAll(".drow .chip")).toHaveLength(0);
  });

  it("shows wallbang and smoke kills only where the file records the flag", () => {
    // fails if an unrecorded flag reads as zero kills
    scoped = summary({ killsWbKnown: 6, killsWb: 2, killsSmokeKnown: 0, killsSmoke: 0, smokeShotsKnown: 50, smokeShots: 5 });
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(rowValue("Wallbang kills")).toBe("2");
    expect(rowValue("Smoke kills")).toBe("–");
    expect(rowValue("Shots through smoke")).toBe("10.0%");
  });

  it("counts bullets on target only with mesh visibility, and spray accuracy from bullet 4", () => {
    // fails if a file without line of sight shows 0 bullets on target, or spray accuracy reads the wrong counts
    scoped = summary({ first: 12, firstHits: 3, deep: 8, deepHits: 2 });
    render(<AimPanels query={QUERY} label="t" visibility />);
    expect([rowValue("First bullets on target"), rowValue("Spray bullets on target"), rowValue("Spray accuracy (bullet 4+)")]).toEqual(["12", "8", "25.0%"]);
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect([rowValue("First bullets on target"), rowValue("Spray bullets on target")]).toEqual(["–", "–"]);
  });

  it("explains counter-strafing with its counts, colours the figure, and drops the counts when none is known", () => {
    // fails if the counts are not cs[0] of all known first bullets, or "0 first bullets" shows
    scoped = summary({ cs: [6, 1, 1, 1, 1] });
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    const p = host.querySelector(".disclose__p")!.textContent!;
    expect(p).toContain("at or under 34% of the weapon's top speed");
    expect(p).toContain("10 first bullets had a known speed; 6 of them were counter-strafed.");
    // 60% is the scale's neutral middle
    expect(fig("Counter-strafed first shots")!.querySelector<HTMLElement>(".fig__v")!.style.color).toBe("rgb(230, 226, 220)");
    scoped = summary();
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(host.querySelector(".disclose__p")!.textContent).not.toContain("known speed");
  });

  it("gives no verdict colour to spray path vs pros, which the engine defines as a comparison", () => {
    scoped = summary({ cmp: 4, dev: 12 });
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(fig("Spray path vs pros")!.querySelector<HTMLElement>(".fig__v")!.style.color).toBe("");
  });
});

describe("spray card, restored parts", () => {
  /** An AK spray summary: 4 sprays to bullet 3, with spread and target sums. */
  const spray = (onTarget: Summary["aim"]["onTarget"] = {}) => summary({
    path: { ak47: { n: [4, 4], dp: [4, 8], dy: [0, 4] } },
    spread: { ak47: { pp: [8, 20], yy: [0, 8] } },
    heads: { ak47: { n: [4, 4, 4], dp: [0, 0, 0], dy: [4, 4, 4] } },
    onTarget,
  });

  it("draws one spread ellipse per bullet past the first behind a Spread bands toggle beside Pro path", () => {
    // fails if the toggle is missing, unlabelled, replaces Pro path, or does not hide the ellipses
    scoped = spray();
    render(<AimPanels query={QUERY} label="t" visibility />);
    const boxes = Array.from(host.querySelectorAll<HTMLLabelElement>(".gunpick__bands label"));
    expect(boxes.map((l) => l.textContent)).toEqual(["Spread bands", "Pro path"]);
    expect(host.querySelectorAll("svg.spray ellipse")).toHaveLength(2);
    expect(host.querySelector(".spray-legend")!.textContent).toContain("one standard deviation");
    act(() => boxes[0].querySelector("input")!.click());
    expect(host.querySelectorAll("svg.spray ellipse")).toHaveLength(0);
    expect(host.querySelector(".spray-legend")!.textContent).not.toContain("one standard deviation");
  });

  it("marks where the target's head was for each bullet, with its legend entry", () => {
    scoped = spray();
    render(<AimPanels query={QUERY} label="t" visibility />);
    expect(host.querySelectorAll('svg.spray circle[fill="var(--ct)"]')).toHaveLength(3);
    expect(host.querySelector(".spray-legend")!.textContent).toContain("Where the target's head was");
  });

  it("charts bullets against the 1.5 degree on-target line only when the target data exists", () => {
    // fails if the run, the line or the gate on bullet-angle data changes
    scoped = spray({ ak47: { n: [3, 3, 3], dp: [0.3, 3, 9], dy: [0, 0, 0] } });
    render(<AimPanels query={QUERY} label="t" visibility />);
    expect(host.textContent).toContain("Controlled through bullet 2");
    expect(host.textContent).toContain("1.5° on target");
    scoped = spray();
    render(<AimPanels query={QUERY} label="t" visibility />);
    expect(host.textContent).not.toContain("On target, bullet by bullet");
    expect(host.textContent).not.toContain("1.5° on target");
  });
});

describe("targetControl", () => {
  it("runs from bullet 1 while the mean offset stays within 1.5 degrees, over bullets with three or more values", () => {
    // bullet 1 at 0.5°, bullet 2 at 1.5° (the boundary counts), bullet 3 thin (2 values), bullet 4 at 5°
    const r = targetControl({ n: [3, 3, 2, 3], dp: [1.5, 2.7, 0, 9], dy: [0, 3.6, 0, 12] });
    expect(r.rows.map((x) => [x.i, +x.dev.toFixed(9)])).toEqual([[0, 0.5], [1, 1.5], [3, 5]]);
    expect(r.controlled).toBe(2);
    expect(targetControl({ n: [3, 3], dp: [6, 0], dy: [0, 0] }).controlled).toBe(0);
  });
});

describe("timings gate", () => {
  it("says why the timings are gated, per visibility status, with the extractor's 90% mesh rule", () => {
    // fails if a status loses its reason or the counts are wrong
    scoped = summary();
    render(<AimPanels query={QUERY} label="t" visibility={false} statuses={["no_mapdata", "mesh_mismatch", "mesh_mismatch", "ok"]} />);
    const why = host.querySelector(".gated__why")!.textContent!;
    expect(why).toContain("One match file has no mesh line of sight: plugin recordings never do");
    expect(why).toContain("2 match files failed the mesh check: the map's mesh gave line of sight at fewer than 90% of the kills that were not wallbangs");
    expect(why).toContain("keeps the mesh only when it gives line of sight at 90% or more");
    render(<AimPanels query={QUERY} label="t" visibility={false} statuses={["no_mesh"]} />);
    expect(host.querySelector(".gated__why")!.textContent).toContain("This match file has no mesh line of sight: the extractor has no collision mesh for the map.");
  });
});

describe("empty states", () => {
  it("Career aim offers Data & settings as a button when no recorded match exists", () => {
    render(<BarProvider><CareerAim /></BarProvider>);
    const btn = host.querySelector<HTMLAnchorElement>(".empty a.btn")!;
    expect([btn.textContent, btn.getAttribute("href")]).toEqual(["Open Data & settings", "#/settings"]);
  });
});
