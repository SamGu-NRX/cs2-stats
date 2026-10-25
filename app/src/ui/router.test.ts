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
