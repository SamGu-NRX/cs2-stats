// A Valve match shows on the day it was played where the user is, not on its UTC day.
import { afterAll, beforeAll, expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { CS2RB } from "../../stats/model-params";
import { oneRoundTables } from "../../stats/testing/match";

const before = process.env.TZ;
beforeAll(() => { process.env.TZ = "America/Chicago"; });
afterAll(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });

const played = (extra: Record<string, string>) => {
  const t = oneRoundTables({ players: { 1: "CT", 2: "T" } });
  return derive({ ...t, match: { ...t.match, source: ["valve"], extra: [JSON.stringify(extra)] } }, CS2RB).match;
};

it("puts a match played at 03:19 UTC on July 19 on July 18 in Chicago", async () => {
  // fails if the importer writes no started_at: the list then shows the UTC day (review of #29)
  const { fmtMatchDay, matchDayKey } = await import("./format"); // after TZ is set: its formatters read it
  const at = "2026-07-19T03:19:10+00:00";
  const m = played({ date: at, started_at: at, date_source: "dem.info" });
  expect([matchDayKey(m), fmtMatchDay(m)]).toEqual(["2026-07-18", expect.stringMatching(/Jul 18/)]);
  // what importer version 2 wrote, a date alone, gives the UTC day
  expect(matchDayKey(played({ date: at, date_source: "dem.info" }))).toBe("2026-07-19");
});
