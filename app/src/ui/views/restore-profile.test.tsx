// @vitest-environment jsdom
// Main's Home, Profile and Playstyle elements brought back on the new engine (REMOVALS.md, E20, the
// profile slice), rendered against the bundled samples with each hook answered by the real engine, as
// views.test.tsx does.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Baselines } from "../../stats/compare";
import { derive } from "../../stats/derive";
import type { MatchFacts, Measures } from "../../stats/facts";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { rating3FromInputs } from "../../stats/rating3";
import { emptyMeasures } from "../../stats/facts";
import { rollup } from "../../stats/rollup";
import type { CompassResult, Method, Query } from "../../worker/protocol";
import { addCareerMatch, botPopulation, rankingCalls, sideQuery } from "../../worker/ranking";
import { entryOf, metaOf, ratingsOf, rolled } from "../../worker/views";
import { careerEntries, fmtMetric, multiKillRows, signalBar } from "../data/engine";
import type { MatchEntry } from "../data/match";
import { metric, setMeta } from "../data/meta";
import type { Data } from "../data/provider";
import { sourceOf } from "../data/sources";
import { TILES } from "../data/series";
import { fmtPct } from "../lib/format";
import { BarProvider } from "../shell/Bar";
import { HomeView } from "./Home";
import Playstyle from "./Playstyle";
import { HowGood, RatingTerms } from "./profile/parts";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");
const PROS = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../public/baselines.json"), "utf8")) as Baselines;

interface Sample { file: string; facts: MatchFacts; entry: MatchEntry }
const samples: Sample[] = await Promise.all(readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz")).map(async (f) => {
  const m = await decodeMatch(gunzipSync(readFileSync(path.join(SAMPLES, f))), f);
  const facts = derive(pluginToTables(m), CS2RB);
  const file = `samples/${f}`;
  return { file, facts, entry: entryOf(file, m.env.plugin ?? "", facts) };
}));
const factsOf = new Map(samples.map((s) => [s.file, s.facts]));
const summary = (q: Query) => rollup(q.files.map((f) => factsOf.get(f)!), q.filter);
const converted = samples.filter((s) => sourceOf(s.entry).id === "converted");

const calls = rankingCalls({
  summary: async (q) => summary(q),
  pros: async () => PROS,
  careers: async (q) => {
    const careers = new Map<string, Parameters<typeof botPopulation>[0][number]>();
    const matches: Parameters<typeof botPopulation>[1] = [];
    for (const f of q.files) addCareerMatch(careers, matches, factsOf.get(f)!, {});
    return botPopulation([...careers.values()], matches, "test");
  },
});

let data: Pick<Data, "matches" | "you"> = { matches: [], you: [] };
const baselines = { source: PROS.source, built: PROS.built, n: PROS.n };
let answers: Partial<Record<Method, unknown>> = {};
const done = <T,>(x: T | null) => ({ data: x, error: null, loading: false });

vi.mock("../data/provider", () => ({
  useData: () => ({ ...data, status: "ready", host: null, client: null, baselines, baselinesError: null }),
}));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useRollups: (qs: Query[] | null) => done(qs?.length ? qs.map((q) => rolled(summary(q))) : null),
  useRatings: (qs: Query[] | null) => done(qs?.length ? qs.map((q) => ratingsOf({ both: summary(sideQuery(q, "both")), T: summary(sideQuery(q, "T")), CT: summary(sideQuery(q, "CT")) })) : null),
  useCall: (method: Method, args: unknown[] | null) => done(args ? answers[method] ?? null : null),
  useMatch: () => done(null),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;
