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
import { botPopulation as botPopulationText, careerEntries, listedEntries, provisionalText, recordEntries, statLine } from "../data/engine";
import { tipOf } from "../data/tips";
import { sentence } from "../components/Percentile";
import { matchModel, type MatchEntry, type MatchModel } from "../data/match";
import { metric, metrics, setMeta } from "../data/meta";
import type { Data } from "../data/provider";
import { sourceOf } from "../data/sources";
import { fmtPct, fmtSwing, signed } from "../lib/format";
import { go, matchHref, navWasInstant, parseHash, profileHref, PROFILE_TABS } from "../router";
import { MatchesView } from "./Matches";
import CareerAim from "./CareerAim";
import { RoleCard } from "./profile/parts";
import { WhereYouPlay } from "./Playstyle";
import { fmtRating } from "../lib/format";
import { BarProvider } from "../shell/Bar";
import { HomeView, workOnHref } from "./Home";
import ProfileView from "./Profile";
import { StatCard, useRanks } from "./profile/tabs";
import { Provisional } from "./shared";
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
/** the arguments of each worker call the views made last, by method */
const asked: Partial<Record<Method, unknown[]>> = {};
const done = <T,>(x: T | null) => ({ data: x, error: null, loading: false });

vi.mock("../data/provider", () => ({
  useData: () => ({ ...data, status: "ready", host: null, client: null, baselines, baselinesError: null }),
}));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useRollups: (qs: Query[] | null) => done(qs?.length ? qs.map((q) => rolled(summary(q))) : null),
  // the real useScoped calls the module's own useRollups, which this mock cannot reach
  useScoped: (q: Query, extra: object[]) => extra.map((e) => rolled(summary({ files: q.files, filter: { ...q.filter, ...e } }))),
  useRatings: (qs: Query[] | null) => done(qs?.length ? qs.map((q) => ratingsOf({ both: summary(sideQuery(q, "both")), T: summary(sideQuery(q, "T")), CT: summary(sideQuery(q, "CT")) })) : null),
  useCall: (method: Method, args: unknown[] | null) => { if (args) asked[method] = args; return done(args ? answers[method] ?? null : null); },
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
/** The metric rows a Profile tab draws for these ids (profile/tabs.tsx StatCard), ranked as the tab ranks them. */
function Rows({ q, side, ids }: { q: Query; side: "both" | "T" | "CT"; ids: string[] }) {
  return <StatCard title="Rows" tip="Rows." ids={ids} r={useRanks(q, side)} />;
}
/** How good's metrics, now rows on the Duels and Utility tabs. */
const HOW_GOOD = ["tradeKillSuccess", "tradedDeathSuccess", "openingSwing", "clutchSwing", "oneVsOne", "awpSwing", "awpDuelWin", "flashSwing", "assistsPerFlash", "dmgPerHe", "grenadeDmgTaken"];
const rowOfId = (id: string) => Array.from(host.querySelectorAll<HTMLElement>(".mrow")).find((el) => el.querySelector(".mrow__lab")?.firstChild?.textContent === metric(id).label);
const byLabel = (sel: string, label: string, name: string) => Array.from(host.querySelectorAll(sel)).find((el) => text(el.querySelector(label)) === name) ?? null;

