// @vitest-environment jsdom
// The views against the bundled samples (five converted logs and the synthetic demo), each hook
// answered by the real engine the way the worker would answer it: rollups and ratings from rollup(),
// comparisons from the worker's ranking calls with public/baselines.json and the samples' bot careers.
// Under CS2RB the shipped baselines were built with another model, so the model-dependent metrics
// carry a comparison reason here, as they do for a user without the HLTV pack.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Baselines } from "../../stats/compare";
import { derive } from "../../stats/derive";
import type { MatchFacts } from "../../stats/facts";
import { isGun } from "../../stats/guns";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { rollup } from "../../stats/rollup";
import { weaponLabel } from "../../stats/weapons";
import type { Method, Query } from "../../worker/protocol";
import { addCareerMatch, botPopulation, rankingCalls, sideQuery } from "../../worker/ranking";
import { entryOf, matchBundle, metaOf, ratingsOf, rolled } from "../../worker/views";
import { careerEntries, fmtMetric, provisionalText, statLine } from "../data/engine";
import { matchModel, type MatchEntry, type MatchModel } from "../data/match";
import { metric, metrics, setMeta } from "../data/meta";
import type { Data } from "../data/provider";
import { sourceOf } from "../data/sources";
import { fmtSwing, signed } from "../lib/format";
import { BarProvider } from "../shell/Bar";
import { HomeView } from "./Home";
import Playstyle from "./Playstyle";
import { HowGood } from "./profile/parts";
import { Provisional } from "./shared";
import { MatchesView } from "./Matches";
import Overview from "./match/Overview";
import Rounds from "./match/Rounds";
import Utility from "./match/Utility";
import Weapons from "./Weapons";

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");
const PROS = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../public/baselines.json"), "utf8")) as Baselines;

interface Sample { file: string; facts: MatchFacts; entry: MatchEntry }
const samples: Sample[] = await Promise.all(readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz")).map(async (f) => {
  // jsdom's Blob cannot stream, so the gzip is opened here; decodeMatch reads the JSON as it is
  const m = await decodeMatch(gunzipSync(readFileSync(path.join(SAMPLES, f))), f);
  const facts = derive(pluginToTables(m), CS2RB);
  const file = `samples/${f}`;
  return { file, facts, entry: entryOf(file, m.env.plugin ?? "", facts) };
}));
const factsOf = new Map(samples.map((s) => [s.file, s.facts]));
// The views ask for the same queries on every render; the samples never change, so each is rolled up once.
const rolledUp = new Map<string, ReturnType<typeof rollup>>();
const summary = (q: Query) => {
  const k = JSON.stringify(q);
  let s = rolledUp.get(k);
  if (!s) rolledUp.set(k, (s = rollup(q.files.map((f) => factsOf.get(f)!), q.filter)));
  return s;
};
const converted = samples.filter((s) => sourceOf(s.entry).id === "converted");
const modelOf = (s: Sample): MatchModel => matchModel(s.entry, matchBundle(s.entry, s.facts));

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

// What the mocked provider and hooks answer: the match list, your ids, and the worker's answers by method.
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
globalThis.IntersectionObserver ??= class { observe() {} disconnect() {} unobserve() {} takeRecords() { return []; } } as unknown as typeof IntersectionObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;
// not in jsdom; reduced motion, so charts and the drawer draw their end state
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
/** The element among `sel` whose `label` child reads exactly `name`. */
const byLabel = (sel: string, label: string, name: string) => Array.from(host.querySelectorAll(sel)).find((el) => text(el.querySelector(label)) === name) ?? null;

