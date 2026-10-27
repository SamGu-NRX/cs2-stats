// The Bot Mode view's own judgements on backend data: which release is newest, whether the install
// is behind, what blocks a write, and how a catalog kit name splits.
import { describe, expect, it } from "vitest";
import type { GithubRelease, Status } from "../../botmode/commands";
import { mockCall, RELEASES } from "../../botmode/mock";
import { installState, isKeyName, kitChoices, kitParts, latestRelease, parseModCommands, splitOptions, vacState, writeBlocker } from "./botmode";

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

describe("vacState", () => {
  it("reads VAC from the running game first, then from gameinfo.gi and Steam's own options", () => {
    const s = status("installed");
    expect(vacState(s, [], false).text).toBe("VAC on");
    expect(vacState(s, null, false).tone).toBe("unknown");
    expect(vacState(s, [{ vac: "off", pid: 7, commandLine: "cs2.exe -insecure" }], true).text).toBe("VAC off for this session");
    expect(vacState(s, [{ vac: "off", pid: 7, commandLine: "cs2.exe -insecure" }], false).text).toBe("VAC off");
    expect(vacState(s, [{ vac: "on", pid: 7, why: "-insecure is missing" }, { vac: "unknown", pid: 8, why: "access denied" }], false).text).toBe("VAC state unknown");
    expect(vacState(s, [{ vac: "on", pid: 7, why: "-insecure is missing" }], false).text).toBe("VAC on");
    // nothing runs, but the next start from Steam would not be a plain VAC game
    expect(vacState({ ...s, botMode: true }, [], false)).toMatchObject({ tone: "warn", text: "Bot Mode on in gameinfo.gi" });
    expect(vacState({ ...s, steamLaunchOptions: "-novid -INSECURE" }, [], false)).toMatchObject({ tone: "warn", text: "VAC off on Steam starts" });
    expect(vacState({ ...s, steamLaunchOptions: "-insecurex" }, [], false).text).toBe("VAC on");
  });

  it("counts a quoted -insecure as the command line does, and a -secure after it turns VAC back on", () => {
    const s = status("installed");
    expect(vacState({ ...s, steamLaunchOptions: '-novid "-insecure"' }, [], false).text).toBe("VAC off on Steam starts");
    expect(vacState({ ...s, steamLaunchOptions: '"-novid -insecure"' }, [], false).text).toBe("VAC on");
    expect(vacState({ ...s, steamLaunchOptions: "-insecure +secure" }, [], false).text).toBe("VAC on");
    expect(vacState({ ...s, steamLaunchOptions: '-insecure "unbalanced' }, [], false).text).toBe("VAC state unknown");
  });

  it("never says VAC on when gameinfo.gi or Steam's options could not be read", () => {
    const s = status("installed");
    expect(vacState({ ...s, botMode: null }, [], false)).toMatchObject({ tone: "unknown", text: "VAC state unknown" });
    expect(vacState({ ...s, steamLaunchOptions: null }, [], false)).toMatchObject({ tone: "unknown", text: "VAC state unknown" });
    // a running CS2's own command line still decides: it is the game itself
    expect(vacState({ ...s, botMode: null, steamLaunchOptions: null }, [{ vac: "on", pid: 7, why: "-insecure is missing" }], false).text).toBe("VAC on");
  });
});

describe("splitOptions", () => {
  it("splits as launch.rs split does", () => {
    expect(splitOptions('-novid +exec "my autoexec" -insecure')).toEqual(["-novid", "+exec", "my autoexec", "-insecure"]);
    expect(splitOptions('""')).toEqual([""]);
    expect(splitOptions("  ")).toEqual([]);
    expect(splitOptions('+exec "x')).toBeNull();
  });
});

describe("parseModCommands", () => {
  it("groups commands under their headings and pairs each team's CT and T lineups", () => {
    const p = parseModCommands(["BOT AIM STYLE", "", "bot_aim head", "ADD TEAMS", "1. Falcons", 'bot_add_ct "NiKo"', 'bot_add_t "NiKo"', "2. Solo", 'bot_add_t "x"', "COORDINATED BUY", "awp", ""].join("\r\n"));
    expect(p.groups).toEqual([{ title: "Bot aim style", commands: ["bot_aim head"] }, { title: "Coordinated buy", commands: ["awp"] }]);
    expect(p.teams).toEqual([{ name: "Falcons", ct: 'bot_add_ct "NiKo"', t: 'bot_add_t "NiKo"' }, { name: "Solo", ct: null, t: 'bot_add_t "x"' }]);
  });
});

describe("isKeyName", () => {
  it("accepts what the backend's check_key accepts", () => {
    for (const k of ["\\", "k", "K", "5", "/", "mouse4", "kp_end", "f12"]) expect(isKeyName(k), k).toBe(true);
    for (const k of ["", "a;b", 'x"', "MOUSE4", "two words", "a_very_long_key_name_x", "//"]) expect(isKeyName(k), k).toBe(false);
  });
});
