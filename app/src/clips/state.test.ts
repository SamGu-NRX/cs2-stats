// Where a moment stands (state.ts): the demo its match needs, and the order the states win in.
import { describe, expect, it } from "vitest";
import type { MatchEntry } from "../ui/data/match";
import type { ClipsScan } from "./host";
import { clipState, demoSource, type Lookup } from "./state";

const entry = (file: string, source: string, origin = ""): Pick<MatchEntry, "file" | "origin" | "hasAim" | "hasPos" | "match"> =>
  ({ file, origin, hasAim: true, hasPos: true, match: { source } as MatchEntry["match"] });

describe("demoSource", () => {
  it("names a Valve match's demo after its folder, and says why every other source has none", () => {
    // fails if a Valve match points at another file, or a plugin match is offered a demo
    expect(demoSource(entry("valve/match730_0035_0012/v-3.1.0-0123abcd", "valve"))).toEqual({ kind: "demo", name: "match730_0035_0012.dem" });
    const none = (e: ReturnType<typeof entry>) => { const s = demoSource(e); return s.kind === "none" ? s.why : `demo ${s.name}`; };
    expect(none(entry("2026/20261024T223834Z_de_dust2_abe5d91c.json.gz", "local"))).toMatch(/plugin records match data, not a demo/);
    expect(none(entry("samples/old.json.gz", "local", "legacy-convert"))).toMatch(/converted console log/);
    expect(none(entry("dev/navi-vs-g2-m1-mirage", "hltv"))).toMatch(/deletes each demo/);
    // a "valve/" path whose match does not say it is Valve's is not trusted to name a demo
    expect(none(entry("valve/x/v-1-0123abcd", "local"))).toMatch(/plugin/);
  });
});

describe("clipState", () => {
  const ID = "c-0123456789abcdef-r3";
  const demo = { kind: "demo" as const, name: "m.dem" };
  const scan = (s: Partial<ClipsScan>): ClipsScan => ({ finished: [], takes: [], reels: [], ...s });
  const look = (l: Partial<Lookup>): Lookup => ({ demos: null, scan: null, why: null, ...l });

  it("prefers a finished clip, then the newest take, then the demo on disk", () => {
    // fails if a rendered clip shows as ready, an older take wins, or a found demo is not ready
    const take = (job: string, mtime: number) => ({ id: ID, job, take: "take0000", video: `${job}/take0000/video.mp4`, audio: null, mtime });
    const demos = new Map([["m.dem", { name: "m.dem", path: "D:/r/m.dem", size: 1 }]]);
    expect(clipState(ID, demo, look({ demos, scan: scan({ finished: [{ id: ID, path: "E:/c.mp4", size: 1, mtime: 1 }], takes: [take("a", 1)] }) }))).toEqual({ kind: "rendered", path: "E:/c.mp4" });
    expect(clipState(ID, demo, look({ demos, scan: scan({ takes: [take("old", 1), take("new", 2)] }) }))).toMatchObject({ kind: "recorded", take: { job: "new" } });
    expect(clipState(ID, demo, look({ demos, scan: scan({}) }))).toEqual({ kind: "ready", demoPath: "D:/r/m.dem" });
  });

  it("says why when the demo is gone, the match has none, or nobody could look", () => {
    // fails if a missing demo, a plugin match or the browser offers a render
    expect(clipState(ID, demo, look({ demos: new Map([["m.dem", { name: "m.dem", path: null, size: 0 }]]) }))).toEqual({ kind: "no-demo", why: expect.stringMatching(/m\.dem is not in CS2's replays folder/) });
    expect(clipState(ID, { kind: "none", why: "no demo" }, look({ demos: new Map() }))).toEqual({ kind: "no-demo", why: "no demo" });
    expect(clipState(ID, demo, look({ why: "browser" }))).toEqual({ kind: "unchecked", why: "browser" });
  });
});