globalThis.matchMedia ??= ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
setMeta(metaOf(CS2RB));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  answers = {};
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});
const render = (ui: JSX.Element) => act(() => root.render(<BarProvider>{ui}</BarProvider>));
const use = (list: Sample[]) => { data = { matches: list.map((s) => s.entry), you: [...new Set(list.map((s) => s.facts.match.pov!))] }; };
const queryOf = (list: Sample[]): Query => ({ files: list.map((s) => s.file), filter: { player: [...new Set(list.map((s) => s.facts.match.pov!))] } });
const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? "";
const byLabel = (sel: string, label: string, name: string) => Array.from(host.querySelectorAll(sel)).find((el) => text(el.querySelector(label)) === name) ?? null;

it("gives each headline tile the last match against the filter's value", () => {
  // fails if a tile loses its delta, or measures the last match against something other than the pooled value it shows
  const career = converted.filter((s) => careerEntries([s.entry], null).length);
  use(career);
  render(<HomeView />);
  const list = careerEntries(career.map((s) => s.entry), null);
  const pooled = rolled(summary(queryOf(career.filter((s) => list.some((e) => e.file === s.file))))).v.adr!;
  const d = list[0].line.v.adr! - pooled;
  const adr = TILES.find((t) => t.id === "adr")!;
  const delta = byLabel(".tile", ".stat__l", "ADR")?.querySelector(".tile__delta .delta");
  expect(text(delta)).toBe(adr.fmtDelta(Math.abs(d)));
  expect(delta?.querySelector("path")?.getAttribute("d")).toBe(d > 0 ? "M3.5 0L7 6H0z" : "M3.5 6L0 0h7z");
});

it("adds the survival and traded-death rates to the KAST tile's breakdown", () => {
  // fails if "Rounds survived" or "Deaths traded" is dropped from the KAST card, or divides by the wrong count
  const career = converted.filter((s) => careerEntries([s.entry], null).length);
  use(career);
  render(<HomeView />);
  act(() => (byLabel(".tile", ".stat__l", "KAST") as HTMLElement).focus());
  const s = rolled(summary(queryOf(career)));
  const row = (label: string) => Array.from(document.querySelectorAll(".hcard .bd__row")).find((r) => text(r.firstElementChild) === label);
  expect(text(row("Rounds survived")?.querySelector("b"))).toBe(fmtPct((100 * s.m.survived) / s.m.rounds));
  expect(text(row("Deaths traded")?.querySelector("b"))).toBe(fmtPct((100 * s.m.tradedDeaths) / s.m.deaths));
});

it("breaks Rating 3.0 into weighted terms and a constant that add up to the rating", () => {
  // fails if a weight, an input or the constant shown in the rating breakdown is not the one the rating is computed from
  const inputs = { kpr_eco: 0.74, adr_eco: 78.2, dpr_eco: 0.66, kast_eco: 71.5, mk: 14.0, swing: 1.25 };
  render(<RatingTerms inputs={inputs} />);
  const rows = Array.from(host.querySelectorAll(".bd__row"));
  expect(rows.length).toBe(7);
  expect(text(rows[6].firstElementChild)).toBe("Constant");
  // each value reads "input → ±contribution"; the contributions are rounded to 0.001 apiece
  const sum = rows.reduce((a, r) => {
    const v = text(r.querySelector("b")).split("→").pop()!.trim().replace("−", "-");
    return a + Number(v);
  }, 0);
  expect(Math.abs(sum - rating3FromInputs(inputs))).toBeLessThan(0.0005 * 7);
  expect(text(rows[0].querySelector("b"))).toMatch(/^0\.74 → \+0\.\d{3}$/);
});

it("shows the counts behind How good's shares, from the rounds it ranked", async () => {
  // fails if "x of y" is dropped, or counts another side's rounds than the percentile beside it
  const q = queryOf(samples);
  answers.compare = await calls.compare(q, { side: "T" });
  render(<HowGood q={q} side="T" />);
  const m = summary(sideQuery(q, "T")).m;
  const row = Array.from(host.querySelectorAll(".howgood li")).find((li) => li.firstElementChild?.firstChild?.textContent === metric("tradeKillSuccess").label)!;
  expect(m.tradeOpps).toBeGreaterThan(0);
  expect(text(row.querySelector(".howgood__of"))).toBe(`${m.tradeOppsTaken} of ${m.tradeOpps}`);
  const noOf = Array.from(host.querySelectorAll(".howgood li")).find((li) => li.firstElementChild?.firstChild?.textContent === metric("openingSwing").label)!;
  expect(noOf.querySelector(".howgood__of")).toBeNull();
});

