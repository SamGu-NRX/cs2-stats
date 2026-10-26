// @vitest-environment jsdom
// The aim slice's restored elements (REMOVALS.md, E20) in Career aim's layout: the accuracy ring leads
// the stat strip, main's Hitting group sits under Where you hit, its spray-accuracy rows in Flicks and
// spray, its counter-strafe rule in that card's "?". The aim panels read one hand-built summary (its
// metric values from the engine's own valuesOf), so every expected figure is worked out by hand.
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
vi.mock("../data/provider", () => ({ useData: (): Pick<Data, "matches" | "you"> & { version: number; client: null; baselines: null } => ({ matches: [], you: [], version: 0, client: null, baselines: null }) }));
vi.mock("../data/packs", () => ({ usePros: () => ({ state: "missing" }), useAgents: () => null }));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  // as the real hook: null while loading, and null for an empty query list (useRollups asks nothing)
  useScoped: (_q: unknown, extra: unknown[]) => (scoped && extra.length ? extra.map(() => scoped) : null),
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
/** The card-list row labelled `label` (its label's own text, without an approx mark or a chip). */
const row = (label: string) => Array.from(host.querySelectorAll(".amrow")).find((r) => r.querySelector(".amrow__l > span")?.firstChild?.textContent === label);
const value = (label: string) => row(label)?.querySelector<HTMLElement>(":scope > b");
const rowValue = (label: string) => value(label)?.textContent;

describe("accuracy ring, leading the stat strip", () => {
  it("fills the ring at 50% accuracy and gives the strip's first cell to it", () => {
    // fails if the ring leaves the strip, or stops filling at 50% (10 of 40 shots, 25%, is half the ring)
    scoped = summary();
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    const lead = host.querySelector(".strip > .strip__lead")!;
    expect(host.querySelector(".strip")!.firstElementChild).toBe(lead);
    expect(lead.querySelector(".strip__val")!.textContent).toMatch(/^25\.0%/);
    const arc = lead.querySelectorAll("svg.ring circle")[1];
    const len = Number(arc.getAttribute("stroke-dasharray"));
    expect(Number(arc.getAttribute("stroke-dashoffset"))).toBeCloseTo(len / 2, 6);
  });
});

