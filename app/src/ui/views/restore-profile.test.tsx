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
import { styleZone } from "../../stats/identity";
import { rating3FromInputs } from "../../stats/rating3";
import { emptyMeasures } from "../../stats/facts";
import { rollup } from "../../stats/rollup";
import type { Method, Query, Session } from "../../worker/protocol";
import { addCareerMatch, botPopulation, rankingCalls, sideQuery } from "../../worker/ranking";
import { entryOf, metaOf, ratingsOf, rolled } from "../../worker/views";
import { botIds, careerEntries, fmtMetric, multiKillRows } from "../data/engine";
import type { MatchEntry } from "../data/match";
import { metric, setMeta } from "../data/meta";
import type { Data } from "../data/provider";
import { sourceOf } from "../data/sources";
import { TILES } from "../data/series";
import { fmtPct } from "../lib/format";
import { BarProvider } from "../shell/Bar";
import ProfileView from "./Profile";
import { RatingTerms } from "./profile/parts";
import { RoleEvidence } from "./profile/evidence";
import { fmtChange, LuckCard } from "./profile/career";
import { evidenceScale, fmtRoleValue, splitEvidence } from "./profile/career-logic";
import { HomeView, workOnHref } from "./Home";
import { MatchesView } from "./Matches";
import { matchCalls } from "../../worker/matchcalls";
import { StatCard, useRanks } from "./profile/tabs";

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

