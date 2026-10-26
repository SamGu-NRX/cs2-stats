import { describe, expect, it } from "vitest";
import { knownMatchFiles, MATCH_TABS, matchHref, matchId, matchTabKey, matchTabOfKey, pageHref, parseHash, profileCanonicalHash, scopeQuery } from "./router";

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

describe("match ids", () => {
  const files = ["imported/Ann Lee vs friends.json.gz", "2026/20261024T223834Z_de_dust2_abe5d91c.json.gz", "valve/match730_003/v1"];
  it("are short, stable, distinct and carry nothing of the file name", () => {
    const ids = files.map(matchId);
    expect(ids).toEqual(files.map(matchId));
    expect(new Set(ids).size).toBe(files.length);
    for (const id of ids) expect(id).toMatch(/^m-[0-9a-z]{1,11}$/);
    expect(ids[0]).not.toMatch(/ann|lee|friends/i);
  });
  it("open their match once the app has listed it, and the file path still opens it", () => {
    knownMatchFiles(files);
    expect(parseHash(`#/match/${matchId(files[0])}/rounds?round=3`)).toMatchObject({ page: "match", file: files[0], tab: "rounds" });
    expect(parseHash(`#/match/${matchId(files[2])}`)).toMatchObject({ page: "match", file: files[2], tab: "overview" });
    expect(parseHash(matchHref(files[1], "economy"))).toMatchObject({ page: "match", file: files[1], tab: "economy" });
    // an id no listed match has stays as it is, and the match view says it is not in the folder
    expect(parseHash("#/match/m-zzzz/overview").file).toBe("m-zzzz");
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
    // fails if a tab switch drops the map, matches, side or comparison, or carries a section,
    // attribute or pro into a tab that has none of them
    const q = parseHash("#/profile/overview?map=de_dust2&n=10&side=t&cmp=bots&sec=card&attr=firepower&pro=some-pro").query;
    expect(scopeQuery(q)).toEqual({ map: "de_dust2", n: "10", side: "t", cmp: "bots" });
    expect(scopeQuery(parseHash("#/profile").query)).toEqual({});
  });
  it("drops the query keys Profile does not read, on its tabs and on the old pages", () => {
    // fails if a legacy #/aim?guns=rifle&result=W keeps a gun class or result Profile never applies,
    // so the URL would claim a filter the page does not show
    for (const h of ["#/aim?guns=rifle&result=W&map=de_dust2&side=t", "#/profile/aim?guns=rifle&result=W&map=de_dust2&side=t", "#/weapons?result=L&guns=smg&map=de_dust2&side=t"]) {
      expect(Object.fromEntries(parseHash(h).query), h).toEqual({ map: "de_dust2", side: "t" });
    }
    expect(Object.fromEntries(parseHash("#/profile/overview?sec=style&attr=entrying&pro=some-pro&cmp=bots&n=5").query)).toEqual({ sec: "style", attr: "entrying", pro: "some-pro", cmp: "bots", n: "5" });
    // other pages keep theirs
    expect(parseHash("#/matches?result=W&guns=rifle").query.get("result")).toBe("W");
  });
});

describe("profileCanonicalHash", () => {
  it("names the tab a legacy link resolved to, so a reload or Back lands on the same tab", () => {
    // fails if the rewritten address keeps the old path: #/profile?sec=identity tidies to #/profile,
    // which parses as Overview
    for (const h of ["#/profile?sec=identity&map=de_dust2", "#/profile?sec=performance&side=t", "#/aim?guns=rifle&side=t", "#/weapons?map=de_inferno", "#/playstyle", "#/profile"]) {
      const r = parseHash(h);
      const again = parseHash(profileCanonicalHash(r));
      expect([again.page, again.ptab, again.query.toString()], h).toEqual(["profile", r.ptab, r.query.toString()]);
    }
    expect(profileCanonicalHash(parseHash("#/profile?sec=identity&map=de_dust2"))).toBe("#/profile/playstyle?map=de_dust2");
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
