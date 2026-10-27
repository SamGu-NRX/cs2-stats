// The player against the opponents they faced: which matches count for each opponent, the share of
// opponents beaten per metric, and an attribute's score from those shares.
import { describe, expect, it } from "vitest";
import { emptySummary } from "./rollup";
import { vsOpponents, vsOpponentsOf, type VsOpponents } from "./opponents";
import { opponentScore } from "./opponent-score";
import { FREEZE_END, oneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;
const deaths = (rounds: number, d: number) => { const x = emptySummary(); x.m.rounds = rounds; x.m.deaths = d; return x; };
const row = (id: string, pct: number | null): VsOpponents => ({ id, mine: null, opponents: null, rank: null, of: 1, pct });

describe("vsOpponents", () => {
  it("rolls an opponent up over only the matches they faced the player in", () => {
    // fails if c's match as a's teammate counts: in m1 c is a's opponent and dies to a (0 kills, 1
    // death in 1 round); in m2 c is on a's team and kills d. Over m1 alone c has KPR 0 and DPR 1;
    // with m2 it would be 0.5 and 0.5. d, an opponent only in m2, has DPR 1 there
    const m1 = oneRound({ players: { a: "CT", c: "T" }, kills: [{ tick: t(5), killer: "a", victim: "c" }] });
    const m2 = oneRound({ players: { a: "CT", c: "CT", d: "T" }, kills: [{ tick: t(5), killer: "c", victim: "d" }] });
    const r = Object.fromEntries(vsOpponents([m1, m2], { player: "a" }).map((x) => [x.id, x]));
    expect(r.kpr).toMatchObject({ mine: 0.5, opponents: 0, of: 3 });
    expect(r.dpr).toMatchObject({ mine: 0, opponents: 1, rank: 1, pct: 100 });
  });
});

describe("vsOpponentsOf", () => {
  it("counts a tie with an opponent as half beaten, lower-is-better turned around", () => {
    // fails if a tie counts as a win or a loss, or fewer deaths counts as worse: DPR 0.4 against 0.6
    // (beaten), 0.4 (tie) and 0.2 (better): 1.5 of 3 = 50, second of four
    const r = Object.fromEntries(vsOpponentsOf(deaths(10, 4), [deaths(10, 6), deaths(10, 4), deaths(10, 2)]).map((x) => [x.id, x]));
    expect(r.dpr).toMatchObject({ rank: 2, of: 4, pct: 50 });
    expect(r.dpr.opponents).toBeCloseTo(0.4, 9);
  });

  it("gives no share without opponents, or for an identity metric", () => {
    // fails if an empty field reads as 0% beaten or a style metric gets a share
    const r = Object.fromEntries(vsOpponentsOf(deaths(10, 4), []).map((x) => [x.id, x]));
    expect([r.dpr.pct, r.dpr.rank, r.dpr.of]).toEqual([null, 1, 1]);
    const s = Object.fromEntries(vsOpponentsOf(deaths(10, 4), [deaths(10, 6)]).map((x) => [x.id, x]));
    expect(s.openingAttempts.pct).toBeNull();
  });
});

describe("opponentScore", () => {
  it("averages the metrics' shares beaten, skipping metrics without one", () => {
    // fails if a missing share counts as 0 or the mean takes metrics outside the attribute
    const rows = [row("kpr", 80), row("adr", 40), row("dpr", null), row("kast", 0)];
    expect(opponentScore(rows, ["kpr", "adr", "dpr"])).toBe(60);
    expect(opponentScore(rows, ["dpr"])).toBeNull();
  });

  it("refuses a metric the answer has no row for", () => {
    expect(() => opponentScore([row("kpr", 80)], ["kpr", "nope"])).toThrow(/no row for metric "nope"/);
  });
});