it("shows the counts behind a share's row, from the rounds it ranked", async () => {
  // fails if "x of y" is dropped, or counts another side's rounds than the percentile beside it
  const q = queryOf(samples);
  answers.compare = await calls.compare(q, { side: "T" });
  answers.style = await calls.style(q, { side: "T" });
  function Rows() { return <StatCard title="Rows" tip="Rows." ids={["tradeKillSuccess", "openingSwing"]} r={useRanks(q, "T")} />; }
  render(<Rows />);
  const m = summary(sideQuery(q, "T")).m;
  const rowOf = (id: string) => Array.from(host.querySelectorAll(".mrow")).find((el) => el.querySelector(".mrow__lab")?.firstChild?.textContent === metric(id).label)!;
  expect(m.tradeOpps).toBeGreaterThan(0);
  expect(text(rowOf("tradeKillSuccess").querySelector(".mrow__smp"))).toBe(`${m.tradeOppsTaken} of ${m.tradeOpps}`);
  expect(text(rowOf("openingSwing").querySelector(".mrow__smp"))).toBe("");
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

it("gives each exact multi-kill count its percent of rounds", () => {
  // fails if the 2K row counts 3K rounds too, or a share is taken of something other than all rounds
  const m: Measures = { ...emptyMeasures(), rounds: 40, multiKillRounds: 10, k3Rounds: 4, k4Rounds: 1, k5Rounds: 1 };
  expect(multiKillRows(m).map((r) => [r.k, r.rounds, r.pct])).toEqual([[2, 6, 15], [3, 3, 7.5], [4, 0, 0], [5, 1, 2.5]]);
  expect(multiKillRows(emptyMeasures()).every((r) => r.pct === null)).toBe(true);
});

it("reaches every bot on the style compass from the keyboard, one tab stop for all", () => {
  // fails if the bots' hover cards open only on pointer hover, each dot is its own tab stop, or the
  // compass places you or a bot in another zone than the engine's opening attempts and trade/assist share give
  const career = samples.filter((s) => careerEntries([s.entry], null).length);
  use(career);
  render(<ProfileView tab="playstyle" />);
  const q = queryOf(career);
  const names = new Map(career.flatMap((s) => s.entry.players.filter((p) => p.bot).map((p) => [p.id, p.name] as const)));
  const zone = (v: Record<string, number | null>) => styleZone(v.openingAttempts!, v.tradeAssistShare!);
  // every bot career over the same matches with 20+ rounds and a kill or assist (Playstyle.tsx COMPASS_MIN_ROUNDS), left to right
  const bots = botIds(career.map((s) => s.entry))
    .map((id) => ({ id, s: rolled(summary({ files: q.files, filter: { player: [id] } })) }))
    .filter((b) => b.s.m.rounds >= 20 && b.s.v.tradeAssistShare !== null)
    .sort((a, b) => a.s.v.openingAttempts! - b.s.v.openingAttempts! || a.s.v.tradeAssistShare! - b.s.v.tradeAssistShare!);
  expect(bots.length).toBeGreaterThan(1);
  const dots = Array.from(host.querySelectorAll<SVGGElement>(".compass__dot"));
  expect(dots.map((d) => d.getAttribute("tabindex"))).toEqual(bots.map((_, i) => (i === 0 ? "0" : "-1")));
  expect(dots[0].getAttribute("aria-label")).toBe(`${names.get(bots[0].id)}: ${zone(bots[0].s.v)}, ${bots[0].s.m.rounds} rounds. Opening duels in ${Math.round(bots[0].s.v.openingAttempts!)}% of rounds, ${Math.round(bots[0].s.v.tradeAssistShare!)}% trades and assists.`);
  act(() => dots[0].focus());
  // focus opens the same card a pointer hover does
  expect(text(host.querySelector(".compass svg [pointer-events='none']"))).toBe(`${names.get(bots[0].id)}${zone(bots[0].s.v)}, ${bots[0].s.m.rounds} rounds`);
  act(() => { dots[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(document.activeElement).toBe(dots[1]);
  expect(dots.map((d) => d.getAttribute("tabindex"))).toEqual(bots.map((_, i) => (i === 1 ? "0" : "-1")));
  act(() => { dots[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  act(() => { dots[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  expect(document.activeElement).toBe(dots[dots.length - 1]);
  expect(text(host.querySelector(".compass__you"))).toBe(`You, ${zone(rolled(summary(q)).v)}`);
});

it("shows each side's role evidence in its unit on one track, with the engine's tip and range", async () => {
  // fails if a side shows the other side's value, a row loses its tip or its tick, or a measure
  // neither side has is drawn as a zero instead of named under the rows
  const q = queryOf(samples);
  const roles = await calls.roles(q);
  render(<RoleEvidence t={roles.T} ct={roles.CT} />);
  const { rows, missing } = splitEvidence(roles.T.metrics, roles.CT.metrics);
  expect(rows.length).toBeGreaterThan(3);
  for (const r of rows) {
    const li = host.querySelector(`.evid__row[data-metric="${r.id}"]`)!;
    const ref = (r.t ?? r.ct)!;
    expect(text(li.querySelector(".evid__v.t-text")), r.id).toBe(fmtRoleValue(r.t?.value ?? null, ref.unit));
    expect(text(li.querySelector(".evid__v.ct-text")), r.id).toBe(fmtRoleValue(r.ct?.value ?? null, ref.unit));
    expect(li.querySelector(".help")!.getAttribute("data-tip"), r.id).toBe(ref.tip);
    const sc = evidenceScale([r.t?.value ?? null, r.ct?.value ?? null], ref.proRange, ref.threshold, ref.unit);
    const tick = li.querySelector<HTMLElement>(".evtrk__tick");
    expect(tick?.style.left ?? null, r.id).toBe(sc.tick === null ? null : `${sc.tick}%`);
    expect(li.querySelectorAll(".evtrk__dot").length, r.id).toBe([r.t?.value, r.ct?.value].filter((v) => v !== null && v !== undefined).length);
    // the track is a keyboard stop with its own description
    expect(li.querySelector(".evtrk")!.getAttribute("tabindex")).toBe("0");
  }
  // area changes have no rollup value on either side: named once, never a row
  expect(missing.map((m) => m.id)).toContain("areaChanges");
  expect(host.querySelector('.evid__row[data-metric="areaChanges"]')).toBeNull();
  expect(text(host.querySelector(".evid__missing"))).toContain(missing.find((m) => m.id === "areaChanges")!.label);
});

it("lists the focus areas in Work on with their tips, and keeps the next weakest numbers reachable", async () => {
  // fails if a focus area loses its tip, the order stops being weakest first, or the old weakest
  // metrics vanish from Work on
  const career = converted.filter((s) => careerEntries([s.entry], null).length);
  use(career);
  const q = queryOf(career);
  answers.compare = await calls.compare(q, {});
  answers.attributes = await calls.attributes(q, {});
  answers.focusAreas = await calls.focusAreas(q, {});
  render(<HomeView />);
  const areas = (answers.focusAreas as Awaited<ReturnType<typeof calls.focusAreas>>).filter((f) => workOnHref(metric(f.id)) !== null).slice(0, 3);
  expect(areas.length).toBeGreaterThan(0);
  const items = Array.from(host.querySelectorAll(".workon__item")).filter((el) => el.querySelector(".workon__tip"));
  expect(items.map((el) => text(el.querySelector(".workon__top b")))).toEqual(areas.map((f) => metric(f.id).label));
  expect(items.map((el) => text(el.querySelector(".workon__tip")))).toEqual(areas.map((f) => f.tip));
  expect(items.map((el) => el.getAttribute("href"))).toEqual(areas.map((f) => workOnHref(metric(f.id))));
  const also = Array.from(host.querySelectorAll(".workon__also-a"));
  expect(also.length).toBeGreaterThan(0);
  for (const a of also) expect(areas.map((f) => metric(f.id).label)).not.toContain(text(a).replace(/\s*(Top|Bottom) \d+%$/, ""));
});

it("writes a period's change in the metric's unit, shares in points", () => {
  expect(fmtChange("adr", 4.26)).toBe("+4.3");
  expect(fmtChange("kast", -2.04)).toBe("−2.0 pts");
  expect(fmtChange("rating3", 0)).toBe("0.00");
});

it("says why the career has no luck score and keeps the luck the files do record", () => {
  // fails if a missing spread reads as a zero score, or the kill-flag rows lose their killfeed icons
  const career = samples.filter((s) => careerEntries([s.entry], null).length);
  const s = rolled(summary(queryOf(career)));
  render(<LuckCard s={s} />);
  // the bundled samples are plugin recordings, which carry no shot spread
  expect(s.m.spreadRounds).toBe(0);
  expect(s.v.luckScore).toBeNull();
  expect(host.querySelector(".luck__scale")).toBeNull();
  expect(text(host.querySelector(".luck__none"))).not.toBe("");
  const blind = byLabel(".mrow", ".mrow__lab", metric("blindKills").label);
  expect(s.v.blindKills).not.toBeNull();
  expect(text(blind?.querySelector(".mrow__val"))).toBe(fmtMetric("blindKills", s.v.blindKills));
});

it("narrows the match table to one session and back", async () => {
  // fails if a session chip filters by anything but its own matches, or pressing it again keeps the filter
  const career = samples.filter((s) => careerEntries([s.entry], null).length);
  use(samples);
  const q = queryOf(career);
  const each = async (files: string[], visit: (f: MatchFacts, file: string) => void) => { for (const f of files) visit(factsOf.get(f)!, f); };
  answers.sessions = await matchCalls(each, async (x) => summary(x)).sessions(q);
  const sessions = answers.sessions as Session[];
  expect(sessions.length).toBeGreaterThan(0);
  render(<MatchesView />);
  const files = () => Array.from(host.querySelectorAll(".matches__table [data-file]")).map((el) => el.getAttribute("data-file")).sort();
  const everything = files();
  const chips = Array.from(host.querySelectorAll<HTMLButtonElement>(".sess"));
  expect(chips.length).toBe(sessions.length);
  // newest first
  const newest = [...sessions].sort((a, b) => b.start - a.start)[0];
  act(() => chips[0].click());
  expect(chips[0].getAttribute("aria-pressed")).toBe("true");
  expect(files()).toEqual([...newest.files].sort());
  act(() => host.querySelector<HTMLButtonElement>(".sess")!.click());
  expect(files()).toEqual(everything);
});
