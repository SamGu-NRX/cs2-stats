import { describe, expect, it, vi } from "vitest";
import { knownMatchFiles, MATCH_TABS, matchFile, matchHref, matchId, matchTabKey, matchTabOfKey, pageHref, parseHash, profileCanonicalHash, scopeQuery } from "./router";

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
    for (const id of ids) expect(id).toMatch(/^m-[0-9a-f]{16}$/);
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
  it("never hashes an id again", () => {
    const id = matchId(files[0]);
    expect(matchId(id)).toBe(id);
    expect(matchHref(id, "rounds")).toBe(`#/match/${id}/rounds`);
    knownMatchFiles([]);
    // before the list arrives the id is kept, not taken for a file name
    expect(matchId("m-abc123")).toBe("m-abc123");
    expect(matchFile("m-abc123")).toBe("m-abc123");
  });
  it("gives colliding files ids from their own paths, which do not change when another colliding file goes", () => {
    // A, B and C share their plain hash; their second hashes differ
    const second: Record<string, string> = { "a/1.json.gz": "aaaa1111", "b/2.json.gz": "aaaa2222", "c/3.json.gz": "cccc3333" };
    const hash = (f: string, seed = 0) => (seed === 0 ? (f === "d/4.json.gz" ? "dddd" : "beef") : second[f] ?? "0000");
    knownMatchFiles(["b/2.json.gz", "c/3.json.gz", "a/1.json.gz", "d/4.json.gz"], hash);
    const before = ["a/1.json.gz", "b/2.json.gz", "c/3.json.gz", "d/4.json.gz"].map(matchId);
    expect(before).toEqual(["m-beef-aaaa1111", "m-beef-aaaa2222", "m-beef-cccc3333", "m-dddd"]);
    // A is deleted and the folder rescanned: B and C keep their ids, and each still opens its own file
    knownMatchFiles(["c/3.json.gz", "b/2.json.gz", "d/4.json.gz"], hash);
    expect(["b/2.json.gz", "c/3.json.gz", "d/4.json.gz"].map(matchId)).toEqual(before.slice(1));
    expect(before.slice(1).map(matchFile)).toEqual(["b/2.json.gz", "c/3.json.gz", "d/4.json.gz"]);
    expect(matchFile(before[0])).toBe(before[0]);
    // C deleted too: B's id is its plain one again, and its bookmarked longer id still opens it
    knownMatchFiles(["b/2.json.gz", "d/4.json.gz"], hash);
    expect(matchId("b/2.json.gz")).toBe("m-beef");
    expect(matchFile("m-beef-aaaa2222")).toBe("b/2.json.gz");
    knownMatchFiles([]);
  });
  it("give files that share both hashes no working id, without throwing, and keep every other file", () => {
    // A and B share both hashes; C shares only the plain one; D shares neither
    const hash = (f: string, seed = 0) => (seed === 0 ? (f === "d/4.json.gz" ? "dddd" : "beef") : f === "c/3.json.gz" ? "cccc" : "aaaa");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => knownMatchFiles(["a/1.json.gz", "b/2.json.gz", "c/3.json.gz", "d/4.json.gz"], hash)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(/^2 match files/);
    expect(String(error.mock.calls[0][0])).not.toMatch(/json\.gz/);
    error.mockRestore();
    const [a, b, c, d] = ["a/1.json.gz", "b/2.json.gz", "c/3.json.gz", "d/4.json.gz"].map(matchId);
    expect(a).toBe(b);
    expect(matchFile(a)).toBe(a);
    expect(matchFile("m-beef")).toBe("m-beef");
    expect([matchFile(c), matchFile(d)]).toEqual(["c/3.json.gz", "d/4.json.gz"]);
    knownMatchFiles([]);
  });
  it("are 64 bits of the path, the same for a path whatever else is listed", () => {
    knownMatchFiles([]);
    const alone = matchId("imported/x.json.gz");
    knownMatchFiles(["imported/x.json.gz", "2026/y.json.gz"]);
    expect(matchId("imported/x.json.gz")).toBe(alone);
    expect(alone).toMatch(/^m-[0-9a-f]{16}$/);
    knownMatchFiles([]);
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
  it("keeps Overview's Form filters and picked trend in the address, and leaves them behind on a tab switch", () => {
    // fails if Profile strips the Form filters or the trend (a filtered chart would not be a link), or
    // carries them to a tab that does not read them
    const q = parseHash("#/profile/overview?outliers=hide&first=skip&trend=adr&side=t&guns=rifle").query;
    expect(Object.fromEntries(q)).toEqual({ outliers: "hide", first: "skip", trend: "adr", side: "t" });
    expect(scopeQuery(q)).toEqual({ side: "t" });
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
