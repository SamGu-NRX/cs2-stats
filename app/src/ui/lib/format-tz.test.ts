// A match's day and time in local time, under a fixed time zone. The test sets TZ before the
// formatters are created (vitest gives each file its own modules), so it holds wherever it runs, and
// puts TZ back for the files after it in the same process.
import { afterAll, beforeAll, expect, it } from "vitest";

let f: typeof import("./format");
const before = process.env.TZ;
beforeAll(async () => {
  process.env.TZ = "America/Chicago";
  f = await import("./format");
});
afterAll(() => {
  if (before === undefined) delete process.env.TZ;
  else process.env.TZ = before;
});

it("shows an evening match on its local day, not the UTC day", () => {
  // fails if 7:06 PM CDT on Oct 24 (00:06 UTC on Oct 25) shows as Oct 25, or the time is offset twice
  const m = { date: "2026-10-25", startedAt: "2026-10-25T00:06:42Z" };
  expect(f.fmtWhen(m)).toBe("Oct 24, 7:06 PM");
  expect(f.matchDayKey(m)).toBe("2026-10-24");
  expect(f.fmtWhen({ date: "2026-10-25", startedAt: null })).toBe("Oct 25");
});
