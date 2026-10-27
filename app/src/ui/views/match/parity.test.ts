import { describe, expect, it } from "vitest";
import type { HeadToHead, ZoneRow } from "../../../stats/matchviews";
import { FEATURES, rating3Of } from "../../../stats/rating3";
import { at } from "../../../stats/testing/summary";
import { METRIC } from "../../../stats/metrics";
import { fmtPct, fmtRating } from "../../lib/format";
import {
  contributions, measureOf, mostFought, orient, ratingDomain, ratingOrder, ratingSteps, relChange,
  signedIn, situationGrid, takeHoldGap, weaponsByKills, YOUR_MATCH, zonesFor,
} from "./parity";

describe("rating terms", () => {
  it("rejects an input the breakdown has no name for", () => {
    expect(() => ratingOrder(["eKPR"])).toThrow(/eKPR/);
  });

  it("lists the engine's own contributions in the engine's input order", () => {
    const order = ratingOrder([...FEATURES].reverse());
    const parts = contributions(order, { kpr_eco: 1.3, adr_eco: 0.9, dpr_eco: -0.35, kast_eco: 0.3, mk: 0.2, swing: -0.2 });
    expect(parts.map((p) => p.input)).toEqual([...FEATURES].reverse());
    expect(parts.map((p) => p.value)).toEqual([-0.2, 0.2, 0.3, -0.35, 0.9, 1.3]);
  });

  it("adds back up to the engine's own rating", () => {
    const r = rating3Of(at({ kpr_eco: 0.866, adr_eco: 86.4, dpr_eco: 0.636, kast_eco: 78.7, mk: 20.8, swing: 3.0 }));
    const { total } = ratingSteps(r.base!, contributions(ratingOrder(FEATURES), r.terms!));
    expect(total).toBeCloseTo(r.value!, 12);
  });

  it("runs the waterfall from the intercept and ends at intercept plus every term", () => {
    const { steps, total } = ratingSteps(0.49, [{ input: "kpr_eco", value: 0.4 }, { input: "dpr_eco", value: -0.3 }]);
    expect(steps.map((s) => s.label)).toEqual(["Base", "Kills", "Deaths"]);
    [[0, 0.49], [0.49, 0.89], [0.89, 0.59]].forEach(([from, to], i) => {
      expect(steps[i].from).toBeCloseTo(from, 12);
      expect(steps[i].to).toBeCloseTo(to, 12);
    });
    expect(total).toBeCloseTo(0.59, 12);
  });
});

describe("ratingDomain", () => {
  it("holds every value, every reference and zero, with 8% of the span either side", () => {
    const [lo, hi] = ratingDomain([2, -0.5, null], [1.4, null, 1]);
    expect(lo).toBeCloseTo(-0.7, 12);
    expect(hi).toBeCloseTo(2.2, 12);
    expect(ratingDomain([0.5], [0.8])[0]).toBeCloseTo(-0.064, 12);
  });

  it("keeps a span when every value is the same", () => {
    const [lo, hi] = ratingDomain([0], [0]);
    expect(hi - lo).toBeCloseTo(0.16, 12);
  });
});

describe("signedIn", () => {
  it("puts a plus or a true minus before the formatted size", () => {
    expect(signedIn(fmtRating, 0.381)).toBe("+0.38");
    expect(signedIn(fmtRating, -1.736)).toBe("−1.74");
    expect(signedIn((x) => fmtPct(x), 4.8)).toBe("+4.8%");
  });

  it("gives no sign to a change that formats as zero", () => {
    expect(signedIn(fmtRating, -0.001)).toBe("0.00");
  });
});

