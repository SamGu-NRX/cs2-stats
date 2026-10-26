import { describe, expect, it } from "vitest";
import { matchHref, pageHref, parseHash } from "./router";

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
  it("opens an old ?sec= section link on the tab that now holds it", () => {
    // fails if a bookmark to the one-page Profile lands on the wrong tab
    const r = parseHash("#/profile?sec=identity");
    expect([r.ptab, r.query.get("sec")]).toEqual(["playstyle", "identity"]);
    expect(parseHash("#/profile?sec=howgood").ptab).toBe("duels");
    expect(parseHash("#/profile?sec=firepower").ptab).toBe("overview");
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
