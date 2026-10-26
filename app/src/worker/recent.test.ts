// "Your match" compares a match with the player's most recent earlier matches (views.ts recentFiles).
import { expect, it } from "vitest";
import { recentFiles } from "./views";

it("takes the player's n most recent matches before this one, newest first", () => {
  // fails if a later match, a match without the player, or this match itself enters the reference
  const e = (file: string, startedAt: string, played: Record<string, number>) => ({ file, match: { startedAt, date: null }, played });
  const entries = [
    e("m1", "2026-10-01T10:00:00Z", { me: 20 }), e("m2", "2026-10-02T10:00:00Z", { other: 20 }), e("m3", "2026-10-03T10:00:00Z", { me: 20 }),
    e("m4", "2026-10-04T10:00:00Z", { me: 20 }), e("m5", "2026-10-05T10:00:00Z", { me: 20 }),
  ];
  expect(recentFiles(entries, "m4", "me", 2)).toEqual(["m3", "m1"]);
  expect(recentFiles(entries, "m4", "me", 10)).toEqual(["m3", "m1"]);
});

it("skips a match the player is listed in but played no round of", () => {
  // fails if a match where the player has no player-round (every round off the roster) takes a slot:
  // m3 lists "me" with 0 rounds, so the two most recent are m2 and m1
  const e = (file: string, startedAt: string, played: Record<string, number>) => ({ file, match: { startedAt, date: null }, played });
  const entries = [e("m1", "2026-10-01T10:00:00Z", { me: 20 }), e("m2", "2026-10-02T10:00:00Z", { me: 20 }), e("m3", "2026-10-03T10:00:00Z", { me: 0 }), e("m4", "2026-10-04T10:00:00Z", { me: 20 })];
  expect(recentFiles(entries, "m4", "me", 2)).toEqual(["m2", "m1"]);
});