describe("comparison reasons", () => {
  it("shows How good's uncompared values with their reason, never a rank or a dash", async () => {
    // fails if a metric the engine could not compare (Percentile.reason) shows "Top x%", "Bottom x%" or a
    // dash where the reason belongs, or loses its value
    const q = queryOf(samples);
    const r = await calls.compare(q, { side: "both" });
    answers.compare = r;
    render(<HowGood q={q} side="both" />);
    const rows = Array.from(host.querySelectorAll(".howgood li"));
    const rowOf = (id: string) => rows.find((li) => li.firstElementChild?.firstChild?.textContent === metric(id).label)!;
    const reasoned = Object.values(r.p).filter((x) => x.reason && rows.some((li) => li === rowOf(x.id)));
    expect(reasoned.length).toBeGreaterThan(0);
    for (const x of reasoned) {
      const li = rowOf(x.id);
      expect(li.querySelector(".nocmp")?.getAttribute("data-tip"), x.id).toBe(x.reason);
      expect(text(li.querySelector("b")), x.id).toBe(fmtMetric(x.id, x.value));
      expect(text(li), x.id).not.toMatch(/Top \d|Bottom \d/);
    }
    const ranked = Object.values(r.p).find((x) => !x.reason && x.pct !== null && rows.some((li) => li === rowOf(x.id)))!;
    expect(text(rowOf(ranked.id))).toMatch(/Top \d+%|Bottom \d+%/);
  });

  it("marks How good's approx metrics, and only those", async () => {
    // fails if How good drops the ≈ marker from a metric whose status is "approx", or puts it on an exact one
    const q = queryOf(samples);
    answers.compare = await calls.compare(q, { side: "both" });
    render(<HowGood q={q} side="both" />);
    const rows = Array.from(host.querySelectorAll(".howgood li"));
    expect(rows.length).toBeGreaterThan(0);
    const statuses = new Set<string>();
    for (const li of rows) {
      const m = metrics().find((x) => x.label === li.firstElementChild?.firstChild?.textContent)!;
      statuses.add(m.status);
      expect(!!li.querySelector(".approx"), m.id).toBe(m.status === "approx");
    }
    expect(statuses).toContain("approx");
    expect(statuses).toContain("exact");
  });

  it("shows Where you rank's uncompared values with their reason", async () => {
    // fails if a Playstyle rank row shows a rank or a dash for a value the engine could not compare
    use(samples);
    const q = queryOf(samples);
    answers.compare = await calls.compare(q, { pool: "all" });
    answers.style = await calls.style(q, { pool: "all" });
    render(<Playstyle />);
    const p = { ...(answers.compare as { p: object }).p, ...(answers.style as { p: object }).p } as Record<string, { reason: string | null }>;
    const rows = Array.from(host.querySelectorAll(".ranks__group li"));
    const reasoned = rows.filter((li) => {
      const m = metrics().find((x) => li.querySelector(".ranks__l")?.firstChild?.textContent === x.label)!;
      return p[m.id].reason;
    });
    expect(reasoned.length).toBeGreaterThan(0);
    for (const li of reasoned) {
      const m = metrics().find((x) => li.querySelector(".ranks__l")?.firstChild?.textContent === x.label)!;
      expect(li.querySelector(".ranks__p .nocmp")?.getAttribute("data-tip"), m.id).toBe(p[m.id].reason);
    }
  });
});

describe("Home", () => {
  it("labels the hero's deltas with your average and gives the pooled tiles none", () => {
    // fails if a pooled tile shows a delta, or the hero's delta does not name the average it is measured from
    use(converted);
    render(<HomeView />);
    const adr = byLabel(".hero-stat", ".stat__l", "ADR");
    const tile = byLabel(".tile", ".stat__l", "ADR");
    expect(text(adr?.querySelector(".hero-stat__vs"))).toBe(`vs your ${text(tile?.querySelector(".tile__v"))}`);
    expect(adr?.querySelector(".delta")).not.toBeNull();
    expect(host.querySelectorAll(".tile .delta").length).toBe(0);
  });

  it("draws a tile's sparkline only from three or more matches", () => {
    // fails if a tile draws a trend line through one or two matches
    // one converted sample covers under half its rounds, so career views (and the tiles) leave it out
    const career = converted.filter((s) => careerEntries([s.entry], null).length);
    use(career.slice(0, 2));
    render(<HomeView />);
    expect(byLabel(".tile", ".stat__l", "ADR")?.querySelector(".spark")).toBeNull();
    use(career.slice(0, 3));
    render(<HomeView />);
    expect(byLabel(".tile", ".stat__l", "ADR")?.querySelector(".spark")).not.toBeNull();
  });

  it("says a stat the matches cannot give needs a recorded demo, linked to Data & settings", () => {
    // fails if a missing-data tile uses another phrasing or loses the link to the recording source
    use(converted);
    render(<HomeView />);
    const gaps = [byLabel(".tile", ".stat__l", "Accuracy"), byLabel(".tile", ".stat__l", "Reaction, time to damage")];
    for (const t of gaps) {
      expect(text(t?.querySelector(".needs__t"))).toBe("Needs a recorded demo");
      expect(t?.querySelector<HTMLAnchorElement>(".needs__link")?.getAttribute("href")).toBe("#/settings");
    }
  });
});

it("puts the provisional sentence in the Provisional chip's tooltip", () => {
  // fails if the provisional sentence shows inline again instead of under a "Provisional" chip
  const c = { unit: "matches" as const, botMatches: 12, qualified: 3, needed: 15, minRounds: 150, provisional: true, minPool: 8 };
  render(<Provisional c={c} />);
  const chip = host.querySelector(".chip--prov")!;
  expect(text(chip)).toBe("Provisional");
  expect(chip.getAttribute("data-tip")).toContain(provisionalText(c));
});

