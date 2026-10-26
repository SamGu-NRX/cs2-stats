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
import { signed } from "../lib/format";
import type { Data } from "../data/provider";
import { KillFlags } from "../icons/game";
import { go, matchHref, useRoute } from "../router";
import { RoundRail } from "./match/RoundRail";
import Rounds from "./match/Rounds";
import MatchView from "./match/MatchView";
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
/** the icon pack's answer for a radar: an image URL, or null when the pack has none */
let radarArt: string | null = null;
vi.mock("../data/icons", async (orig) => {
  const real = await orig<typeof import("../data/icons")>();
  return { ...real, useGameIcon: (id: string | null) => (id?.startsWith("radar_") ? radarArt : real.useGameIcon(id)) };
});
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useRollups: (qs: Query[] | null) => done(qs?.length ? qs.map((q) => (rollupOf ? rollupOf(q) : rolled(summary(q)))) : null),
  useCall: (_method: Method, _args: unknown[] | null) => done(null),
  useMatch: () => done(null),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof IntersectionObserver;
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

describe("totals-only rounds in the match views", () => {
  // round 5 of this converted log is held only as totals
  const s = byName("8ecfd307");
  const key = (k: string) => act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  // as MatchView does: the URL's round number to a round row, null for a totals-only number
  function Tab({ v }: { v: MatchModel }) {
    const q = useRoute().query.get("round");
    const n = q ? Number(q) : null;
    const ri = v.rounds.findIndex((r) => r.number === n);
    return <><RoundRail v={v} selected={n} onPick={(x) => go(matchHref(v.file, "rounds", { round: x }))} /><Rounds v={v} file={v.file} round={ri >= 0 ? ri : null} /></>;
  }

  it("puts the round in the rail and the grid in number order, with the game's totals in each cell", () => {
    // fails if the rail or grid iterates only the rounds with facts, so round 5 disappears, or a
    // totals-only cell drops the recorded kills and death
    const v = modelOf(s);
    use([s]);
    act(() => go(matchHref(v.file, "rounds")));
    render(<Tab v={v} />);
    const nums = (sel: string) => Array.from(host.querySelectorAll(sel)).map(text);
    expect(nums(".rail__n")).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
    expect(nums(".ig__headbtn .num")).toEqual(nums(".rail__n"));
    expect(text(host.querySelector(".rail__col.is-lite .rail__n"))).toBe("5");
    const totals = s.facts.totalsRounds.find((t) => t.number === 5)!;
    const rows = Array.from(host.querySelectorAll(".ig__row:not(.ig__row--head):not(.ig__row--team)"));
    for (const t of totals.players) {
      const name = v.players[t.pi].name;
      const cell = rows.find((r) => r.querySelector(".ig__name")?.textContent?.startsWith(name))!.querySelector(".ig__cell.is-lite")!;
      expect([text(cell.querySelector(".ig__k")) || "0", !!cell.querySelector(".ig__death")], name).toEqual([String(t.kills), t.deaths > 0]);
      expect(cell.getAttribute("aria-label"), name).toContain("Round 5, totals only");
    }
  });

  it("selects round 5 from the URL, opens its totals in the drawer, and steps to its neighbours", () => {
    // fails if round=5 cannot select the totals-only round, its drawer shows no totals, or stepping skips it
    const v = modelOf(s);
    use([s]);
    act(() => go(matchHref(v.file, "rounds", { round: 5 })));
    render(<Tab v={v} />);
    const drawer = () => host.querySelector(".drawer");
    expect(text(drawer()?.querySelector(".drawer__title b"))).toBe("Round 5");
    expect(host.querySelector(".rail__col.is-lite")?.classList.contains("is-on")).toBe(true);
    expect(host.querySelector('.ig__headbtn[aria-label^="Round 5,"]')?.closest(".ig__head")?.classList.contains("is-on")).toBe(true);
    const top = [...s.facts.totalsRounds.find((t) => t.number === 5)!.players].sort((a, b) => b.dmg - a.dmg)[0];
    const first = drawer()?.querySelector(".dtotals li");
    expect([text(first?.querySelector(".kf__p")), text(first?.querySelector("b"))]).toEqual([v.players[top.pi].name, String(top.dmg)]);
    key("ArrowRight");
    expect(text(drawer()?.querySelector(".drawer__title b"))).toBe("Round 6");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(text(drawer()?.querySelector(".drawer__title b"))).toBe("Round 4");
  });

  it("shows a dash where the file holds no totals for a player", () => {
    // fails if a missing totals row reads as zero kills, or a value is guessed
    const base = modelOf(s);
    const v: MatchModel = { ...base, facts: { ...base.facts, totalsRounds: base.facts.totalsRounds.map((t) => ({ ...t, players: t.players.filter((x) => x.pi !== base.human) })) } };
    use([s]);
    act(() => go(matchHref(v.file, "rounds", { round: 5 })));
    render(<Tab v={v} />);
    const you = Array.from(host.querySelectorAll(".ig__row.is-you"))[0];
    expect(text(you.querySelector(".ig__cell.is-lite"))).toBe("–");
    const mine = host.querySelector(".dtotals li.is-you");
    expect(Array.from(mine?.querySelectorAll(".num") ?? []).map(text)).toEqual(["–", "–", "–"]);
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
    const row = (w: string) => Array.from(host.querySelectorAll("tbody tr")).find((tr) => tr.querySelector(".guncell__txt > span")?.firstChild?.textContent === weaponLabel(w));
    // under the gun's name: the advice's line of numbers, and its one sentence in the "?" beside it
    const line = (tr: Element | undefined) => tr?.querySelector(".guncell__advice")?.firstChild?.textContent ?? "";
    const tip = (el: Element | null | undefined) => el?.querySelector(".help[data-tip]")?.getAttribute("data-tip") ?? "";
    // the ak47 has a slow first bullet and a low head share: the first bullet is the one the tip names
    expect([line(row("ak47")), tip(row("ak47"))]).toEqual([`First bullet ${signed(-20, 0)} pts`, "First bullets land 20 points less often, so stop before firing."]);
    expect([line(row("glock")), tip(row("glock"))]).toEqual([`${signed(-5, 1)} pts vs other guns`, "You hit 5.0 points less often than with other guns."]);
    expect([line(row("deagle")), tip(row("deagle"))]).toEqual(["10 of 40 shots", "It takes 40 recorded shots to judge your aim with it."]);
    expect([line(row("usp_silencer")), tip(row("usp_silencer"))]).toEqual(["5 of 40 shots", "It takes 40 recorded shots to judge your aim with it."]);
    // no sentence in the row itself, and every tip is one sentence of 12 words or fewer
    for (const w of Object.keys(weapons)) {
      expect(text(row(w)?.querySelector(".guncell__advice")), w).not.toMatch(/\.\s|\.$/);
      expect(tip(row(w)).split(/\s+/).length, w).toBeLessThanOrEqual(12);
      expect(tip(row(w)), w).toMatch(/^[^;]+\.$/);
      expect(tip(row(w)), w).not.toMatch(/\.\s/);
    }
    expect([cell(row("ak47"), "HS kills"), cell(row("ak47"), "Head share")]).toEqual(["40.0%", "10.0%"]);
    // the heroes carry the same advice in the "?" by their label, and no paragraph
    expect(tip(host.querySelector(".gunhero--best"))).toBe(tip(row("ak47")));
    expect(tip(host.querySelector(".gunhero--worst"))).toBe(tip(row("glock")));
    expect(host.querySelector(".gunhero p")).toBeNull();
  });
});

