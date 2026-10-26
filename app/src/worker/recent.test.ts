// "Your match" compares a match with the player's most recent earlier matches (views.ts recentFiles).
import { expect, it } from "vitest";
import { recentFiles } from "./views";

it("takes the player's n most recent matches before this one, newest first", () => {
  // fails if a later match, a match without the player, or this match itself enters the reference
  const e = (file: string, startedAt: string, ids: string[]) => ({ file, match: { startedAt, date: null }, players: ids.map((id) => ({ id })) });
  const entries = [
    e("m1", "2026-10-01T10:00:00Z", ["me"]), e("m2", "2026-10-02T10:00:00Z", ["other"]), e("m3", "2026-10-03T10:00:00Z", ["me"]),
    e("m4", "2026-10-04T10:00:00Z", ["me"]), e("m5", "2026-10-05T10:00:00Z", ["me"]),
  ];
  expect(recentFiles(entries, "m4", "me", 2)).toEqual(["m3", "m1"]);
  expect(recentFiles(entries, "m4", "me", 10)).toEqual(["m3", "m1"]);
});