it("shows the round grid's swing per round, as the scoreboard does, with the sum in its tooltip", () => {
  // fails if the round grid's swing column shows the match's sum while the hero and scoreboard show the per-round average
  const s = converted.find((x) => rollup([x.facts], { player: x.facts.match.pov! }).m.swingRounds > 1)!;
  const v = modelOf(s);
  render(<Rounds v={v} file={v.file} round={null} />);
  const line = v.b.lines.both[v.human];
  const cell = host.querySelector(".ig__row.is-you .ig__total")!;
  expect(fmtSwing(statLine(line).swing)).not.toBe(fmtSwing(line.m.swing));
  expect(text(cell)).toBe(fmtSwing(statLine(line).swing));
  expect(cell.getAttribute("data-tip")).toContain(fmtSwing(line.m.swing));
});

describe("match views", () => {
  const s = converted.find((x) => x.facts.kills.some((k) => k.tradeKill))!;
  const v = modelOf(s);
  const num = (el: Element | null | undefined) => Number((el?.textContent ?? "").replace(/\s*\(.*\)$/, ""));

  it("totals each scoreboard's counts under its five players, with traded deaths and flash assists in brackets", () => {
    // fails if the team total drops or double-counts a player, or D (t) / A (f) read the wrong measure
    answers = { clutches: [] };
    render(<Overview v={v} file={v.file} round={null} />);
    const board = host.querySelector(".board")!;
    const heads = Array.from(board.querySelectorAll("thead th")).map((th) => th.textContent);
    const K = heads.indexOf("K"), D = heads.indexOf("D (t)"), A = heads.indexOf("A (f)");
    expect(Math.min(K, D, A)).toBeGreaterThan(0);
    const body = Array.from(board.querySelectorAll("tbody tr"));
    const total = board.querySelector("tfoot tr")!;
    expect(body).toHaveLength(5);
    const us = v.players.filter((p) => p.team === "us");
    const sum = (f: (m: MatchModel["b"]["lines"]["both"][number]["m"]) => number) => us.reduce((a, p) => a + f(v.b.lines.both[p.pi].m), 0);
    expect(num(total.children[K])).toBe(sum((m) => m.kills));
    expect(total.children[D].textContent).toBe(`${sum((m) => m.deaths)} (${sum((m) => m.tradedDeaths)})`);
    expect(total.children[A].textContent).toBe(`${sum((m) => m.assists)} (${sum((m) => m.flashAssists)})`);
    const you = board.querySelector("tbody tr.is-you")!;
    const m = v.b.lines.both[v.human].m;
    expect(you.children[D].textContent).toBe(`${m.deaths} (${m.tradedDeaths})`);
  });

  it("marks each grid cell with the player's kills as a number and one cross for a death", () => {
    // fails if a cell's kill count or death mark disagrees with the round's kills
    render(<Rounds v={v} file={v.file} round={null} />);
    // a player who killed and died in the same round, so both marks share one cell
    const k = v.facts.kills.find((x) => x.enemy && x.killer !== null && v.facts.kills.some((y) => y.ri === x.ri && y.victim === x.killer))!;
    const pi = k.killer!, r = v.rounds[k.ri];
    const cell = Array.from(host.querySelectorAll(".ig__cell")).find((c) => c.getAttribute("aria-label")?.startsWith(`${v.players[pi].name}, Round ${r.number} `))!;
    const kills = r.kills.filter((x) => x.killer === pi && x.enemy).length;
    expect(cell.querySelector(".ig__k")?.textContent).toBe(String(kills));
    expect(cell.querySelectorAll(".ig__death")).toHaveLength(1);
  });

  it("leaves an unfinished match that never left 0–0 out of the match list", () => {
    // fails if an aborted lobby (no round played) shows as a match, or a finished match is hidden
    const blank: MatchEntry = { ...s.entry, file: "blank.json.gz", score: { us: 0, them: 0 }, match: { ...s.entry.match, complete: false } };
    data = { matches: [s.entry, blank], you: [s.facts.match.pov!] };
    render(<MatchesView />);
    expect(host.querySelector('[data-file="blank.json.gz"]')).toBeNull();
    expect(host.querySelector(`[data-file="${s.entry.file}"]`)).not.toBeNull();
  });
});

