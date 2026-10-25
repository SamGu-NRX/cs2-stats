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
import type { ClutchRow, Method, Query } from "../../worker/protocol";
import { addCareerMatch, botPopulation, rankingCalls, sideQuery } from "../../worker/ranking";
import { entryOf, matchBundle, metaOf, ratingsOf, rolled } from "../../worker/views";
import { careerEntries, fmtMetric, provisionalText, statLine } from "../data/engine";
import { matchModel, type MatchEntry, type MatchModel } from "../data/match";
import { metric, metrics, setMeta } from "../data/meta";
import type { Data } from "../data/provider";
import { sourceOf } from "../data/sources";
import { fmtSwing, signed } from "../lib/format";
import { matchHref } from "../router";
import { BarProvider } from "../shell/Bar";
import { HomeView } from "./Home";
import Playstyle from "./Playstyle";
import ProfileView from "./Profile";
import { HowGood } from "./profile/parts";
import { Provisional } from "./shared";
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

describe("Profile attributes", () => {
  const renderProfile = async () => {
    use(samples);
    const q = queryOf(samples);
    const block = await calls.attributeBlock(q, { side: "both", pool: "role" });
    const firepower = await calls.attributes(q, { side: "both" });
    answers.attributeBlock = block;
    answers.attributes = firepower;
    render(<ProfileView />);
    return { block, firepower };
  };
  const attr = (id: string) => host.querySelector(`.apa[data-attr="${id}"]`)!;

  it("puts Firepower in its own card and the six style attributes in pairs, in HLTV's order", async () => {
    // fails if Firepower moves back into the style block, the block drops or reorders an attribute, or
    // the block grows its own Side control (the title bar's is the page's one)
    await renderProfile();
    const block = host.querySelector(".apanel")!;
    const ids = Array.from(block.querySelectorAll(".apanel__grid > .apa")).map((el) => el.getAttribute("data-attr"));
    expect(ids).toEqual(["entrying", "trading", "opening", "closing", "sniping", "utility"]);
    expect(block.querySelector('[role="radiogroup"], .seg')).toBeNull();
    const fpCard = attr("firepower").closest(".card")!;
    expect(fpCard).not.toBe(block);
    expect(text(fpCard.querySelector(".card__title"))).toBe("Firepower");
  });

  it("names each attribute's population: Firepower the pros, Sniping every bot, the rest the chosen bot pool", async () => {
    // fails if Firepower's pro percentiles read as bot ranks (or the reverse), Sniping loses its own
    // population, or a rank shows where the engine gave a reason
    const { block, firepower } = await renderProfile();
    const phrases = (id: string) => Array.from(attr(id).querySelectorAll(".pctl")).map((el) => text(el.querySelector(".pctl__phrase")));
    expect(text(attr("sniping").querySelector(".apa__note"))).toBe("Compared to everyone");
    const own = block.style.role === "awper" ? "AWPer bots" : "rifler bots";
    const fp = firepower.scores.find((a) => a.id === "firepower")!;
    const checks: [string, RegExp, typeof fp][] = [
      ["firepower", / of pro (riflers|AWPers)$/, fp],
      ["sniping", / against all bots$/, block.style.scores.find((a) => a.id === "sniping")!],
      ["entrying", new RegExp(` against ${own}$`), block.style.scores.find((a) => a.id === "entrying")!],
    ];
    for (const [id, pop, score] of checks) {
      const rows = phrases(id);
      expect(rows.length, id).toBe(score.metrics.length);
      score.metrics.forEach((p, i) => {
        if (p.reason) expect(rows[i], `${id} ${p.id}`).toBe(p.reason);
        else if (p.pct !== null) expect(rows[i], `${id} ${p.id}`).toMatch(pop);
      });
    }
  });

  it("shows a provisional score by its hatched bar and tooltip, never by a chip or label", async () => {
    // fails if "Provisional" comes back as words on the page, or a provisional score loses its mark
    const { block } = await renderProfile();
    expect(block.style.careers.provisional).toBe(true);
    expect(host.textContent).not.toMatch(/provisional/i);
    const score = attr("entrying").querySelector(".apa__score")!;
    expect(attr("entrying").hasAttribute("data-prov")).toBe(true);
    expect(score.getAttribute("data-tip")).toBe("Few bot careers yet, so this may shift.");
    expect(score.getAttribute("tabindex")).toBe("0");
  });

  it("opens an attribute from its chevron, instantly from the keyboard", async () => {
    // fails if the chevron does not toggle its metrics, or a keyboard toggle animates
    await renderProfile();
    const chev = attr("trading").querySelector<HTMLButtonElement>(".apa__chev")!;
    expect(chev.getAttribute("aria-expanded")).toBe("false");
    act(() => chev.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    expect(chev.getAttribute("aria-expanded")).toBe("true");
    expect(attr("trading").querySelector(".collapse")!.classList.contains("is-instant")).toBe(true);
    expect(attr("trading").querySelector(".collapse")!.hasAttribute("inert")).toBe(false);
  });
});

describe("Profile clutches", () => {
  it("opens a clutch row into its rounds, each linking to the round drawer", async () => {
    // fails if a clutch row with clutches behind it is not a control, or its rounds do not open the round
    use(samples);
    const q = queryOf(samples);
    const m = rolled(summary(q)).m;
    const vs = ([1, 2, 3, 4, 5] as const).find((n) => m[`clutch${n}`] > 0)!;
    expect(vs).toBeDefined();
    const rows: ClutchRow[] = [
      { file: samples[0].file, round: 7, side: "T", opponents: vs, won: true },
      { file: samples[0].file, round: 12, side: "CT", opponents: vs, won: false },
      { file: samples[0].file, round: 3, side: "T", opponents: vs === 5 ? 4 : vs + 1, won: false },
    ];
    answers.clutches = rows;
    render(<ProfileView />);
    const btn = Array.from(host.querySelectorAll<HTMLButtonElement>("button.clist__row")).find((b) => b.getAttribute("aria-label")?.startsWith(`1v${vs}:`))!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    act(() => btn.click());
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const links = Array.from(document.getElementById(btn.getAttribute("aria-controls")!)!.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual([matchHref(samples[0].file, "rounds", { round: 7 }), matchHref(samples[0].file, "rounds", { round: 12 })]);
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

it("plots a rebuilt file's detonations as approximate landing points, and a logged file's landings as they are", () => {
  // fails if a file whose throws were rebuilt from detonations shows an empty landing map or presents its
  // points as exact, or a file with a throw log is labelled approximate
  const s = converted[1];
  expect(s.facts.match.inputs.throws).toBe("rebuilt");
  const v = modelOf(s);
  render(<Utility v={v} file={v.file} round={null} />);
  expect(text(host.querySelector(".chip--approx"))).toBe("Approximate");
  expect(text(host.querySelector(".landing__side"))).toContain("this file logs detonations, not throws");
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