describe("comparison reasons", () => {
  it("shows a row's rank as text, keeps the reason there is none in its tooltip, and draws no track without a dot", async () => {
    // fails if a metric the engine could not compare (Percentile.reason) shows a rank, an empty track or
    // loses its reason, or a ranked row loses its visible "Top x%" or its tooltip's definition
    const q = queryOf(samples);
    const r = await calls.compare(q, { side: "both" });
    answers.compare = r;
    answers.style = await calls.style(q, { side: "both" });
    render(<Rows q={q} side="both" ids={HOW_GOOD} />);
    const reasoned = Object.values(r.p).filter((x) => x.reason && rowOfId(x.id));
    expect(reasoned.length).toBeGreaterThan(0);
    for (const x of reasoned) {
      const el = rowOfId(x.id)!;
      expect(el.getAttribute("data-tip"), x.id).toContain(x.reason!);
      expect(el.querySelector(".trk"), x.id).toBeNull();
      expect(text(el.querySelector(".mrow__rank")), x.id).toBe("");
    }
    const ranked = Object.values(r.p).find((x) => !x.reason && x.pct !== null && rowOfId(x.id))!;
    const el = rowOfId(ranked.id)!;
    expect(text(el.querySelector(".mrow__rank"))).toMatch(/^(Top|Bottom) \d+%$/);
    expect(el.getAttribute("data-tip")!.split("\n")[0]).toBe(tipOf(ranked.id));
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.querySelector(".trk__dot")).not.toBeNull();
  });

  it("marks approx metrics, and only those, explaining the mark once in the card's legend", async () => {
    // fails if a row drops the ≈ marker from a metric whose status is "approx", or puts it on an exact one
    const q = queryOf(samples);
    answers.compare = await calls.compare(q, { side: "both" });
    answers.style = await calls.style(q, { side: "both" });
    render(<Rows q={q} side="both" ids={HOW_GOOD} />);
    const rows = Array.from(host.querySelectorAll(".mrow"));
    expect(rows.length).toBeGreaterThan(0);
    expect(host.querySelectorAll(".approx-legend[data-tip]")).toHaveLength(1);
    const statuses = new Set<string>();
    for (const el of rows) {
      const m = metrics().find((x) => x.label === el.querySelector(".mrow__lab")?.firstChild?.textContent)!;
      statuses.add(m.status);
      expect(!!el.querySelector(".approx"), m.id).toBe(m.status === "approx");
    }
    expect(statuses).toContain("approx");
    expect(statuses).toContain("exact");
  });

  it("shows Ranks by topic's uncompared values with their reason", async () => {
    // fails if a Playstyle rank row shows a rank, or loses the reason, for a value the engine could not compare
    use(samples);
    const q = queryOf(samples);
    answers.compare = await calls.compare(q, { pool: "all" });
    answers.style = await calls.style(q, { pool: "all" });
    render(<ProfileView tab="playstyle" />);
    const p = { ...(answers.compare as { p: object }).p, ...(answers.style as { p: object }).p } as Record<string, { reason: string | null }>;
    const rows = Array.from(host.querySelectorAll(".ranks__group .mrow"));
    const idOf = (li: Element) => metrics().find((x) => li.querySelector(".mrow__lab")?.firstChild?.textContent === x.label)!.id;
    const reasoned = rows.filter((li) => p[idOf(li)].reason);
    expect(reasoned.length).toBeGreaterThan(0);
    for (const li of reasoned) {
      // the reason stands in the row's tooltip, and no track draws without a dot
      expect(li.getAttribute("data-tip"), idOf(li)).toContain(p[idOf(li)].reason!);
      expect(li.querySelector(".trk"), idOf(li)).toBeNull();
    }
  });
});