describe("hitting figures, restored", () => {
  it("shows head accuracy and headshot kills over guns only, the headshot share coloured", () => {
    // fails if the knife counts, or the verdict colour is lost or computed from the wrong share
    scoped = summary();
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(rowValue("Head accuracy")).toBe("40.0%");
    expect(rowValue("Headshot kills")).toBe("70.0%");
    // 70% is past 45 + 25, the end of the scale: full good-text green
    expect(value("Headshot kills")!.style.color).toBe("rgb(45, 186, 42)");
  });

  it("leaves the headshot figure uncoloured without gun kills", () => {
    scoped = summary();
    scoped.weapons.ak47.kills = 0;
    scoped.weapons.ak47.hsKills = 0;
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(value("Headshot kills")!.style.color).toBe("");
  });

  it("marks the visibility rows Validating, focusably, only where mesh visibility exists", () => {
    // fails if the chip shows on files without line of sight, or cannot take keyboard focus
    scoped = summary({ sight: 20, sightHits: 5, adj: 10, adjHits: 4 });
    render(<AimPanels query={QUERY} label="t" visibility />);
    expect(rowValue("Accuracy at visible enemies")).toBe("25.0%");
    expect(rowValue("Adjusted accuracy")).toBe("40.0%");
    const chips = Array.from(host.querySelectorAll(".amrow .chip"));
    expect(chips.map((c) => c.textContent)).toEqual(["Validating", "Validating"]);
    expect(chips.every((c) => c.getAttribute("tabindex") === "0" && c.getAttribute("data-tip"))).toBe(true);
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(host.querySelectorAll(".amrow .chip")).toHaveLength(0);
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

  it("puts the counter-strafe rule in the card's tooltip, shows its counts, colours the figure, and drops the counts when none is known", () => {
    // fails if the 34% rule is lost, the counts are not cs[0] of all known first bullets, or "0 first shots" shows
    scoped = summary({ cs: [6, 1, 1, 1, 1] });
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    const card = host.querySelector(".aim-strafe")!;
    expect(card.querySelector(".hint")!.getAttribute("data-tip")).toContain("at or under 34% of the gun's top speed");
    expect(card.textContent).toContain("10 first shots");
    expect(row("Counter-strafed first shots")!.querySelector(".amrow__n")!.textContent).toBe("6");
    // 60% is the scale's neutral middle
    expect(value("Counter-strafed first shots")!.style.color).toBe("rgb(230, 226, 220)");
    scoped = summary();
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(host.querySelector(".aim-strafe")!.textContent).not.toContain("first shot");
  });

  it("gives no verdict colour to spray path vs pros, which the engine defines as a comparison", () => {
    scoped = summary({ cmp: 4, dev: 12 });
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(rowValue("Spray path vs pros")).not.toBe("–");
    expect(value("Spray path vs pros")!.style.color).toBe("");
  });
});

describe("spray card, restored parts", () => {
  /** An AK spray summary: 4 sprays to bullet 3, with spread and target sums. */
  const spray = (onTarget: Summary["aim"]["onTarget"] = {}) => summary({
    sprays: 4,
    path: { ak47: { n: [4, 4], dp: [4, 8], dy: [0, 4] } },
    spread: { ak47: { pp: [8, 20], yy: [0, 8] } },
    heads: { ak47: { n: [4, 4, 4], dp: [0, 0, 0], dy: [4, 4, 4] } },
    onTarget,
  });

  it("draws one spread ellipse per bullet past the first behind a Spread bands toggle beside Pro path", () => {
    // fails if either toggle is missing or unlabelled, or a toggle does not hide what it names
    scoped = spray();
    render(<AimPanels query={QUERY} label="t" visibility />);
    const boxes = Array.from(host.querySelectorAll<HTMLLabelElement>(".spray-toggles label"));
    expect(boxes.map((l) => l.textContent)).toEqual(["Spread bands", "Pro path"]);
    expect(host.querySelectorAll("svg.spray__plot ellipse")).toHaveLength(2);
    expect(host.querySelector(".spray-key")!.textContent).toContain("one standard deviation");
    act(() => boxes[0].querySelector("input")!.click());
    expect(host.querySelectorAll("svg.spray__plot ellipse")).toHaveLength(0);
    expect(host.querySelector(".spray-key")!.textContent).not.toContain("one standard deviation");
    expect(host.querySelector("svg.spray__plot .spray__pro")).not.toBeNull();
    act(() => boxes[1].querySelector("input")!.click());
    expect(host.querySelector("svg.spray__plot .spray__pro")).toBeNull();
    expect(host.querySelector(".spray-key")!.textContent).not.toContain("Pro median");
  });

  it("keeps a sprayed gun the recoil reference has no pro path for, drawn without a pro comparison", () => {
    // fails if the gun list drops guns without a pro path, or such a gun shows a Pro path toggle or a pro line
    scoped = summary({ sprays: 5, path: { cz75a: { n: [5, 5], dp: [3, 6], dy: [1, 2] } } });
    scoped.weapons.cz75a = gun({ shots: 15, hits: 3 });
    render(<AimPanels query={QUERY} label="t" visibility />);
    const btn = host.querySelector<HTMLButtonElement>('.gunlist__b[data-w="cz75a"]')!;
    expect(btn).not.toBeNull();
    act(() => btn.click());
    expect(host.querySelector(".spray__title")!.textContent).toBe("Your CZ75-Auto spray");
    expect(host.querySelector("svg.spray__plot .spray__pro")).toBeNull();
    expect(Array.from(host.querySelectorAll(".spray-toggles label")).map((l) => l.textContent)).toEqual(["Spread bands"]);
    expect(host.querySelector(".spray__note")!.textContent).toContain("no pro path");
  });

  it("lists every sprayed gun with its count after the name, fades a thin one with the reason, and draws no mark", () => {
    // fails if the hollow few-sprays mark comes back, a gun without sprays lists, or a thin gun loses its reason
    scoped = summary({ sprays: 3, sprayDist: [1.5, 2.5, 2] });
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    const rows = Array.from(host.querySelectorAll<HTMLButtonElement>(".gunlist__b"));
    // the knife is not a gun; the AK has three sprays without angles (a plugin file) and still lists
    expect(rows.map((b) => b.getAttribute("data-w"))).toEqual(["ak47"]);
    expect(rows[0].querySelector(".gunlist__n")!.textContent).toBe("AK-47 3");
    expect(rows[0].hasAttribute("data-thin")).toBe(true);
    expect(rows[0].getAttribute("data-tip")).toBe("3 sprays, the pattern settles at 30.");
    expect(host.querySelector(".gunlist__thin, .gunbtn__thin")).toBeNull();
    // without per-bullet angles the chart is the pro path alone, and the distance from the target shows
    expect(host.querySelector(".spray__title")!.textContent).toBe("AK-47: the pro path");
    expect(host.querySelector(".spray__dist b")!.textContent).toBe("2.00°");
    expect(host.querySelector(".spray__dist .meta")!.textContent).toBe("mean over 3 sprays");
    scoped = summary({ sprays: 0 });
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    expect(host.querySelectorAll(".gunlist__b")).toHaveLength(0);
    expect(host.querySelector(".aim-spray")!.textContent).toContain("No sprays of three bullets or more.");
  });

  it("shows the no-sprays state, not a skeleton, when no gun was fired on the side and class in view", () => {
    // fails if an empty gun set reads as loading (sprays only on T with Side set to CT left a skeleton)
    scoped = summary({ sprays: 0 });
    delete scoped.weapons.ak47;
    render(<AimPanels query={QUERY} label="t" visibility={false} />);
    const card = host.querySelector(".aim-spray")!;
    expect(card.querySelector(".skel")).toBeNull();
    expect(card.textContent).toContain("No sprays of three bullets or more.");
  });

  it("marks where the target's head was for each bullet, with its legend entry", () => {
    scoped = spray();
    render(<AimPanels query={QUERY} label="t" visibility />);
    expect(host.querySelectorAll("svg.spray__plot circle.spray__head")).toHaveLength(3);
    expect(host.querySelector(".spray-key")!.textContent).toContain("Where the target's head was");
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
    // fails if a status loses its reason or its tooltip, or the counts are wrong
    scoped = summary();
    render(<AimPanels query={QUERY} label="t" visibility={false} statuses={["no_mapdata", "mesh_mismatch", "mesh_mismatch", "ok"]} />);
    const why = host.querySelector(".gated__why")!;
    const lines = Array.from(why.querySelectorAll(".gated__reason"));
    expect(lines.map((l) => l.textContent)).toEqual(["One match file has no map data", "2 match files failed the mesh check"]);
    expect(lines[0].getAttribute("data-tip")).toContain("Plugin recordings never carry it");
    expect(lines[1].getAttribute("data-tip")).toContain("under 90% of non-wallbang kills");
    expect(lines.every((l) => l.getAttribute("tabindex") === "0")).toBe(true);
    expect(why.closest(".card")!.querySelector(".hint")!.getAttribute("data-tip")).toContain("90% of kills");
    render(<AimPanels query={QUERY} label="t" visibility={false} statuses={["no_mesh"]} />);
    expect(host.querySelector(".gated__why")!.textContent).toContain("This match file has no collision mesh");
  });
});

describe("empty states", () => {
  it("Career aim offers Data & settings as a button when no recorded match exists", () => {
    render(<BarProvider><CareerAim /></BarProvider>);
    const btn = host.querySelector<HTMLAnchorElement>(".empty a.btn")!;
    expect([btn.textContent, btn.getAttribute("href")]).toEqual(["Open Data & settings", "#/settings"]);
  });
});
