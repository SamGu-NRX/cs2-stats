// @vitest-environment jsdom
// The Matches page's session chips under a time zone west of UTC, where a made-up UTC midnight reads as
// the evening before: a timed match keeps its clock times, a date-only match shows its day alone, an
// undated match joins no session, and a failed sessions call says so instead of loading for good.
import { act } from "react";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { derive } from "../../stats/derive";
import type { MatchFacts } from "../../stats/facts";
import { CS2RB } from "../../stats/model-params";
import { pluginToTables } from "../../stats/plugin/adapter";
import { decodeMatch } from "../../stats/plugin/decode";
import { rollup } from "../../stats/rollup";
import { matchCalls } from "../../worker/matchcalls";
import type { Method, Query, Session } from "../../worker/protocol";
import { entryOf, metaOf, ratingsOf } from "../../worker/views";
import { sideQuery } from "../../worker/ranking";
import { careerEntries } from "../data/engine";
import type { MatchEntry } from "../data/match";
import { setMeta } from "../data/meta";
import type { Data } from "../data/provider";
import { BarProvider } from "../shell/Bar";
import { MatchesView } from "./Matches";

// before any module formats a date: the formatters take the zone when they are built
const zone = vi.hoisted(() => { const was = process.env.TZ; process.env.TZ = "America/Chicago"; return was; });
afterAll(() => { process.env.TZ = zone; });

const SAMPLES = path.resolve(import.meta.dirname, "../../../public/samples");
interface Sample { file: string; facts: MatchFacts; entry: MatchEntry }
const raw = await Promise.all(readdirSync(SAMPLES).filter((f) => f.endsWith(".json.gz")).map(async (f) => {
  const m = await decodeMatch(gunzipSync(readFileSync(path.join(SAMPLES, f))), f);
  return { file: `samples/${f}`, plugin: m.env.plugin ?? "", facts: derive(pluginToTables(m), CS2RB) };
}));
/** a sample under another name, its start time and date replaced */
const as = (i: number, file: string, when: { startedAt: string | null; date: string | null }): Sample => {
  const facts = { ...raw[i].facts, match: { ...raw[i].facts.match, ...when } };
  return { file, facts, entry: entryOf(file, raw[i].plugin, facts) };
};
const career = raw.map((r, i) => i).filter((i) => careerEntries([entryOf(raw[i].file, raw[i].plugin, raw[i].facts)], null).length);
const list: Sample[] = [
  as(career[0], "x/timed", { startedAt: "2026-10-25T02:10:00.000Z", date: "2026-10-25" }),
  as(career[1], "x/dated-a", { startedAt: null, date: "2026-10-24" }),
  as(career[2], "x/dated-b", { startedAt: null, date: "2026-10-24" }),
  as(career[3], "x/undated", { startedAt: null, date: null }),
];
const factsOf = new Map(list.map((s) => [s.file, s.facts]));
const summary = (q: Query) => rollup(q.files.map((f) => factsOf.get(f)!), q.filter);
const calls = matchCalls(async (files, visit) => { for (const f of files) visit(factsOf.get(f)!, f); }, async (q) => summary(q));

let data: Pick<Data, "matches" | "you"> = { matches: [], you: [] };
/** the worker's sessions answers, by the call's arguments; `fail` makes every call reject */
const sessionsBy = new Map<string, Session[]>();
const asked: unknown[][] = [];
let fail: string | null = null;
vi.mock("../data/provider", () => ({ useData: () => ({ ...data, status: "ready", host: null, client: null, baselines: null, baselinesError: null }) }));
vi.mock("../data/hooks", async (orig) => ({
  ...(await orig<object>()),
  useRatings: (qs: Query[] | null) => ({ data: qs?.length ? qs.map((q) => ratingsOf({ both: summary(sideQuery(q, "both")), T: summary(sideQuery(q, "T")), CT: summary(sideQuery(q, "CT")) })) : null, error: null, loading: false }),
  useCall: (method: Method, args: unknown[] | null) => {
    if (!args || method !== "sessions") return { data: null, error: null, loading: false };
    asked.push(args);
    if (fail) return { data: null, error: fail, loading: false };
    return { data: sessionsBy.get(JSON.stringify(args)) ?? null, error: null, loading: !sessionsBy.has(JSON.stringify(args)) };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} } as unknown as typeof ResizeObserver;
globalThis.CSS ??= { escape: (x: string) => x } as unknown as typeof CSS;
setMeta(metaOf(CS2RB));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  data = { matches: list.map((s) => s.entry), you: [...new Set(list.map((s) => s.facts.match.pov!))] };
  sessionsBy.clear();
  asked.length = 0;
  fail = null;
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});
const render = () => act(() => root.render(<BarProvider><MatchesView /></BarProvider>));
const chips = () => Array.from(host.querySelectorAll(".sess__when")).map((el) => el.textContent);

describe("session chips west of UTC", () => {
  it("shows clock times only for timed matches, the day for date-only ones, and no session for undated ones", async () => {
    // fails if a date-only match's chip reads as the evening before (Oct 23, 7:00 PM in Chicago), an
    // undated match shows a 1969 or Dec 31 time, or an undated match is grouped by a made-up time
    expect(new Date("2026-10-24T00:00:00Z").getDate()).toBe(23);
    render();
    for (const args of asked) sessionsBy.set(JSON.stringify(args), await calls.sessions(...(args as [Query, number?])));
    render();
    const files = [...new Set(asked.map((a) => (a[0] as Query).files.join(",")))];
    expect(files.sort()).toEqual(["x/dated-a,x/dated-b", "x/timed"].sort());
    // the timed match at its local clock time, the two date-only matches as one day, newest first
    expect(chips()).toHaveLength(2);
    expect(chips()[0]).toMatch(/^Oct 24, 9:10 PM – \d{1,2}:\d{2} (PM|AM)$/);
    expect(chips()[1]).toBe("Oct 24");
    expect(host.textContent).not.toMatch(/Dec 31|Oct 23|1969/);
  });

  it("says the sessions call failed instead of loading for good", () => {
    // fails if a rejected sessions call leaves the skeleton up, or loses the worker's reason
    fail = "the worker stopped";
    render();
    expect(host.querySelector(".sessions .skel")).toBeNull();
    expect(host.querySelector(".sessions .load-failed")?.textContent).toBe("Sessions could not load: the worker stopped");
  });
});
