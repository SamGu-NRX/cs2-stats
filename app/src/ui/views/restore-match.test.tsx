// @vitest-environment jsdom
// The match slice's restored elements (REMOVALS.md, E20) against the bundled samples, each hook
// answered by the real engine the way the worker would answer it (as views.test.tsx does).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derive } from "../../stats/derive";
import type { MatchFacts } from "../../stats/facts";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { rollup } from "../../stats/rollup";
import { weaponLabel } from "../../stats/weapons";
import type { Method, Query, Rolled } from "../../worker/protocol";
import { entryOf, matchBundle, metaOf, rolled } from "../../worker/views";
import { MapAtmosphere, RadarView, frameFor } from "../components/MapArt";
import { matchModel, roundColumns, type MatchEntry, type MatchModel } from "../data/match";
import { setMeta } from "../data/meta";
import type { Data } from "../data/provider";
import { KillFlags } from "../icons/game";
import { BarProvider } from "../shell/Bar";
import Weapons from "./Weapons";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");

interface Sample { file: string; facts: MatchFacts; entry: MatchEntry }
const samples: Sample[] = await Promise.all(readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz")).map(async (f) => {
  const m = await decodeMatch(gunzipSync(readFileSync(path.join(SAMPLES, f))), f);
  const facts = derive(pluginToTables(m), CS2RB);
  const file = `samples/${f}`;
  return { file, facts, entry: entryOf(file, m.env.plugin ?? "", facts) };
}));
const byName = (part: string) => samples.find((s) => s.file.includes(part))!;
const factsOf = new Map(samples.map((s) => [s.file, s.facts]));
const summary = (q: Query) => rollup(q.files.map((f) => factsOf.get(f)!), q.filter);
const modelOf = (s: Sample): MatchModel => matchModel(s.entry, matchBundle(s.entry, s.facts));

let data: Pick<Data, "matches" | "you"> = { matches: [], you: [] };
/** a test's own rollup answers; by default the real engine answers */
let rollupOf: ((q: Query) => Rolled) | null = null;
const done = <T,>(x: T | null) => ({ data: x, error: null, loading: false });

vi.mock("../data/provider", () => ({
  useData: () => ({ ...data, status: "ready", host: null, client: null, baselines: null, baselinesError: null }),
}));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useRollups: (qs: Query[] | null) => done(qs?.length ? qs.map((q) => (rollupOf ? rollupOf(q) : rolled(summary(q)))) : null),
  useCall: (_method: Method, _args: unknown[] | null) => done(null),
  useMatch: () => done(null),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;
globalThis.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
// jsdom has no 2D canvas; the sampled shape only needs its canvas element to exist here
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
setMeta(metaOf(CS2RB));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  rollupOf = null;
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});
const render = (ui: JSX.Element) => act(() => root.render(<BarProvider>{ui}</BarProvider>));
const use = (list: Sample[]) => { data = { matches: list.map((s) => s.entry), you: [...new Set(list.map((s) => s.facts.match.pov!))] }; };
const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";

describe("kill flags", () => {
  const base = { headshot: false, wallbang: false, smoke: false, noscope: false };
  const labels = () => Array.from(host.querySelectorAll(".kflags [aria-label]")).map((el) => el.getAttribute("aria-label"));

  it("shows Killer was blind and Airborne only when the kill records them as true", () => {
    // fails if a flag the source did not record (null) shows as set, or a recorded one is dropped
    render(<KillFlags kill={{ ...base, killerBlind: true, killerInAir: null }} />);
    expect(labels()).toEqual(["Killer was blind"]);
    render(<KillFlags kill={{ ...base, headshot: true, killerBlind: null, killerInAir: true }} />);
    expect(labels()).toEqual(["Headshot", "Airborne"]);
    render(<KillFlags kill={{ ...base, killerBlind: false, killerInAir: null }} />);
    expect(host.querySelector(".kflags")).toBeNull();
  });
});

