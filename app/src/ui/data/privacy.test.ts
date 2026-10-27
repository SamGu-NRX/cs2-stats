// The rules of "Hide personal info" one at a time (privacy.ts). privacy.test.tsx in views/ checks
// that every page applies them.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayerInfo } from "../../stats/facts";
import type { MatchEntry } from "./match";
import { parsePayload } from "./leetify/api";
import { syntheticPayload, syntheticProfile, SYNTHETIC_MATCHES } from "./leetify/synthetic";
import { hideFile, hideLeetifyData, hideLeetifyStatus, hidePlayers, hideText, hideTextAndFiles, isProDemo, LEETIFY_ID_HIDDEN, privacySwitch, STEAMID_HIDDEN } from "./privacy";

const ID = "76561190000000099";

describe("privacySwitch", () => {
  it("is on for VITE_PRIVACY=1 or privacy=1 in the query, and nothing else", () => {
    expect(privacySwitch("1", "")).toBe(true);
    expect(privacySwitch(undefined, "?privacy=1")).toBe(true);
    expect(privacySwitch(undefined, "?demo=synthetic&privacy=1")).toBe(true);
    expect(privacySwitch(undefined, "")).toBe(false);
    expect(privacySwitch("0", "?privacy=0")).toBe(false);
    expect(privacySwitch("true", "?privacy")).toBe(false);
  });
});

describe("the setting with storage the browser refuses", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const refusing = { getItem: () => { throw new DOMException("denied", "SecurityError"); }, setItem: () => { throw new DOMException("full", "QuotaExceededError"); } };

  it("starts off when reading throws, and holds a choice it could not save on, saying so", async () => {
    vi.stubGlobal("localStorage", refusing);
    vi.resetModules();
    const p = await import("./privacy");
    expect(p.hidingPersonal()).toBe(false);
    const seen: boolean[] = [];
    p.onHidePersonalChange(() => seen.push(p.hidingPersonal()));
    expect(p.setHidePersonal(true)).toMatch(/could not be saved/);
    expect(p.hidingPersonal()).toBe(true);
    // turning it off cannot be kept either, so it stays on rather than off
    expect(p.setHidePersonal(false)).toMatch(/stays on/);
    expect(p.hidingPersonal()).toBe(true);
    expect(seen).toEqual([true, true]);
  });

  it("applies a choice only once it is saved", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    vi.resetModules();
    const p = await import("./privacy");
    expect(p.setHidePersonal(true)).toBeNull();
    expect([p.hidingPersonal(), store.get("cs2stats.hidePersonal")]).toEqual([true, "1"]);
    expect(p.setHidePersonal(false)).toBeNull();
    expect([p.hidingPersonal(), store.get("cs2stats.hidePersonal")]).toEqual([false, "0"]);
  });
});

describe("hidePlayers", () => {
  const p = (name: string, team: 0 | 1 | null, bot = false, id = name): PlayerInfo => ({ id, name, team, bot });
  // a Valve 5v5 seen from team 1, with a bot and a player who never had a side
  const players = [p("Mate A", 1), p("Foe A", 0), p("Me", 1, false, ID), p("Rip", 0, true), p("Foe B", 0), p("Mate B", 1), p("Spectator", null)];

  it("names you You, other humans by team in file order, and keeps bots and every id", () => {
    const out = hidePlayers(players, { you: 2, usTeam: 1, pro: false });
    expect(out.map((x) => x.name)).toEqual(["Teammate 1", "Opponent 1", "You", "Rip", "Opponent 2", "Teammate 2", "Player 1"]);
    expect(out.map((x) => x.id)).toEqual(players.map((x) => x.id));
    expect(out.map((x) => [x.team, x.bot])).toEqual(players.map((x) => [x.team, x.bot]));
  });

  it("keeps every name in a pro demo", () => {
    expect(hidePlayers(players, { you: 2, usTeam: 1, pro: true })).toBe(players);
  });
});

describe("isProDemo", () => {
  const tagged = (source: string) => ({ match: { source } }) as Pick<MatchEntry, "match">;
  it("takes only the match's own hltv tag as evidence, whatever folder the file is in", () => {
    expect(isProDemo(tagged("hltv"))).toBe(true);
    for (const s of ["local", "valve", "faceit", ""]) expect(isProDemo(tagged(s))).toBe(false);
  });
});

describe("hideFile", () => {
  it.each([
    ["imported/Ann Lee.json.gz", "imported/<file>.json.gz"],
    ["picked/ann.json.gz", "picked/<file>.json.gz"],
    ["2026/20261024T223834Z_de_dust2_abe5d91c.json.gz", "2026/<file>.json.gz"],
    ["valve/match730_003/v1", "valve/<file>"],
    ["valve/match730_003/v1/match.parquet", "valve/<file>.parquet"],
    ["dev/scrim", "dev/<file>"],
    ["Ann Lee.json.gz", "<file>.json.gz"],
    ["samples/20261024T223834Z_de_dust2_abe5d91c.json.gz", "samples/20261024T223834Z_de_dust2_abe5d91c.json.gz"],
  ])("%s reads %s", (file, hidden) => {
    expect(hideFile(file)).toBe(hidden);
  });

  it("hides a file by its path and by its bare name in text, then applies hideText", () => {
    expect(hideTextAndFiles("Ann Lee.json.gz was not imported: Ann Lee.json.gz: already imported", ["Ann Lee.json.gz"]))
      .toBe("<file>.json.gz was not imported: <file>.json.gz: already imported");
    expect(hideTextAndFiles(`imported/Ann Lee.json.gz: the recording player (match pov ${ID}) is not among the players`, ["imported/Ann Lee.json.gz"]))
      .toBe("imported/<file>.json.gz: the recording player (match pov <SteamID>) is not among the players");
    expect(hideTextAndFiles("2 of 3 failed validation and are not shown: ann_scrim.dem, match730_1.dem.", ["ann_scrim.dem", "match730_1.dem"]))
      .toBe("2 of 3 failed validation and are not shown: <file>.dem, <file>.dem.");
    // a version folder's bare name ("v1") is not replaced inside other words
    expect(hideTextAndFiles("valve/m/v1 has v1 tables", ["valve/m/v1"])).toBe("valve/<file> has v1 tables");
  });
});