describe("your match", () => {
  it("lists only metrics the engine has, each once", () => {
    const ids = YOUR_MATCH.flatMap((g) => g.ids);
    expect(ids.filter((id) => !METRIC[id])).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("relChange", () => {
  it("is the change as a share of the reference's size", () => {
    expect(relChange(1.5, 1)).toBe(0.5);
    expect(relChange(-0.5, -1)).toBe(0.5);
  });

  it("is null without both values or with a zero reference", () => {
    expect(relChange(null, 1)).toBeNull();
    expect(relChange(1, null)).toBeNull();
    expect(relChange(25, 0)).toBeNull();
  });
});

const pair = (a: string, b: string, kills: [number, number], damage: [number, number], extra: Partial<HeadToHead> = {}): HeadToHead => ({
  a, b, kills, damage, weapons: [{}, {}], flashes: [{ count: 0, secs: 0 }, { count: 0, secs: 0 }], openings: [0, 0], ...extra,
});

describe("head to head", () => {
  const rows = [
    pair("me", "x", [3, 1], [300, 120], { openings: [1, 0], flashes: [{ count: 2, secs: 4 }, { count: 0, secs: 0 }], weapons: [{ rifle: 2, pistol: 1 }, { smg: 1 }] }),
    pair("y", "me", [2, 2], [200, 250]),
  ];

  it("turns a pair so the asked player comes first", () => {
    const o = orient(rows, "me", "y")!;
    expect(o.kills).toEqual([2, 2]);
    expect(o.damage).toEqual([250, 200]);
    expect(orient(rows, "x", "me")!.weapons).toEqual([{ smg: 1 }, { rifle: 2, pistol: 1 }]);
  });

  it("finds nothing for two players who are not an enemy pair", () => {
    expect(orient(rows, "x", "y")).toBeNull();
  });

  it("reads blinds as their count", () => {
    expect(measureOf(orient(rows, "me", "x")!, "flashes")).toEqual([2, 0]);
    expect(measureOf(orient(rows, "me", "x")!, "openings")).toEqual([1, 0]);
  });

  it("picks the most fought opponent by kills both ways, then damage", () => {
    // x and y both have 4 kills between them and me; y has more damage (450 against 420)
    expect(mostFought(rows, "me", ["x", "y"])).toBe("y");
    expect(mostFought(rows, "me", ["x"])).toBe("x");
    expect(mostFought(rows, "me", ["z"])).toBeNull();
  });

  it("keeps the first opponent on a full tie", () => {
    const tie = [pair("me", "p", [1, 1], [100, 100]), pair("me", "q", [1, 1], [100, 100])];
    expect(mostFought(tie, "me", ["q", "p"])).toBe("q");
  });

  it("lists weapon classes by kills, ties in the fixed class order", () => {
    expect(weaponsByKills({ pistol: 1, sniper: 1, rifle: 3, knife: 0 })).toEqual([["rifle", 3], ["sniper", 1], ["pistol", 1]]);
  });
});

const zone = (z: string, side: "T" | "CT", kills: number, deaths: number): ZoneRow => ({
  zone: z, side, kills, deaths, kd: deaths ? kills / deaths : null,
  killsAt: Array.from({ length: kills }, (_, i): [number, number] => [i, 0]), deathsAt: Array.from({ length: deaths }, (_, i): [number, number] => [0, i]),
});

describe("zonesFor", () => {
  const rows = [zone("BombsiteB", "CT", 4, 4), zone("BombsiteB", "T", 1, 1), zone("TopofMid", "T", 3, 1), zone("LongA", "CT", 0, 2), zone("LongA", "T", 0, 2)];

  it("merges a zone's two sides and keeps the split", () => {
    const b = zonesFor(rows, "both").find((z) => z.zone === "BombsiteB")!;
    expect([b.kills, b.deaths, b.killsAt.length, b.deathsAt.length]).toEqual([5, 5, 5, 5]);
    expect(b.bySide).toEqual({ CT: { kills: 4, deaths: 4 }, T: { kills: 1, deaths: 1 } });
  });

  it("keeps one side's rows only", () => {
    expect(zonesFor(rows, "ct").map((z) => [z.zone, z.kills, z.deaths])).toEqual([["BombsiteB", 4, 4], ["LongA", 0, 2]]);
  });

  it("sorts by kills plus deaths, then kills, then name", () => {
    // TopofMid 4 (3 kills) and LongA 4 (0 kills) tie on fights; kills break it
    expect(zonesFor(rows, "both").map((z) => z.zone)).toEqual(["BombsiteB", "TopofMid", "LongA"]);
    expect(zonesFor([zone("Pit", "T", 1, 0), zone("Hole", "T", 1, 0)], "t").map((z) => z.zone)).toEqual(["Hole", "Pit"]);
  });
});

describe("situationGrid", () => {
  it("places your count down the rows and theirs across, largest first, and leaves unreached states empty", () => {
    const g = situationGrid({ "5v5": { rounds: 24, won: 11 }, "4v5": { rounds: 15, won: 5 }, "5v4": { rounds: 9, won: 6 }, "1v1": { rounds: 4, won: 4 } });
    expect(g.size).toBe(5);
    expect(g.cells[0][0]).toEqual({ us: 5, them: 5, rounds: 24, won: 11 });
    expect(g.cells[1][0]).toEqual({ us: 4, them: 5, rounds: 15, won: 5 });
    expect(g.cells[0][1]).toEqual({ us: 5, them: 4, rounds: 9, won: 6 });
    expect(g.cells[4][4]).toEqual({ us: 1, them: 1, rounds: 4, won: 4 });
    expect(g.cells[2][3]).toBeNull();
  });

  it("sizes the grid to the largest count, so a wingman match is 2 by 2", () => {
    const g = situationGrid({ "2v2": { rounds: 3, won: 1 }, "1v2": { rounds: 1, won: 0 } });
    expect(g.size).toBe(2);
    expect(g.cells[1][0]).toEqual({ us: 1, them: 2, rounds: 1, won: 0 });
  });

  it("is empty without states and throws on a key that is not a state", () => {
    expect(situationGrid({}).size).toBe(0);
    expect(() => situationGrid({ "5-4": { rounds: 1, won: 1 } })).toThrow(/5-4/);
  });
});

describe("takeHoldGap", () => {
  it("says nothing when every round was read", () => {
    expect(takeHoldGap({ rounds: 24, known: 24, missing: [] })).toBeNull();
  });

  it("names the missing inputs when no round could be read", () => {
    expect(takeHoldGap({ rounds: 24, known: 0, missing: ["positions"] })).toBe("Take and hold could not be read: this file has no positions.");
    expect(takeHoldGap({ rounds: 10, known: 0, missing: ["site names", "freeze time"] })).toBe("Take and hold could not be read: this file has no site names and freeze time.");
  });

  it("counts the rounds read when only some were", () => {
    expect(takeHoldGap({ rounds: 24, known: 20, missing: ["freeze time"] })).toBe("Take and hold read 20 of 24 rounds; the rest lack freeze time.");
  });
});
