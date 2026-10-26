// Highlight classification (stats/highlights.ts highlightKinds) and the worker's highlight rows
// (views.ts addHighlightRows), on hand-built rounds: CT a and b against T c, d and e unless a test says otherwise.
import { describe, expect, it } from "vitest";
import { highlightKinds } from "../stats/highlights";
import { FREEZE_END, oneRound } from "../stats/testing/match";
import type { HighlightRow } from "./protocol";
import { addHighlightRows, newestHighlightFirst } from "./views";

const t = (s: number) => FREEZE_END + 64 * s;

describe("highlightKinds", () => {
  it("classifies by the round's enemy kills and a won clutch", () => {
    // fails if a 2K counts, the sizes shift by one, six kills are not an ace, or a won clutch is dropped or added
    expect([0, 1, 2, 3, 4, 5, 6].map((k) => highlightKinds(k, false))).toEqual([[], [], [], ["3k"], ["4k"], ["ace"], ["ace"]]);
    expect(highlightKinds(1, true)).toEqual(["clutch"]);
    expect(highlightKinds(3, true)).toEqual(["3k", "clutch"]);
  });

  it("refuses a kill count that is not a whole number", () => {
    expect(() => highlightKinds(-1, false)).toThrow(/whole number/);
    expect(() => highlightKinds(2.5, false)).toThrow(/whole number/);
  });
});

describe("addHighlightRows", () => {
  const rows = (f: ReturnType<typeof oneRound>, player: string[], file = "m") => { const out: HighlightRow[] = []; addHighlightRows(out, file, f, { player }); return out; };

  it("lists a 3K with its kills in order and leaves out a team kill and a 2K", () => {
    // fails if a team kill counts toward the multi-kill, the feed loses its order or flags, or b's 2K is listed
    const f = oneRound({
      players: { a: "CT", b: "CT", x: "CT", c: "T", d: "T", e: "T", g: "T" },
      kills: [
        { tick: t(1), killer: "a", victim: "c", at: { headshot: true } },
        { tick: t(2), killer: "a", victim: "x", at: { weapon: "glock" } },
        { tick: t(3), killer: "a", victim: "d", at: { weapon: "awp", noscope: true, attackerblind: true } },
        { tick: t(4), killer: "b", victim: "e" },
        { tick: t(5), killer: "b", victim: "g" },
      ],
    });
    // a's team kill on x leaves a two enemy kills: no highlight. Add a third.
    expect(rows(f, ["a", "b"])).toEqual([]);
    const g = oneRound({
      players: { a: "CT", b: "CT", c: "T", d: "T", e: "T" },
      kills: [
        { tick: t(1), killer: "a", victim: "c", at: { headshot: true } },
        { tick: t(3), killer: "a", victim: "d", at: { weapon: "awp", noscope: true, attackerblind: true } },
        { tick: t(4), killer: "a", victim: "e" },
      ],
    });
    const [r, ...more] = rows(g, ["a"]);
    expect(more).toEqual([]);
    expect([r.round, r.side, r.player, r.kinds, r.kills, r.clutch, r.won]).toEqual([1, "CT", "a", ["3k"], 3, null, true]);
    expect(r.feed.map((k) => [k.weapon, k.headshot, k.noscope, k.blind])).toEqual([["ak47", true, false, null], ["awp", false, true, true], ["ak47", false, false, null]]);
  });

  it("lists a won clutch with its enemies and kills, and not a lost one", () => {
    // fails if a lost clutch is a highlight, or the clutch loses its size or kills. c kills a: b wins a
    // 1v2 with two kills. In the second round b loses the same 1v2.
    const won = oneRound({
      players: { a: "CT", b: "CT", c: "T", d: "T" },
      kills: [{ tick: t(1), killer: "c", victim: "a" }, { tick: t(2), killer: "b", victim: "c" }, { tick: t(3), killer: "b", victim: "d" }],
    });
    expect(rows(won, ["b"]).map((r) => [r.kinds, r.kills, r.clutch])).toEqual([[["clutch"], 2, { opponents: 2, kills: 2 }]]);
    const lost = oneRound({
      players: { a: "CT", b: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T" },
      kills: [{ tick: t(1), killer: "c", victim: "a" }, { tick: t(2), killer: "b", victim: "c" }],
    });
    expect(rows(lost, ["b"])).toEqual([]);
  });

  it("keeps only the rounds the filter keeps", () => {
    // fails if the side filter is ignored: a's 3K is on CT
    const f = oneRound({
      players: { a: "CT", b: "CT", c: "T", d: "T", e: "T" },
      kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "d" }, { tick: t(3), killer: "a", victim: "e" }],
    });
    const out: HighlightRow[] = [];
    addHighlightRows(out, "m", f, { player: "a", sides: ["T"] });
    expect(out).toEqual([]);
  });

  it("orders newest match first, then the later round first", () => {
    // fails if the order ignores the match's start, or puts round 3 before round 9 of the same match
    const row = (file: string, start: number, round: number): HighlightRow => ({ file, round, start, side: "CT", player: "a", kinds: ["3k"], kills: 3, clutch: null, won: true, feed: [] });
    const sorted = [row("old", 1, 9), row("new", 2, 3), row("new", 2, 9)].sort(newestHighlightFirst);
    expect(sorted.map((r) => `${r.file}:${r.round}`)).toEqual(["new:9", "new:3", "old:9"]);
  });
});
