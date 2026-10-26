import { describe, expect, it } from "vitest";
import { MATCH_TABS, matchHref, matchTabKey, matchTabOfKey, pageHref, parseHash, scopeQuery } from "./router";

describe("match tab shortcuts", () => {
  it("reaches every match tab with Alt and one digit, 0 being the tenth", () => {
    // fails if a tab is added past the digits, or Luck or Replay loses its key
    expect(MATCH_TABS.map((_, i) => matchTabOfKey(matchTabKey(i)))).toEqual([...MATCH_TABS]);
    expect([matchTabOfKey("1"), matchTabOfKey("8"), matchTabOfKey("9"), matchTabOfKey("0")]).toEqual(["overview", "advanced", "luck", "replay"]);
  });
  it("ignores keys that are not one digit", () => {
    expect(["a", "10", "", "Alt"].map(matchTabOfKey)).toEqual([null, null, null, null]);
  });
  it("parses the Luck tab from a match link", () => {
    expect(parseHash(matchHref("2026/a.json.gz", "luck")).tab).toBe("luck");
  });
});

describe("parseHash", () => {
  it("defaults to home", () => {
    expect(parseHash("").page).toBe("home");
    expect(parseHash("#/").page).toBe("home");
    expect(parseHash("#/nonsense").page).toBe("home");
  });
  it("reads pages and query parameters", () => {
    const r = parseHash("#/profile?side=t&map=de_dust2");
    expect(r.page).toBe("profile");
    expect(r.query.get("side")).toBe("t");
    expect(r.query.get("map")).toBe("de_dust2");
  });
  it("reads a match file with slashes and its tab", () => {
    const r = parseHash("#/match/2026/20261025T030748Z_de_dust2_befc19e4.json.gz/rounds?round=7");
    expect(r.page).toBe("match");
    expect(r.file).toBe("2026/20261025T030748Z_de_dust2_befc19e4.json.gz");
    expect(r.tab).toBe("rounds");
    expect(r.query.get("round")).toBe("7");
  });
  it("defaults the match tab to overview", () => {
    const r = parseHash("#/match/samples/a.json.gz");
    expect(r.file).toBe("samples/a.json.gz");
    expect(r.tab).toBe("overview");
  });
});

describe("Profile tabs", () => {
  // Playstyle, Career aim and Weapons are Profile's tabs; their old links open the tab, keeping their scope
  it("opens #/profile/<tab>, and the old pages as their tab", () => {
    expect([parseHash("#/profile/duels").page, parseHash("#/profile/duels").ptab]).toEqual(["profile", "duels"]);
    expect(parseHash("#/profile").ptab).toBe("overview");
    expect(parseHash("#/profile/nonsense").ptab).toBe("overview");
    const r = parseHash("#/playstyle?map=de_dust2&n=10");
    expect([r.page, r.ptab, r.query.get("map")]).toEqual(["profile", "playstyle", "de_dust2"]);
    expect(parseHash("#/aim").ptab).toBe("aim");
    expect(parseHash("#/weapons").ptab).toBe("weapons");
  });
  it("opens an old ?sec= section link on the tab that now holds it, at the section it became", () => {
    // fails if a bookmark to the one-page Profile lands on the wrong tab, or keeps a section id the tab
    // does not have ("identity" was Playstyle's heading, "performance" the attribute block's)
    const at = (h: string) => { const r = parseHash(h); return [r.ptab, r.query.get("sec"), r.query.get("map")]; };
    expect(at("#/profile?sec=identity&map=de_dust2")).toEqual(["playstyle", null, "de_dust2"]);
    expect(at("#/profile?sec=performance")).toEqual(["overview", "firepower", null]);
    expect(at("#/profile?sec=style")).toEqual(["overview", "style", null]);
    expect(at("#/profile?sec=howgood")).toEqual(["duels", "howgood", null]);
    expect(at("#/profile?sec=firepower")).toEqual(["overview", "firepower", null]);
    // a section on a named tab is that tab's own
    expect(at("#/profile/duels?sec=openings")).toEqual(["duels", "openings", null]);
  });
  it("carries the scope keys a tab switch keeps, and none of a tab's own", () => {
    // fails if a tab switch drops the map, matches, side, gun class, result or comparison, or carries a
    // section, attribute or pro into a tab that has none of them
    const q = parseHash("#/profile/overview?map=de_dust2&n=10&side=t&guns=rifle&result=W&cmp=bots&sec=card&attr=firepower&pro=s1mple").query;
    expect(scopeQuery(q)).toEqual({ map: "de_dust2", n: "10", side: "t", guns: "rifle", result: "W", cmp: "bots" });
    expect(scopeQuery(parseHash("#/profile").query)).toEqual({});
  });
});

describe("hrefs", () => {
  it("round-trips a match link", () => {
    const href = matchHref("2026/a b.json.gz", "economy", { round: 3, empty: null });
    expect(href).toBe("#/match/2026/a%20b.json.gz/economy?round=3");
    const r = parseHash(href);
    expect(r.file).toBe("2026/a b.json.gz");
    expect(r.tab).toBe("economy");
  });
  it("builds page links", () => {
    expect(pageHref("home")).toBe("#/");
    expect(pageHref("matches", { map: "de_dust2" })).toBe("#/matches?map=de_dust2");
  });
});
