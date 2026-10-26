// The Bot Mode view's own judgements on backend data: which release is newest, whether the install
// is behind, what blocks a write, and how a catalog kit name splits.
import { describe, expect, it } from "vitest";
import type { GithubRelease, Status } from "../../botmode/commands";
import { mockCall, RELEASES } from "../../botmode/mock";
import { installState, kitChoices, kitParts, latestRelease, writeBlocker } from "./botmode";

const status = (s: Parameters<typeof mockCall>[0]): Status => structuredClone(mockCall(s).state.status);
const rel = (tag: string, published: string | null, extra: Partial<GithubRelease> = {}): GithubRelease => ({ ...RELEASES[0], tag_name: tag, published_at: published, ...extra });

describe("latestRelease", () => {
  it("takes the newest published release, never a draft or prerelease", () => {
    const list = [rel("v1.4.6", "2026-10-11T00:00:00Z"), rel("v1.5.0-rc1", "2026-10-30T00:00:00Z", { prerelease: true }), rel("v1.5.0", "2026-10-31T00:00:00Z", { draft: true }), rel("v1.4.7", "2026-10-25T00:00:00Z"), rel("v0", null)];
    expect(latestRelease(list)?.tag_name).toBe("v1.4.7");
    expect(latestRelease([])).toBeNull();
  });
});

describe("installState", () => {
  it("is behind only when the installed tag is an older listed release", () => {
    expect(installState(status("outdated"), RELEASES)).toMatchObject({ kind: "behind", tag: "v1.4.6", latest: { tag_name: "v1.4.7" } });
    expect(installState(status("installed"), RELEASES)).toMatchObject({ kind: "current", tag: "v1.4.7" });
    // a tag GitHub does not list (a fork's own release) is not called out of date
    const s = status("installed");
    s.release.installed!.tag = "v1.4.7-sam";
    expect(installState(s, RELEASES)).toMatchObject({ kind: "current", tag: "v1.4.7-sam" });
    // before the releases load nothing is judged behind
    expect(installState(status("outdated"), null)).toMatchObject({ kind: "current", latest: null });
  });

  it("is missing without Metamod or CounterStrikeSharp, and by hand when only a downloaded release matches", () => {
    expect(installState(status("not-installed"), RELEASES).kind).toBe("missing");
    const s = status("installed");
    s.components = s.components.map((c) => (c.name === "CounterStrikeSharp" ? { ...c, state: "missing" } : c));
    expect(installState(s, RELEASES).kind).toBe("missing");
    const hand = status("installed");
    hand.release = { installed: null, reference: "v1.4.7 (CS2BotImprover.zip)", matching: 551, total: 562 };
    expect(installState(hand, RELEASES)).toMatchObject({ kind: "byHand", reference: "v1.4.7 (CS2BotImprover.zip)" });
    hand.release.reference = null;
    expect(installState(hand, RELEASES).kind).toBe("unknown");
  });
});

describe("writeBlocker", () => {
  it("names the first thing the backend would refuse a write for", () => {
    expect(writeBlocker(status("installed"), false)).toBeNull();
    expect(writeBlocker(status("unfinished"), false)).toMatch(/interrupted/);
    expect(writeBlocker(status("session"), true)).toMatch(/session is running/);
    expect(writeBlocker(status("cs2-running"), false)).toMatch(/CS2 is running/);
    const unknown = status("installed");
    unknown.cs2Running = null;
    expect(writeBlocker(unknown, false)).toMatch(/could not check/);
  });
});

describe("music kits", () => {
  it("splits the catalog's name into artist and title, and lists Off and Random first", () => {
    expect(kitParts("Music Kit | Daniel Sadowski, Crimson Assault", 3)).toEqual({ artist: "Daniel Sadowski", title: "Crimson Assault" });
    expect(kitParts("Music Kit | Solo", 9)).toEqual({ artist: null, title: "Solo" });
    expect(kitParts(null, 41)).toEqual({ artist: null, title: "Kit 41" });
    const c = kitChoices({ musicKits: [{ id: 4, name: "Music Kit | Noisia, Sharpened" }, { id: 3, name: "Music Kit | Daniel Sadowski, Crimson Assault" }], knives: [], knifeFinishes: [] });
    expect(c.map((k) => k.id)).toEqual([0, -1, 3, 4]);
    expect(kitChoices(null).map((k) => k.title)).toEqual(["Off", "Random each map"]);
  });
});
