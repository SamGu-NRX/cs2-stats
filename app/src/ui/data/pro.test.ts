import { describe, expect, it } from "vitest";
import type { MatchEntry } from "./match";
import { filterPro, proChoices } from "./pro";

/** A pro demo with the fields the Pro view reads: teams, map, start, players and who played. */
const demo = (file: string, teams: [string, string], map: string, startedAt: string, players: string[], coach?: string): MatchEntry => ({
  file,
  match: { teams, map, startedAt, date: startedAt.slice(0, 10) },
  players: [...players, ...(coach ? [coach] : [])].map((name, i) => ({ id: `${file}:${i}`, name, team: i < 5 ? 0 : 1, bot: false })),
  played: players.map((_, i) => `${file}:${i}`),
}) as unknown as MatchEntry;

const lineup = (tag: string) => [1, 2, 3, 4, 5].map((n) => `${tag}${n}`);
const LIB = [
  demo("pro/a/m1", ["Vitality", "MOUZ"], "de_mirage", "2026-10-01T18:00:00Z", [...lineup("vit"), ...lineup("mz")], "Coach|xtqzzz"),
  demo("pro/a/m2", ["Vitality", "MOUZ"], "de_inferno", "2026-10-01T19:00:00Z", [...lineup("vit"), ...lineup("mz")]),
  demo("pro/b/m1", ["FaZe", "Spirit"], "de_mirage", "2026-10-05T12:00:00Z", [...lineup("fz"), ...lineup("sp")]),
];
const files = (xs: MatchEntry[]) => xs.map((e) => e.file);
const none = { q: "", team: null, player: null, map: null };

describe("the Pro view's filters", () => {
  it("keep only the matches with that team, player and map, newest first", () => {
    // fails if a filter keeps a match without its team, player or map, or the list leaves date order
    expect(files(filterPro(LIB, none))).toEqual(["pro/b/m1", "pro/a/m2", "pro/a/m1"]);
    expect(files(filterPro(LIB, { ...none, team: "MOUZ" }))).toEqual(["pro/a/m2", "pro/a/m1"]);
    expect(files(filterPro(LIB, { ...none, map: "de_mirage" }))).toEqual(["pro/b/m1", "pro/a/m1"]);
    expect(files(filterPro(LIB, { ...none, player: "SP3" }))).toEqual(["pro/b/m1"]);
    expect(files(filterPro(LIB, { ...none, team: "Vitality", map: "de_mirage" }))).toEqual(["pro/a/m1"]);
  });

  it("search every word across teams, players and the map, and never the coach", () => {
    // fails if a search word must match one field only, or a coach in the file counts as a player
    expect(files(filterPro(LIB, { ...none, q: "faze mirage" }))).toEqual(["pro/b/m1"]);
    expect(files(filterPro(LIB, { ...none, q: "vit3 inferno" }))).toEqual(["pro/a/m2"]);
    expect(filterPro(LIB, { ...none, q: "xtqzzz" })).toEqual([]);
    expect(proChoices(LIB).players.some(([p]) => p.includes("xtqzzz"))).toBe(false);
  });

  it("offer each team, player and map once, with how many maps it has", () => {
    // fails if a choice is listed twice or its count is not its maps
    const c = proChoices(LIB);
    expect(c.teams).toEqual([["FaZe", 1], ["MOUZ", 2], ["Spirit", 1], ["Vitality", 2]]);
    expect(c.maps).toEqual([["de_mirage", 2], ["de_inferno", 1]]);
    expect(c.players.find(([p]) => p === "vit1")).toEqual(["vit1", 2]);
  });
});