describe("hideText", () => {
  const user = ["C:", "Users", "Ann Example"].join("\\");
  it.each([
    [`ENOENT: no such file or directory, scandir '${user}\\AppData\\Roaming\\BotMatchStats\\matches'`, "ENOENT: no such file or directory, scandir '<path>'"],
    [`failed to read ${user}\\My Demos\\match.json: access denied`, "failed to read <path>: access denied"],
    [`"${user.replaceAll("\\", "\\\\")}\\\\x.json" missing`, `"<path>" missing`],
    ["D:/Games/CS2 Demos/a.dem is gone", "<path> is gone"],
    ["\\\\nas\\share\\cs2\\x.dem (os error 5)", "<path> (os error 5)"],
    ["cannot open /home/ann/cs2/valve/x.parquet, retrying", "cannot open <path>, retrying"],
    [`the recording player (match pov ${ID}) is not among the players`, "the recording player (match pov <SteamID>) is not among the players"],
    ["STEAM_1:0:12345 and [U:1:24691]", "<SteamID> and <SteamID>"],
    [`see https://steamcommunity.com/profiles/${ID}/ for more`, "see <Steam profile> for more"],
    [`see https://www.steamcommunity.com/profiles/${ID} or http://www.steamcommunity.com/id/annlee/`, "see <Steam profile> or <Steam profile>"],
    ["www.steamcommunity.com/id/annlee", "<Steam profile>"],
    ["add me: https://s.team/p/abcd-efgh or s.team/p/wxyz-1234/ABCDEF", "add me: <Steam profile> or <Steam profile>"],
    ["HTTPS://STEAMCOMMUNITY.COM/ID/AnnLee", "<Steam profile>"],
    // file URLs, percent-encoded or with spaces
    [`open file:///${["C:", "Users", "Ann%20Lee", "x.dem"].join("/")} now`, "open <path> now"],
    ["open file:///home/ann/My Demos/x.dem, then", "open <path>, then"],
    [`"file://${["", "Users", "ann", "x.json.gz"].join("/")}"`, `"<path>"`],
    // folder names with spaces, quoted and not, in both path styles
    ["cannot open /home/ann/My Demos/x.dem, retrying", "cannot open <path>, retrying"],
    ["cannot open '/home/ann/My Demos/x.dem'", "cannot open '<path>'"],
    [`cannot open ${["C:", "Users", "Ann Lee", "My Demos", "x.dem"].join("\\")}, retrying`, "cannot open <path>, retrying"],
    [`cannot open "${["C:", "Users", "Ann Lee", "My Demos", "x.dem"].join("\\")}"`, `cannot open "<path>"`],
  ])("hides %s", (raw, hidden) => {
    expect(hideText(raw)).toBe(hidden);
  });

  it.each([
    "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz",
    "valve/match730_003/v1",
    "dev/pro-demo",
    String.raw`%APPDATA%\BotMatchStats\packs`,
    "http://localhost:1420/__matches/list",
    "Rating 3.0 over 12 rated matches, 3/4 won and/or tied",
    "76561190000",
  ])("leaves %s", (s) => {
    expect(hideText(s)).toBe(s);
  });
});

describe("hideLeetifyData", () => {
  it("names the player You and hides their SteamID and Leetify id everywhere, numbers untouched", () => {
    // fails if a name or id from the import survives into what the views read
    const d = parsePayload({ ...syntheticPayload(0, SYNTHETIC_MATCHES.map((m) => ({ ...m, steam64: ID, name: "Someone" }))), profile: syntheticProfile({ name: "Someone", steam64_id: ID }) });
    const h = hideLeetifyData(d);
    const text = JSON.stringify({ ...h, profile: { ...h.profile, url: "" } });
    expect(text).not.toContain(ID);
    expect(text).not.toContain("Someone");
    expect(h.profile).toMatchObject({ name: "You", steam64: STEAMID_HIDDEN, id: LEETIFY_ID_HIDDEN });
    expect(h.matches.every((m) => m.me.name === "You" && m.me.steam64 === STEAMID_HIDDEN)).toBe(true);
    expect(h.matches.map((m) => m.me.total_kills)).toEqual(d.matches.map((m) => m.me.total_kills));
    expect(h.profile.rating).toEqual(d.profile.rating);
    // the profile link keeps its address, which LeetifyLink never writes into the page while hiding
    expect(h.profile.url).toBe(d.profile.url);
  });

  it("hides the connected player and the key store's error", () => {
    const s = hideLeetifyStatus({ player: { kind: "steam", id: ID }, hasKey: false, keyStore: true, keyError: `${["C:", "Users", "someone", "cred"].join("\\")} for ${ID}`, cooldownS: null });
    expect(s.player).toEqual({ kind: "steam", id: STEAMID_HIDDEN });
    expect(s.keyError).toBe("<path> for <SteamID>");
    expect(hideLeetifyStatus({ player: { kind: "leetify", id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }, hasKey: true, keyStore: true, keyError: null, cooldownS: null }).player?.id).toBe(LEETIFY_ID_HIDDEN);
  });
});