describe("totals-only rounds", () => {
  // round 5 of this converted log is held only as totals
  const s = byName("8ecfd307");

  it("puts a totals-only round between its neighbours, and a side swap before the round it falls before", () => {
    // fails if a totals-only round is left out, lands out of number order, or moves the half gap off its round
    const v = modelOf(s);
    expect(s.facts.match.totalsOnly).toEqual([5]);
    expect(roundColumns(v).map((c) => `${c.number}${c.kind === "totals" ? "t" : ""}`)).toEqual(["1", "2", "3", "4", "5t", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
    // the synthetic demo with round 13, the first of the second half, held as totals
    const d = modelOf(byName("synthetic"));
    const gap: MatchModel = { ...d, rounds: d.rounds.filter((r) => r.number !== 13), facts: { ...d.facts, match: { ...d.facts.match, totalsOnly: [13] } } };
    const halves = roundColumns(gap).filter((c) => c.halfStart).map((c) => [c.number, c.kind]);
    expect(halves).toEqual([[13, "totals"]]);
  });

  it("gives a totals-only column the game's own per-player totals", () => {
    // fails if the column loses MatchCore.totalsRounds, so the match views cannot draw a totals-only round
    const v = modelOf(s);
    const col = roundColumns(v).find((c) => c.number === 5)!;
    expect(col.kind === "totals" && col.totals).toEqual(s.facts.totalsRounds.find((t) => t.number === 5));
    expect(col.kind === "totals" && col.totals && col.totals.players.length).toBe(v.players.length);
  });
});

describe("Weapons", () => {
  const d = byName("synthetic");
  const groups = (head: number) => [head, 0, 0, 0, 0, 0, 0, 0];
  const gun = (shots: number, hits: number, head: number, kills: number, hsKills: number) => ({ shots, hits, groups: groups(head), dmg: 0, kills, hsKills, deaths: 0, rounds: 5 });
  /** per-gun accuracy, first-bullet accuracy and first bullets, and the same for every other gun pooled */
  const one: Record<string, [number, number | null, number | null, number]> = {
    ak47: [100, 30, 20, 20], glock: [100, 25, 40, 20], deagle: [10, 50, null, 0], usp_silencer: [5, 20, null, 0],
  };
  const others: Record<string, [number, number | null, number | null, number]> = {
    ak47: [115, 25, 40, 20], glock: [115, 30, 20, 20], deagle: [205, 27.5, 30, 40], usp_silencer: [210, 27.5, 30, 40],
  };
  const cell = (row: Element | undefined, header: string) => {
    const at = Array.from(host.querySelectorAll("thead th")).findIndex((th) => text(th) === header);
    return text(row?.querySelectorAll("td")[at]);
  };

  it("reads advice, HS kills and head share off each gun's numbers against your other guns", () => {
    // fails if advice ignores a gate (40 shots, 10 first bullets a side, 15 hits, snipers), compares with
    // the wrong pool, or the heroes lose their advice; or HS kills and head share use the wrong counts
    use([d]);
    const base = rolled(summary({ files: [d.file], filter: { player: d.facts.match.pov! } }));
    const weapons = { ak47: gun(100, 30, 3, 10, 4), glock: gun(100, 25, 10, 6, 1), deagle: gun(10, 5, 1, 2, 2), usp_silencer: gun(5, 1, 0, 0, 0) };
    rollupOf = (q) => {
      const w = q.filter.weapons;
      if (!w) return { ...base, weapons };
      const missing = Object.keys(weapons).find((x) => !w.includes(x))!;
      const [shots, accuracy, firstBulletAccuracy, first] = w.length === 1 ? one[w[0]] : others[missing];
      return { ...base, aim: { ...base.aim, shots, first }, v: { ...base.v, accuracy, firstBulletAccuracy } };
    };
    render(<Weapons />);
    const row = (w: string) => Array.from(host.querySelectorAll("tbody tr")).find((tr) => tr.querySelector(".guncell")?.childNodes[1]?.textContent === weaponLabel(w));
    expect(cell(row("ak47"), "Advice")).toBe("You hit 5.0 points more often than with your other guns. Your first bullet lands 20 points less often than with your other guns: stop moving before you fire. Only 10% of hits are on the head: keep the crosshair at head height.");
    expect(cell(row("glock"), "Advice")).toBe("You hit 5.0 points less often than with your other guns.");
    expect(cell(row("deagle"), "Advice")).toBe("2 kills so far; 40 recorded shots are needed to judge your aim with it.");
    expect(cell(row("usp_silencer"), "Advice")).toBe("Fire it in a recorded match to see how you shoot with it.");
    expect([cell(row("ak47"), "HS kills"), cell(row("ak47"), "Head share")]).toEqual(["40.0%", "10.0%"]);
    expect(text(host.querySelector(".gunhero--best .gunhero__advice"))).toBe(cell(row("ak47"), "Advice"));
    expect(text(host.querySelector(".gunhero--worst .gunhero__advice"))).toBe(cell(row("glock"), "Advice"));
  });
});

describe("sampled map shape", () => {
  const d = byName("synthetic");
  const conv = byName("abe5d91c");

  it("draws the sampled shape when the radar image fails to load", () => {
    // fails if a radar whose image fails stays blank though the matches hold position samples
    use([d]);
    render(<RadarView map="de_dust2" frame={frameFor("de_dust2")!} label="radar"><circle r={1} /></RadarView>);
    expect(host.querySelector("canvas")).toBeNull();
    act(() => { host.querySelector("img.radar-img")!.dispatchEvent(new Event("error")); });
    expect(host.querySelector(".radar-view canvas.radar-img")).not.toBeNull();
  });

  it("gives an unknown map's hero its sampled shape, and nothing without samples", () => {
    // fails if a map with no known transform loses its atmosphere though samples exist, or draws one without them
    const alias = (x: Sample, file: string): Sample => {
      const facts = { ...x.facts, match: { ...x.facts.match, map: "de_nowhere" } };
      factsOf.set(file, facts);
      return { file, facts, entry: { ...x.entry, file, match: facts.match } };
    };
    use([alias(d, "samples/nowhere-demo")]);
    render(<MapAtmosphere map="de_nowhere" />);
    expect(host.querySelector(".atmos--map canvas")).not.toBeNull();
    use([alias(conv, "samples/nowhere-log")]);
    render(<MapAtmosphere map="de_nowhere" />);
    expect(host.querySelector(".atmos")).toBeNull();
  });
});