it("plots a rebuilt file's detonations as approximate landing points, and a logged file's landings as they are", () => {
  // fails if a file whose throws were rebuilt from detonations shows an empty landing map or presents its
  // points as exact, or a file with a throw log is labelled approximate
  const s = converted[1];
  expect(s.facts.match.inputs.throws).toBe("rebuilt");
  const v = modelOf(s);
  render(<Utility v={v} file={v.file} round={null} />);
  expect(text(host.querySelector(".chip--approx"))).toBe("Approximate");
  expect(host.querySelector(".hint")?.getAttribute("data-tip")).toContain("Points are detonations");
  expect(host.querySelectorAll(".landing__map circle").length).toBeGreaterThan(0);
  // the same match with a throw log but no landing points: nothing to place, nothing approximate
  const logged: MatchModel = { ...v, facts: { ...v.facts, match: { ...v.facts.match, inputs: { ...v.facts.match.inputs, throws: "logged" } } } };
  render(<Utility v={logged} file={v.file} round={null} />);
  expect(host.querySelector(".chip--approx")).toBeNull();
  expect(host.querySelector(".landing__map")).toBeNull();
});

describe("Weapons", () => {
  const all = queryOf(samples);
  const rowOf = (gun: string) => Array.from(host.querySelectorAll("tbody tr")).find((tr) => tr.querySelector(".guncell")?.childNodes[1]?.textContent === weaponLabel(gun)) ?? null;
  const col = (tr: Element | null, i: number) => tr?.querySelectorAll("td")[i] ?? null;
  // Every gun table columns: gun, kills, shots, accuracy, first bullet, rounds used, proficiency, vs your other guns
  const KILLS = 1;
  const ROUNDS = 5;
  const EDGE = 7;
  /** your kills or rounds with one gun in the converted logs, summed one match at a time */
  const fromConverted = (gun: string, k: "kills" | "rounds") => converted.reduce((a, s) => a + (rollup([s.facts], { player: s.facts.match.pov! }).weapons[gun]?.[k] ?? 0), 0);

  it("marks a gun's kills and rounds when all of them come from converted logs, and gives the split when part do", () => {
    // fails if a count built only from converted logs (kills with no shots behind them) reads like a recorded one
    use(samples);
    render(<Weapons />);
    const total = summary(all).weapons;
    const seen = { all: 0, part: 0, none: 0 };
    for (const w of Object.keys(total).filter(isGun)) {
      for (const [k, i] of [["kills", KILLS], ["rounds", ROUNDS]] as const) {
        const n = total[w][k];
        const conv = fromConverted(w, k);
        const cell = col(rowOf(w), i);
        if (n > 0 && conv === n) {
          seen.all++;
          expect(text(cell?.querySelector(".convtag")), `${w} ${k}`).toBe("converted");
        } else if (conv > 0) {
          seen.part++;
          expect(cell?.querySelector(".convtag"), `${w} ${k}`).toBeNull();
          expect(cell?.querySelector(".convcell")?.getAttribute("data-tip"), `${w} ${k}`).toContain(`${conv} of ${n} ${k}`);
        } else {
          seen.none++;
          expect(cell?.querySelector(".convcell"), `${w} ${k}`).toBeNull();
        }
      }
    }
    // the samples reach every case
    expect(Math.min(seen.all, seen.part, seen.none)).toBeGreaterThan(0);
  });

  it("gives each gun one signal, its accuracy against your other guns pooled, only when both sides have enough shots", () => {
    // fails if the signal compares with the gun's class instead of every other gun, shows with too few
    // shots on either side, or falls back to advice sentences
    use(samples);
    render(<Weapons />);
    const total = summary(all).weapons;
    const guns = Object.keys(total).filter(isGun);
    const acc = (weapons: string[]) => rolled(summary({ ...all, filter: { ...all.filter, weapons } }));
    const judged = guns.filter((w) => total[w].shots >= 40);
    expect(judged.length).toBeGreaterThan(1);
    for (const w of judged) {
      const mine = acc([w]);
      const rest = acc(guns.filter((x) => x !== w));
      expect(rest.aim.shots, w).toBeGreaterThanOrEqual(40);
      expect(text(col(rowOf(w), EDGE)), w).toBe(`${signed(mine.v.accuracy! - rest.v.accuracy!, 1)} pts`);
      // the synthetic demo's shots all read 0% accuracy, so the population shows in the shot count it pools
      expect(col(rowOf(w), EDGE)?.querySelector("[data-tip]")?.getAttribute("data-tip"), w).toContain(`over ${rest.aim.shots} shots with your other guns`);
    }
    const few = guns.find((w) => total[w].shots > 0 && total[w].shots < 40)!;
    expect(text(col(rowOf(few), EDGE)), few).toBe("–");
  });
});
