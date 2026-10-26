import { expect, it } from "vitest";
import type { RoleMetric } from "../../../stats/identity";
import { addDays, evidenceScale, fmtRoleValue, niceCeil, periodPair, RECORD_LEAD, recordsOf, splitEvidence } from "./career-logic";

it("moves a day across month and year ends", () => {
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addDays("2026-10-25", -29)).toBe("2026-09-26");
});

it("pairs each period with the same stretch before it, anchored on the last day played", () => {
  // fails if a window is off by a day, anchors on today, or compares against a stretch with no match
  const days = ["2026-10-25", "2026-10-24", "2026-10-24", "2026-10-17", null, "2026-09-20"];
  expect(periodPair(days, "week")).toEqual({ kind: "week", current: { from: "2026-10-19", to: "2026-10-25" }, previous: { from: "2026-10-12", to: "2026-10-18" }, now: 3, before: 1 });
  expect(periodPair(days, "month")).toEqual({ kind: "month", current: { from: "2026-09-26", to: "2026-10-25" }, previous: { from: "2026-08-27", to: "2026-09-25" }, now: 4, before: 1 });
  // the last day played against the day played before it, not the calendar day before
  expect(periodPair(["2026-10-25", "2026-10-20"], "day")).toEqual({ kind: "day", current: { from: "2026-10-25", to: "2026-10-25" }, previous: { from: "2026-10-20", to: "2026-10-20" }, now: 1, before: 1 });
  expect(periodPair(["2026-10-25", "2026-10-24"], "week")).toBeNull();
  expect(periodPair(["2026-10-25"], "day")).toBeNull();
  expect(periodPair([null], "week")).toBeNull();
});

it("writes each role measure in its unit, distances in metres", () => {
  expect(fmtRoleValue(18.4, "pct")).toBe("18%");
  expect(fmtRoleValue(26.6, "secs")).toBe("27 s");
  expect(fmtRoleValue(1100, "units")).toBe("28 m");
  expect(fmtRoleValue(1.24, "perRound")).toBe("1.2");
  expect(fmtRoleValue(3.4, "count")).toBe("3");
  expect(fmtRoleValue(null, "pct")).toBe("–");
});

it("scales an evidence track to a clean maximum that fits the pros, the tick and both sides", () => {
  // fails if a value or the threshold falls off the track, or a share's track runs past 100%
  expect([0.3, 1, 1.2, 2.4, 2.6, 4.1, 7, 40, 881].map(niceCeil)).toEqual([0.5, 1, 2, 2.5, 5, 5, 10, 50, 1000]);
  const opening = evidenceScale([18, 22], [5.6, 33.3], 25, "pct");
  expect(opening.max).toBe(50);
  expect(opening.tick).toBe(50);
  expect(opening.band![0]).toBeCloseTo(11.2, 9);
  expect(opening.band![1]).toBeCloseTo(66.6, 9);
  expect(opening.at(18)).toBe(36);
  expect(evidenceScale([95, null], [20, 60], 45, "pct").max).toBe(100);
  // team distance's hand-set tick sits above the pros' range: the track still reaches it
  const dist = evidenceScale([600, 700], [374.8, 881.3], 1100, "units");
  expect(dist.max).toBe(2000);
  expect(dist.tick).toBe(55);
  expect(evidenceScale([null, null], null, null, "count")).toMatchObject({ max: 1, band: null, tick: null });
});

const rm = (id: string, value: number | null): RoleMetric => ({ id, label: id, value, unit: "pct", proRange: null, threshold: null, tip: "" });

it("keeps an evidence row when either side measured it, and names the ones neither did", () => {
  const { rows, missing } = splitEvidence([rm("a", 10), rm("b", null), rm("c", null)], [rm("a", 12), rm("b", 3), rm("c", null)]);
  expect(rows.map((r) => [r.id, r.t?.value ?? null, r.ct?.value ?? null])).toEqual([["a", 10, 12], ["b", null, 3]]);
  expect(missing.map((m) => m.id)).toEqual(["c"]);
});

it("leads the records with the chosen bests in order and lists the rest by id", () => {
  const bests = ["utilDmg", "kills", "adr", "assists", "rating3"].map((id) => ({ id }));
  const { lead, rest } = recordsOf(bests);
  expect(lead.map((b) => b.id)).toEqual(RECORD_LEAD.filter((id) => ["kills", "adr", "rating3"].includes(id)));
  expect(lead.map((b) => b.id)).toEqual(["rating3", "kills", "adr"]);
  expect(rest.map((b) => b.id)).toEqual(["assists", "utilDmg"]);
});
