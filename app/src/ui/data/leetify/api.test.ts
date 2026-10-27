import { describe, expect, it } from "vitest";
import { LeetifyShapeError, parseMatches, parsePayload, parseProfile } from "./api";
import { SYNTHETIC_STEAM64, syntheticCode, syntheticMatch, syntheticPayload, syntheticProfile } from "./synthetic";

const match = (over: Partial<Parameters<typeof syntheticMatch>[0]> = {}) =>
  syntheticMatch({ id: "m1", finished: "2026-10-20T20:00:00.000Z", map: "de_mirage", sourceId: syntheticCode(1), won: 13, lost: 9, kills: 20, deaths: 15, rating: 0.05, ...over });

describe("reading Leetify's replies", () => {
  it("reads the documented profile and match shapes, on the API's own scales", () => {
    const d = parsePayload(syntheticPayload(1000));
    expect(d.profile).toMatchObject({ name: "Synthetic player", steam64: SYNTHETIC_STEAM64, leetifyRating: 1.84, totalMatches: 214 });
    expect(d.profile.url).toBe(`https://leetify.com/app/profile/${SYNTHETIC_STEAM64}`);
    expect(d.profile.rating.aim).toBe(62.4);
    expect(d.profile.stats.reaction_time_ms).toBe(612.4);
    expect(d.matches[0]).toMatchObject({ map: "de_dust2", dataSource: "matchmaking", score: { us: 13, them: 8 } });
    expect(d.matches[0].me.leetify_rating).toBe(0.0412);
    // newest first
    expect(d.matches.map((m) => m.finishedMs)).toEqual([...d.matches.map((m) => m.finishedMs)].sort((a, b) => b - a));
  });

  it("fails loudly, naming the field, when a field has the wrong type", () => {
    // fails if a changed API turns into wrong numbers instead of an error
    expect(() => parseProfile(syntheticProfile({ rating: { aim: "62" } }))).toThrow(/profile\.rating\.aim/);
    expect(() => parseProfile(syntheticProfile({ steam64_id: undefined }))).toThrow(LeetifyShapeError);
    expect(() => parseProfile([])).toThrow(/not an object/);
    const bad = match();
    (bad.stats as Record<string, unknown>[])[0].total_kills = "20";
    expect(() => parseMatches([bad], SYNTHETIC_STEAM64)).toThrow(/matches\[0\]\.stats\[0\]\.total_kills/);
    expect(() => parseMatches([{ ...match(), finished_at: "yesterday" }], SYNTHETIC_STEAM64)).toThrow(/finished_at/);
    expect(() => parseMatches({}, SYNTHETIC_STEAM64)).toThrow(/not a list/);
  });

  it("reads an absent or null field as no value, as the spec allows", () => {
    const p = parseProfile(syntheticProfile({ rating: undefined, stats: { preaim: null }, ranks: null, id: null }));
    expect(p.rating.aim).toBeNull();
    expect(p.stats.preaim).toBeNull();
    expect([p.leetifyRating, p.id]).toEqual([null, null]);
    const m = match();
    delete (m.stats as Record<string, unknown>[])[0].rounds_won;
    expect(parseMatches([m], SYNTHETIC_STEAM64).matches[0].score).toBeNull();
  });

  it("leaves out a match without the player's row, and counts it", () => {
    const r = parseMatches([match(), match({ id: "m2", steam64: "76561197960265729" })], SYNTHETIC_STEAM64);
    expect(r.matches.map((m) => m.id)).toEqual(["m1"]);
    expect(r.skipped).toBe(1);
  });
});