it("shows Firepower's score and its lowest-ranked metric in Work on", async () => {
  // fails if Work on drops the attribute score or names a metric that is not Firepower's weakest
  const career = converted.filter((s) => careerEntries([s.entry], null).length);
  use(career);
  const q = queryOf(career);
  answers.compare = await calls.compare(q, {});
  answers.attributes = await calls.attributes(q, {});
  render(<HomeView />);
  const fire = (answers.attributes as Awaited<ReturnType<typeof calls.attributes>>).scores.find((a) => a.id === "firepower")!;
  const worst = fire.metrics.filter((x) => x.pct !== null).sort((a, b) => a.pct! - b.pct!)[0];
  const item = byLabel(".workon__item", ".workon__top b", "Firepower")!;
  expect(item).not.toBeNull();
  expect(text(item.querySelector(".workon__top .num"))).toBe(`${Math.round(fire.score!)}/100`);
  expect(text(item.querySelector(".workon__body > .meta"))).toBe(`${metric(worst.id).label} ${fmtMetric(worst.id, worst.value)}`);
});

it("fills a role signal's bar to twice its threshold and says you fit from the threshold up", () => {
  // fails if "You fit" appears below the threshold or the tick stops marking it
  expect(signalBar(25, 25)).toEqual({ fill: 0.5, fits: true });
  expect(signalBar(24.9, 25).fits).toBe(false);
  expect(signalBar(80, 25).fill).toBe(1);
});

it("gives each exact multi-kill count its percent of rounds", () => {
  // fails if the 2K row counts 3K rounds too, or a share is taken of something other than all rounds
  const m: Measures = { ...emptyMeasures(), rounds: 40, multiKillRounds: 10, k3Rounds: 4, k4Rounds: 1, k5Rounds: 1 };
  expect(multiKillRows(m).map((r) => [r.k, r.rounds, r.pct])).toEqual([[2, 6, 15], [3, 3, 7.5], [4, 0, 0], [5, 1, 2.5]]);
  expect(multiKillRows(emptyMeasures()).every((r) => r.pct === null)).toBe(true);
});

it("reaches every bot on the style compass from the keyboard, one tab stop for all", () => {
  // fails if the bots' hover cards open only on pointer hover, or each dot is its own tab stop
  use(samples);
  const dot = (name: string, x: number, y: number) => ({ name, rounds: 160, x, y, label: "Rifler" });
  const c: CompassResult = {
    you: { name: "You", rounds: 300, x: 30, y: 50, label: "Rifler (Entry and support)" },
    bots: [dot("Zed", 40, 20), dot("Abe", 10, 20), dot("Mia", 20, 60)],
    careers: { unit: "careers", botMatches: 30, qualified: 3, needed: 15, minRounds: 150, provisional: true, minPool: 8 },
  };
  answers.compass = c;
  render(<Playstyle />);
  const dots = Array.from(host.querySelectorAll<SVGGElement>(".compass__dot"));
  expect(dots.map((d) => d.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  // left to right: Abe (10), Mia (20), Zed (40)
  expect(dots[0].getAttribute("data-tip")).toMatch(/^Abe: Rifler, 160 rounds\./);
  act(() => dots[0].focus());
  act(() => { dots[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(document.activeElement).toBe(dots[1]);
  expect(dots.map((d) => d.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  expect(text(host.querySelector(".compass__you"))).toBe("You, Rifler (Entry and support)");
});