describe("Profile attributes", () => {
  /** HLTV's attribute block is on Overview, under the player card: Firepower wide, the six style attributes in pairs. */
  const renderProfile = async (tab: "overview" | "playstyle" = "overview") => {
    use(samples);
    const q = queryOf(samples);
    const block = await calls.attributeBlock(q, { side: "both", pool: "role" });
    const firepower = await calls.attributes(q, { side: "both" });
    answers.attributeBlock = block;
    answers.attributes = firepower;
    render(<ProfileView tab={tab} />);
    return { block, firepower };
  };
  const attr = (id: string) => host.querySelector(`.hatt[data-attr="${id}"]`)!;

  it("draws HLTV's block on Overview: Firepower wide on top, then the six style attributes in pairs, in HLTV's order", async () => {
    // fails if Firepower leaves the block or stops leading it, the block drops or reorders an attribute,
    // or the block moves off Overview (Playstyle only links to it)
    await renderProfile();
    const block = host.querySelector(".hblock")!;
    expect(block).not.toBeNull();
    const kids = Array.from(block.children).filter((el) => el.classList.contains("hatt"));
    expect(kids.map((el) => el.getAttribute("data-attr"))).toEqual(["firepower"]);
    expect(kids[0].classList.contains("hatt--wide")).toBe(true);
    const ids = Array.from(block.querySelectorAll(".hblock__grid > .hatt")).map((el) => el.getAttribute("data-attr"));
    expect(ids).toEqual(["entrying", "trading", "opening", "closing", "sniping", "utility"]);
    // the block sits right under the player card, before Form
    const order = Array.from(host.querySelectorAll(".profile__top, .hblock, .form-rail")).map((el) => el.className.split(" ").find((c) => ["profile__top", "hblock", "form-rail"].includes(c)));
    expect(order.slice(0, 3)).toEqual(["profile__top", "hblock", "form-rail"]);
    await renderProfile("playstyle");
    expect(host.querySelector(".hblock")).toBeNull();
    expect(host.querySelector<HTMLAnchorElement>(".ptab__xref")!.getAttribute("href")).toBe("#/profile/overview?sec=style");
  });

  it("names each attribute's population: Firepower the pros, Sniping every bot, the rest the chosen bot pool", async () => {
    // fails if Firepower's pro percentiles read as bot ranks (or the reverse), Sniping loses its own
    // population, or a rank shows where the engine gave a reason
    // each scored row's rank, or the reason it has none, is the line of its tooltip after the definition
    const rankLine = (el: Element) => el.getAttribute("data-tip")!.split("\n").filter((l) => !/^Only \d+, so this may shift\.$/.test(l)).pop()!;
    const rowsIn = (el: Element) => Array.from(el.querySelectorAll(".mrow:not([data-extra])")).map(rankLine);
    const { block, firepower } = await renderProfile();
    const phrases = (id: string) => rowsIn(attr(id).querySelector(".collapse")!);
    expect(text(attr("sniping").querySelector(".hatt__note"))).toBe("Compared to everyone");
    const own = block.style.role === "awper" ? "AWPer bots" : "rifler bots";
    const fp = firepower.scores.find((a) => a.id === "firepower")!;
    const checks: [string, RegExp, typeof fp][] = [
      ["firepower", / of pro (riflers|AWPers)\.$/, fp],
      ["sniping", / against all bots\.$/, block.style.scores.find((a) => a.id === "sniping")!],
      ["entrying", new RegExp(` against ${own}\\.$`), block.style.scores.find((a) => a.id === "entrying")!],
    ];
    for (const [id, pop, score] of checks) {
      const rows = phrases(id);
      expect(rows.length, id).toBe(score.metrics.length);
      score.metrics.forEach((p, i) => {
        if (p.reason) expect(rows[i], `${id} ${p.id}`).toBe(sentence(p.reason));
        else if (p.pct !== null) expect(rows[i], `${id} ${p.id}`).toMatch(pop);
      });
    }
  });

  it("names a provisional pool once, in the header pill, and on each score's tooltip", async () => {
    // fails if the pill is missing, repeats per attribute, or a provisional score loses its tooltip
    const { block } = await renderProfile();
    expect(block.style.careers.provisional).toBe(true);
    const pills = Array.from(host.querySelectorAll(".hblock .vpill"));
    expect(pills.map(text)).toEqual(["Provisional"]);
    expect(pills[0].getAttribute("data-tip")).toBe("Few bot careers yet, so this may shift.");
    expect(text(host.querySelector(".hblock__note"))).toMatch(/^Style vs \d+ /);
    expect(host.querySelectorAll(".hblock [data-attr] .vpill")).toHaveLength(0);
    const score = attr("entrying").querySelector(".hatt__score")!;
    expect(attr("entrying").hasAttribute("data-prov")).toBe(true);
    expect(score.getAttribute("data-tip")).toBe("Few bot careers yet, so this may shift.");
    expect(score.getAttribute("tabindex")).toBe("0");
  });

  it("opens an attribute from its chevron, instantly from the keyboard", async () => {
    // fails if the chevron does not toggle its metrics, or a keyboard toggle animates
    await renderProfile();
    const chev = attr("trading").querySelector<HTMLButtonElement>(".hatt__chev")!;
    expect(chev.getAttribute("aria-expanded")).toBe("false");
    act(() => chev.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    expect(chev.getAttribute("aria-expanded")).toBe("true");
    expect(attr("trading").querySelector(".collapse")!.classList.contains("is-instant")).toBe(true);
    expect(attr("trading").querySelector(".collapse")!.hasAttribute("inert")).toBe(false);
  });
});

describe("Weapons and Overview tabs", () => {
  it("lists every gun on the Weapons tab, grouped by class, most kills first, and each multi-kill on Overview as a share of rounds", () => {
    // fails if the table drops a gun, misorders a class, or the multi-kill shares stop adding up to the counts
    use(samples);
    // the page reads the career matches (careerEntries), not every sample
    const career = new Set(careerEntries(data.matches, null).map((e) => e.file));
    const s = rolled(summary(queryOf(samples.filter((x) => career.has(x.file)))));
    render(<ProfileView tab="weapons" />);
    const kills = Array.from(host.querySelectorAll(".guntbl thead th")).findIndex((th) => text(th).startsWith("Kills"));
    const rows = Array.from(host.querySelectorAll(".guntbl tbody tr"));
    const guns = Object.entries(s.weapons).filter(([w]) => isGun(w));
    const gunRows = rows.filter((tr) => !tr.classList.contains("is-group"));
    expect(gunRows).toHaveLength(guns.length);
    // within each class block, kills never rise
    let cls = "";
    let last = Infinity;
    for (const tr of rows) {
      if (tr.classList.contains("is-group")) { cls = text(tr); last = Infinity; continue; }
      const k = Number(text(tr.querySelectorAll("td")[kills]).replace(/\D.*$/, ""));
      expect(k, cls).toBeLessThanOrEqual(last);
      last = k;
    }
    render(<ProfileView tab="overview" />);
    const multis = Array.from(host.querySelectorAll(".mlist > li"));
    expect(multis).toHaveLength(4);
    const two = s.m.multiKillRounds - s.m.k3Rounds;
    expect(text(multis[0].querySelector(".mlist__pct"))).toBe(fmtPct((100 * two) / s.m.rounds, 1));
  });
});

describe("Profile tab bar", () => {
  it("is one tab stop, and the arrow keys, Home and End open the next tab instantly with focus on it", () => {
    // fails if every tab is a tab stop, an arrow key does nothing, the move animates (not instant), or
    // focus stays on the old tab
    use(samples);
    const at = () => parseHash(location.hash).ptab!;
    const tabEl = (t: string) => host.querySelector<HTMLElement>(`[role="tab"][data-tab="${t}"]`)!;
    const press = (key: string) => {
      act(() => { tabEl(at()).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
      render(<ProfileView tab={at()} />);
    };
    try {
      act(() => go(profileHref("overview")));
      render(<ProfileView tab="overview" />);
      expect(Array.from(host.querySelectorAll('[role="tab"]')).map((el) => el.getAttribute("tabindex"))).toEqual(PROFILE_TABS.map((t) => (t === "overview" ? "0" : "-1")));
      press("ArrowRight");
      expect(at()).toBe("duels");
      expect(navWasInstant()).toBe(true);
      expect(document.activeElement).toBe(tabEl("duels"));
      expect(tabEl("duels").getAttribute("tabindex")).toBe("0");
      press("End");
      expect(at()).toBe(PROFILE_TABS[PROFILE_TABS.length - 1]);
      press("ArrowRight");
      expect(at()).toBe("overview");
      press("ArrowLeft");
      expect(at()).toBe(PROFILE_TABS[PROFILE_TABS.length - 1]);
      press("Home");
      expect(at()).toBe("overview");
      expect(document.activeElement).toBe(tabEl("overview"));
      // Up and Down are the page's to scroll, not the tab bar's
      press("ArrowDown");
      expect(at()).toBe("overview");
    } finally {
      act(() => go("#/"));
    }
  });
});

describe("tooltips", () => {
  it("puts every Profile tooltip on an element that takes keyboard focus, on every tab", async () => {
    // fails if a data-tip sits on a plain span or b, which a keyboard user can never open
    use(samples);
    const q = queryOf(samples);
    answers.compare = await calls.compare(q, { side: "both" });
    answers.style = await calls.style(q, { side: "both" });
    for (const tab of PROFILE_TABS) {
      render(<ProfileView tab={tab} />);
      const stuck = Array.from(host.querySelectorAll(".profile [data-tip]")).filter((el) => !el.matches("a[href], button, input, select, [tabindex]"));
      expect(stuck.map((el) => `${el.tagName}.${el.getAttribute("class")}`), tab).toEqual([]);
    }
  });
});

describe("section links", () => {
  it("scrolls a ?sec= link to its section on its Profile tab once it renders", () => {
    // fails if useSection is not wired to the section the link names (the user would stay at the top)
    use(samples);
    const scrolled: Element[] = [];
    const raf = globalThis.requestAnimationFrame;
    const into = Element.prototype.scrollIntoView;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      act(() => go("#/profile/duels?sec=openings"));
      render(<ProfileView tab="duels" />);
      expect(scrolled.map((el) => el.id)).toEqual(["openings"]);
    } finally {
      globalThis.requestAnimationFrame = raf;
      Element.prototype.scrollIntoView = into;
      act(() => go("#/"));
    }
  });
});

describe("Matches", () => {
  it("leaves out a recording with no round won and no kill, and keeps a winnerless match with kills", () => {
    // fails if a 0:0 recording with nothing in it is listed, or a 0:0 with logged rounds and kills disappears
    use(samples);
    const base = samples[0].entry;
    const empty = { ...base, file: "samples/empty.json.gz", score: { us: 0, them: 0 }, kills: 0, activity: false, match: { ...base.match, complete: false } };
    const winnerless = { ...base, file: "samples/winnerless.json.gz", score: { us: 0, them: 0 }, kills: 30, activity: true, match: { ...base.match, complete: true } };
    const damageOnly = { ...base, file: "samples/damage-only.json.gz", score: { us: 0, them: 0 }, kills: 0, activity: true, match: { ...base.match, complete: false } };
    data = { ...data, matches: [...data.matches, empty, winnerless, damageOnly] };
    render(<MatchesView />);
    expect(host.querySelectorAll("tbody tr").length).toBe(data.matches.length - 1);
    const unfinished = data.matches.filter((e) => !e.match.complete && e.score.us + e.score.them > 0);
    const listed = text(host.querySelector("tbody"));
    for (const e of unfinished) expect(listed).toContain(`${e.score.us}:${e.score.them}`);
  });
});

describe("Style compass", () => {
  it("places you and every bot career with 20 or more rounds", () => {
    // fails if the compass drops you, places a thin career, or loses a qualifying one
    use(samples);
    render(<ProfileView tab="playstyle" />);
    const card = Array.from(host.querySelectorAll(".card")).find((c) => text(c.querySelector(".card__title")) === "Style compass")!;
    expect(card).toBeTruthy();
    const career = new Set(careerEntries(data.matches, null).map((e) => e.file));
    const files = samples.filter((x) => career.has(x.file));
    const bots = [...new Set(files.flatMap((x) => x.entry.players.filter((p) => p.bot).map((p) => p.id)))];
    const placed = bots.filter((id) => {
      const m = summary({ files: files.map((x) => x.file), filter: { player: [id] } }).m;
      return m.rounds >= 20 && m.kills + m.assists > 0;
    });
    expect(card.querySelectorAll("svg circle[r='4.5']")).toHaveLength(placed.length);
    expect(text(card.querySelector(".compass__you"))).toMatch(/^You, (Support|Entry and support|Entry|Rifler)$/);
  });
});

describe("review round 1 (PR #28)", () => {
  it("reads Where you play from the page's matches and side, on the scoped map", () => {
    // fails if the card reads every match in the folder, ignores the side, or keeps its own stale map
    use(samples);
    const career = careerEntries(data.matches, null);
    const two = career.slice(0, 2);
    render(<WhereYouPlay list={two} side="t" />);
    const [q] = asked.positions as [Query];
    const map = two[0].match.map;
    expect(q.files).toEqual(two.filter((e) => e.match.map === map).map((e) => e.file));
    expect(q.filter.sides).toEqual(["T"]);
    expect(q.filter.maps).toEqual([map]);
  });

  it("charts each match on the page's side: Form shows the T rating when Side is T", () => {
    // fails if Form, Rating by match or the swing bars keep the both-sides value under a side filter
    use(samples);
    try {
      act(() => go("#/profile?side=t"));
      render(<ProfileView />);
      const career = careerEntries(data.matches, null);
      const ids = data.you;
      const first = career[0];
      const q = { files: [first.file], filter: { player: ids } };
      const t = ratingsOf({ both: summary(sideQuery(q, "both")), T: summary(sideQuery(q, "T")), CT: summary(sideQuery(q, "CT")) }).T.value;
      const cell = host.querySelector(".form-rail .fig--last .fig__v");
      expect(text(cell)).toBe(t === null ? "–" : fmtRating(t));
    } finally {
      act(() => go("#/"));
    }
  });

  it("divides the AWP share by rounds with a recorded loadout, and shows none without one", () => {
    // fails if the tile divides by every round (0% for files that record no loadout)
    use(samples);
    const q = queryOf(samples);
    answers.roles = { T: { side: "T", blend: null, evidence: [], rounds: 1 }, CT: { side: "CT", blend: null, evidence: [], rounds: 1 }, all: { blend: null, rounds: { T: 1, CT: 1 } } };
    render(<RoleCard q={q} />);
    const m = rolled(summary(q)).m;
    const tile = host.querySelector(".rtiles li")!;
    if (m.loadoutRounds) expect(text(tile.querySelector("b"))).toBe(fmtPct((100 * m.roundsWithAwp) / m.loadoutRounds, 0));
    else {
      expect(text(tile.querySelector("b"))).toBe("–");
      expect(tile.getAttribute("data-tip")).toBe("No loadout recorded, so the AWP share is unknown.");
    }
  });

  it("names each row's population from the pool it was ranked in", async () => {
    // fails if an AWP row ranked against every pro reads "of pro riflers"
    const q = queryOf(samples);
    const r = await calls.compare(q, { side: "both" });
    answers.compare = { ...r, p: { ...r.p, awpDuelWin: { ...r.p.awpDuelWin, value: 0.5, pct: 80, reason: null, pool: "all" } } };
    answers.style = await calls.style(q, { side: "both" });
    render(<Rows q={q} side="both" ids={HOW_GOOD} />);
    expect(rowOfId("awpDuelWin")!.getAttribute("data-tip")).toMatch(/\nTop 20% of pros\.$/);
  });

  it("shows a thin log's recorded kills and deaths, marked partial, and sorts by them", () => {
    // fails if a converted log with few logged rounds hides its K–D behind a dash
    use(samples);
    const base = samples[0].entry;
    const thin = { ...base, file: "samples/thin.json.gz", match: { ...base.match, nRounds: 1, roundsPlayed: 16 } };
    data = { ...data, matches: [...data.matches, thin] };
    render(<MatchesView />);
    const row = Array.from(host.querySelectorAll("tbody tr")).find((tr) => tr.querySelector("[data-file='samples/thin.json.gz']") || text(tr).includes("1 of 16"))!;
    expect(row).toBeTruthy();
    const kd = Array.from(row.querySelectorAll("[data-tip^='Partial']"));
    expect(kd.length).toBeGreaterThan(0);
    expect(text(kd[0])).toBe(`${thin.line.m.kills}–${thin.line.m.deaths}`);
  });

  it("brings back main's Weapons columns and advice, and Career aim's head accuracy trend", () => {
    // fails if HS kills, head share or each gun's advice, or the head accuracy card, goes missing again
    use(samples);
    render(<Weapons />);
    const heads = Array.from(host.querySelectorAll("thead th")).map(text);
    for (const h of ["HS kills", "Head share"]) expect(heads.some((x) => x.startsWith(h)), h).toBe(true);
    const rows = Array.from(host.querySelectorAll("tbody tr:not(.is-group)"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((tr) => text(tr.querySelector(".guncell__advice")) !== "" && !!tr.querySelector(".guncell__advice .help[data-tip]")), "Advice").toBe(true);
    render(<CareerAim />);
    expect(Array.from(host.querySelectorAll(".card__title")).map(text)).toContain("Head accuracy");
  });
});

describe("review round 2 (PR #28)", () => {
  it("opens every recommendable Work on metric where it is actually shown, and recommends none without a place", async () => {
    // fails if a recommendation opens a page or section that does not render its metric: the old
    // ?sec=performance fallback, or Career aim for aim metrics it never draws (time to kill, pre-aim)
    use(samples);
    const career = careerEntries(data.matches, null);
    const q = queryOf(samples.filter((x) => career.some((e) => e.file === x.file)));
    const perf = metrics().filter((m) => m.kind === "performance" && m.status !== "unavailable");
    const dest = new Map(perf.map((m) => [m.id, workOnHref(m)]));
    for (const id of ["tradeAttemptPct", "timeToKill", "crosshairMoved", "preAim"]) expect(dest.get(id), id).toBeNull();
    // a metric is shown where its label is drawn, or where an element's tooltip is its own
    const shows = (root: Element | null, id: string) => !!root && (text(root).includes(metric(id).label)
      || Array.from(root.querySelectorAll("[data-tip]")).some((el) => { const t = el.getAttribute("data-tip") ?? ""; return (!!tipOf(id) && t.includes(tipOf(id)!)) || t.includes(metric(id).def); }));
    const byPage = new Map<string, string[]>();
    for (const [id, href] of dest) if (href) byPage.set(href, [...(byPage.get(href) ?? []), id]);
    answers.compare = await calls.compare(q, { side: "both" });
    answers.attributes = await calls.attributes(q, { side: "both" });
    answers.style = await calls.style(q, { side: "both" });
    answers.attributeBlock = await calls.attributeBlock(q, { side: "both", pool: "role" });
    for (const [href, ids] of byPage) {
      const r = parseHash(href);
      const sec = r.query.get("sec");
      if (r.page !== "profile") throw new Error(`no view for ${href}`);
      if (r.ptab === "aim") {
        // the sighting timings draw once the files carry visibility; without it they are not ranked, so never recommended
        const saved = data;
        data = { ...data, matches: data.matches.map((e) => ({ ...e, match: { ...e.match, visibility: "ok" } })) };
        render(<CareerAim />);
        data = saved;
      }
      else render(<ProfileView tab={r.ptab} />);
      const root = sec ? host.querySelector(`#${sec}`) : host;
      for (const id of ids) expect(shows(root, id), `${id} on ${href}`).toBe(true);
    }
  });

  it("names a Work on item's population from the pool it was ranked in", async () => {
    // fails if an AWP row ranked against every pro reads "pro riflers" on Home
    use(samples);
    const q = queryOf(samples.filter((x) => new Set(careerEntries(data.matches, null).map((e) => e.file)).has(x.file)));
    const r = await calls.compare(q, {});
    // every other metric ranks high, so the AWP row is the weakest
    const high = Object.fromEntries(Object.entries(r.p).map(([id, x]) => [id, { ...x, pct: x.pct === null ? null : 99 }]));
    answers.compare = { ...r, p: { ...high, awpDuelWin: { ...r.p.awpDuelWin, value: 0.1, pct: 1, reason: null, pool: "all" } } };
    render(<HomeView />);
    const item = Array.from(host.querySelectorAll(".workon__item")).find((a) => text(a.querySelector(".workon__top b")) === metric("awpDuelWin").label)!;
    expect(item).toBeTruthy();
    expect(text(item.querySelector(".meta"))).toMatch(/of pros$/);
  });

  it("names Ranks by topic's bot population as the engine counts it", async () => {
    // fails if bot-match samples are called bot careers
    use(samples);
    const q = queryOf(samples);
    answers.compare = await calls.compare(q, { pool: "all" });
    const style = await calls.style(q, { pool: "all" });
    answers.style = style;
    render(<ProfileView tab="playstyle" />);
    const card = Array.from(host.querySelectorAll(".card")).find((c) => text(c.querySelector(".card__title")) === "Ranks by topic")!;
    expect(text(card.querySelector(".card__aside"))).toContain(`style against ${botPopulationText(style.careers, { n: style.n, role: "all" }).text}`);
  });

  it("counts a winnerless match with logged rounds and kills, and keeps it out of W–L", () => {
    // Sol's case: 24 logged rounds, 30 kills, round winners unknown (0:0). It is a real match: listed and
    // in the career, but its result is unknown, so it is no draw in the record. An empty 0:0 is in neither.
    const base = samples.find((x) => careerEntries([x.entry], null).length === 1)!.entry;
    const winnerless = { ...base, file: "samples/winnerless.json.gz", score: { us: 0, them: 0 }, kills: 30, activity: true, match: { ...base.match, complete: true, nRounds: 24, roundsPlayed: 24 } };
    const empty = { ...winnerless, file: "samples/empty.json.gz", kills: 0, activity: false };
    expect(listedEntries([winnerless, empty], null).map((e) => e.file)).toEqual([winnerless.file]);
    expect(careerEntries([winnerless, empty], null).map((e) => e.file)).toEqual([winnerless.file]);
    expect(recordEntries([winnerless, empty])).toHaveLength(0);
  });

  it("marks a match active on a completed round, a kill or a damage event, and nothing else", () => {
    // fails if entryOf misses damage-only recordings or calls an empty one active
    const s = samples[0];
    const f = s.facts;
    const stripped = { ...f, rounds: f.rounds.map((r) => ({ ...r, winner: null })), kills: [], pr: f.pr.map((r) => ({ ...r, m: {} })) };
    expect(entryOf(s.file, s.entry.origin, f).activity).toBe(true);
    expect(entryOf(s.file, s.entry.origin, stripped).activity).toBe(false);
    const damaged = { ...stripped, pr: stripped.pr.map((r, i) => (i === 0 ? { ...r, m: { dmg: 12 } } : r)) };
    expect(entryOf(s.file, s.entry.origin, damaged).activity).toBe(true);
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
    render(<ProfileView tab="overview" />);
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
  it("labels the hero's deltas with your average", () => {
    // fails if the hero's delta does not name the average it is measured from
    use(converted);
    render(<HomeView />);
    const adr = byLabel(".hero-stat", ".stat__l", "ADR");
    const tile = byLabel(".tile", ".stat__l", "ADR");
    expect(text(adr?.querySelector(".hero-stat__vs"))).toBe(`vs your ${text(tile?.querySelector(".tile__v"))}`);
    expect(adr?.querySelector(".delta")).not.toBeNull();
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
  const rowOf = (gun: string) => Array.from(host.querySelectorAll("tbody tr")).find((tr) => tr.querySelector(".guncell__txt > span")?.firstChild?.textContent === weaponLabel(gun)) ?? null;
  const col = (tr: Element | null, label: string) => tr?.querySelectorAll("td")[at(label)] ?? null;
  // Every gun's columns, found by their header so a new column does not shift what a test reads
  const at = (label: string) => Array.from(host.querySelectorAll("thead th")).findIndex((th) => text(th).startsWith(label));
  const KILLS = "Kills";
  const ROUNDS = "Rounds used";
  const EDGE = "Vs other guns";
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
    // fails if the signal compares with the gun's class instead of every other gun, or shows with too few
    // shots on either side
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
