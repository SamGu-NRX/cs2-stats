// The career views (career.ts) on hand-set percentiles and summaries.
import { describe, expect, it } from "vitest";
import { addBests, awardsOf, careerRatings, compositeOf, focusAreas, groupSessions, metricDeltas, topStats, type Best } from "./career";
import type { Percentile } from "./compare";
import { rating3Of } from "./rating3";
import { emptySummary } from "./rollup";
import { at } from "./testing/summary";

const pctOf = (xs: Record<string, number | null>): Record<string, Percentile> =>
  Object.fromEntries(Object.entries(xs).map(([id, pct]) => [id, { id, value: 1, pct, pool: "all", reason: null, n: null }]));
const summary = (m: Record<string, number>) => { const s = emptySummary(); Object.assign(s.m, m); return s; };

describe("0-100 ratings", () => {
  it("averages the inputs' percentiles by weight, inverting where more is worse, and needs every input", () => {
    // fails if a weight, the inversion or the all-inputs rule changes: 80 and an inverted 60 (so 40) make 60
    const p = pctOf({ a: 80, b: 60 });
    expect(compositeOf([{ id: "a", weight: 1 }, { id: "b", weight: 1, invert: true }], p).score).toBe(60);
    expect(compositeOf([{ id: "a", weight: 3 }, { id: "b", weight: 1 }], p).score).toBe(75);
    expect(compositeOf([{ id: "a", weight: 1 }, { id: "c", weight: 1 }], p)).toMatchObject({ score: null, missing: ["c"] });
  });

  it("makes Utility Rating the mean of quantity and quality", () => {
    // fails if the sub-ratings are not combined equally: quantity 40 (four inputs at 40), quality 80 (six at
    // 80 and teammates flashed at 20, inverted to 80) make 60
    const p = pctOf({
      flashesPR: 40, smokesPR: 40, hesPR: 40, molotovsPR: 40,
      flashKillsPerFlash: 80, enemiesPerFlash: 80, blindPerFlash: 80, dmgPerHe: 80, molotovDmg: 80, utilUnused: 80, teamFlashPR: 20,
    });
    const r = careerRatings(p);
    expect([r.utilityQuantity.score, r.utilityQuality.score, r.utilityRating, r.aimRating.score]).toEqual([40, 80, 60, null]);
  });
});

describe("comparing two summaries", () => {
  it("gives each metric's delta and which way is better", () => {
    // fails if lowerIsBetter is ignored or identity metrics get better and worse
    const rows = Object.fromEntries(metricDeltas(summary({ rounds: 10, kills: 10, deaths: 2, openingKills: 4 }), summary({ rounds: 10, kills: 5, deaths: 5, openingKills: 2 })).map((r) => [r.id, r.direction]));
    expect([rows.kpr, rows.dpr, rows.openingAttempts]).toEqual(["better", "better", "higher"]);
  });
});

describe("personal bests", () => {
  it("keeps the best count from any match, and the best rate only from a match long enough", () => {
    // fails if a short match sets a rate best, or lower-is-better is ignored: m2 has the most kills (27)
    // and kills a round (0.9);
    // m1 the lowest deaths per round (10 / 24); the 5-round m3's 2 kills a round is too short to count
    const acc: Record<string, Best> = {};
    addBests(acc, "m1", summary({ rounds: 24, kills: 20, deaths: 10 }));
    addBests(acc, "m2", summary({ rounds: 30, kills: 27, deaths: 20 }));
    addBests(acc, "m3", summary({ rounds: 5, kills: 10, deaths: 1 }));
    expect([acc.kills, acc.dpr].map((b) => [b.file, b.value])).toEqual([["m2", 27], ["m1", 10 / 24]]);
    expect(acc.kpr.file).toBe("m2");
  });

  it("sets no best from a match that did not record the count's or the metric's input", () => {
    // fails if a missing input reads as zero or as a value over some rows: m1 recorded no grenades or
    // flashes (a plugin file without them), so its 0 enemies flashed is no best; its AWP duels are 1
    // of 1 won, but the weapon in hand is known for neither of its 2 deaths, so its 100% is no best.
    // m2 recorded both: 3 enemies flashed, 1 of 2 AWP duels won (50%)
    const acc: Record<string, Best> = {};
    addBests(acc, "m1", summary({ rounds: 12, enemiesFlashed: 0, awpDuels: 1, awpDuelWins: 1, deathsHandKnown: 0, deathsHandTotal: 2 }));
    expect([acc.enemiesFlashed, acc.utilDmg, acc.awpDuelWin, acc.kills.value]).toEqual([undefined, undefined, undefined, 0]);
    addBests(acc, "m2", summary({ rounds: 12, utilityRounds: 12, enemiesFlashed: 3, awpDuels: 2, awpDuelWins: 1, deathsHandKnown: 2, deathsHandTotal: 2 }));
    expect([acc.enemiesFlashed, acc.awpDuelWin].map((b) => [b.file, b.value])).toEqual([["m2", 3], ["m2", 50]]);
    // a match with grenades and flashes recorded for 11 of its 12 rounds is not known in full: its 5 is no best
    addBests(acc, "m3", summary({ rounds: 12, utilityRounds: 11, enemiesFlashed: 5 }));
    expect(acc.enemiesFlashed.file).toBe("m2");
  });

  it("keeps the rating's best when only its percentile input, the duel loadouts, is short", () => {
    // fails if the eco input, which gates only the percentile, blocks a best: none of the match's 4
    // kills and deaths has both loadouts, yet its rating stands
    const s = at({ kpr_eco: 0.8, adr_eco: 80, dpr_eco: 0.6, kast_eco: 75, mk: 15, swing: 2 }, 12);
    Object.assign(s.m, { ecoEvents: 4, ecoEventsKnown: 0 });
    const acc: Record<string, Best> = {};
    addBests(acc, "m1", s);
    expect(acc.rating3).toEqual({ id: "rating3", value: rating3Of(s).value, file: "m1" });
    expect(rating3Of(s).value).not.toBeNull();
  });
});

describe("top stats and focus areas", () => {
  it("ranks the highest performance percentiles, and the weakest skills with a tip by their gap to 50", () => {
    // fails if identity metrics enter, the order flips, or a skill without a tip becomes a focus area
    const p = pctOf({ kpr: 90, adr: 70, openingAttempts: 99, counterStrafe: 10, crosshairPlacement: 30, swing: 5 });
    expect(topStats(p, 2).map((x) => x.id)).toEqual(["kpr", "adr"]);
    expect(focusAreas(p).map((x) => [x.id, x.gap])).toEqual([["counterStrafe", 40], ["crosshairPlacement", 20]]);
  });
});

describe("sessions", () => {
  it("starts a new session after a gap of 3 hours or more, and awards each session", () => {
    // fails if the gap is measured from a match's start instead of its end, or the cut moves: m1 ends at
    // 11:00 and m2 starts at 12:00 (one session); m3 starts at 16:00, 3 h after m2 ends (a new one)
    const h = (x: number) => x * 3_600_000;
    expect(groupSessions([{ file: "m3", start: h(16), end: h(17) }, { file: "m1", start: h(10), end: h(11) }, { file: "m2", start: h(12), end: h(13) }]))
      .toEqual([["m1", "m2"], ["m3"]]);
    expect(awardsOf([{ file: "m1", rating: 1.1, kills: 20 }, { file: "m2", rating: 1.3, kills: 18 }, { file: "m3", rating: null, kills: 20 }]))
      .toEqual({ bestMatch: { file: "m2", rating: 1.3 }, mostKills: { file: "m1", kills: 20 } });
  });
});