describe("sampled map shape", () => {
  const d = byName("synthetic");
  const conv = byName("abe5d91c");

  it("draws the sampled shape without the icon pack", () => {
    // fails if a radar stays blank when the pack has no radar though the matches hold position samples
    radarArt = null;
    use([d]);
    render(<RadarView map="de_dust2" frame={frameFor("de_dust2")!} label="radar"><circle r={1} /></RadarView>);
    expect(host.querySelector("img.radar-img")).toBeNull();
    expect(host.querySelector(".radar-view canvas.radar-img")).not.toBeNull();
  });

  it("draws the sampled shape when the radar image fails to load", () => {
    // fails if a radar whose image fails stays blank though the matches hold position samples
    radarArt = "blob:radar";
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

describe("the match header's teams", () => {
  it("names the opponents the file holds: a bot match's bots, a pro match's players", () => {
    // fails if the header says "5 bots" whatever the file holds, or loses the teammate count
    const team = () => [".mhero__team:not(.mhero__team--them) .mhero__name", ".mhero__team--them .mhero__name"].map((sel) => host.querySelector(sel)?.textContent?.trim());
    const bots = samples.find((x) => x.entry.players.filter((p) => !p.bot).length === 1 && x.entry.players.length === 10)!;
    use([bots]);
    render(<MatchView file={bots.file} tab="overview" />);
    expect(team()).toEqual([`${bots.entry.players[bots.entry.you].name} + 4`, "5 bots"]);
    // a pro match: ten people, no team names in the file
    const me = bots.entry.players[bots.entry.you];
    const pro: Sample = { ...bots, file: "samples/pro-like", entry: { ...bots.entry, file: "samples/pro-like", players: bots.entry.players.map((p) => ({ ...p, bot: false, name: p === me ? me.name : `pro${p.id.slice(-3)}` })) } };
    use([pro]);
    render(<MatchView file={pro.file} tab="overview" />);
    expect(team()).toEqual([`${me.name} + 4`, "5 players"]);
  });
});
