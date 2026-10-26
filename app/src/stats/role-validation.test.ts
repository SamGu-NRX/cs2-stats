import { expect, it } from "vitest";
import { assertUniqueSteamids, seededStratifiedSplit, teamGroupedSplit, type RoleSplitRow } from "./role-validation";

type Row = RoleSplitRow & { label: string };
const rows: Row[] = [
  { steamid: "1", team_clan_name: "A", label: "Entry" },
  { steamid: "2", team_clan_name: "A", label: "Lurker" },
  { steamid: "3", team_clan_name: "B", label: "Entry" },
  { steamid: "4", team_clan_name: "B", label: "Lurker" },
  { steamid: "5", team_clan_name: "C", label: "Entry" },
  { steamid: "6", team_clan_name: "C", label: "Lurker" },
  { steamid: "7", team_clan_name: "D", label: "Entry" },
  { steamid: "8", team_clan_name: "D", label: "Lurker" },
];

it("rejects duplicate steamids before splitting", () => {
  expect(() => assertUniqueSteamids([rows[0], rows[0]])).toThrow("one row per steamid");
});

it("keeps seeded stratified splits disjoint and reproducible", () => {
  const a = seededStratifiedSplit(rows, (row) => row.label, 0x5EED);
  const b = seededStratifiedSplit(rows, (row) => row.label, 0x5EED);
  expect(a).toEqual(b);
  const holdoutIds = new Set(a.holdout.map((row) => row.steamid));
  expect(a.train.filter((row) => holdoutIds.has(row.steamid))).toHaveLength(0);
  expect(new Set(a.train.map((row) => row.label))).toEqual(new Set(["Entry", "Lurker"]));
  expect(new Set(a.holdout.map((row) => row.label))).toEqual(new Set(["Entry", "Lurker"]));
});

it("keeps team-grouped holdout teams out of training", () => {
  const split = teamGroupedSplit(rows, (row) => row.label, 0xC0DE);
  const trainTeams = new Set(split.train.map((row) => row.team_clan_name));
  expect(split.holdout.every((row) => !trainTeams.has(row.team_clan_name))).toBe(true);
  expect(new Set(split.train.map((row) => row.label))).toEqual(new Set(["Entry", "Lurker"]));
});
