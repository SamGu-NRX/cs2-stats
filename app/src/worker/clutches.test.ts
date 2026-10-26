// Clutch rows through the worker's row builder (views.ts addClutchRows), on hand-built rounds: CT
// a and b against T c and d unless a test says otherwise.
import { expect, it } from "vitest";
import { FREEZE_END, oneRound } from "../stats/testing/match";
import type { ClutchRow } from "./protocol";
import { addClutchRows } from "./views";

const rows = (f: ReturnType<typeof oneRound>, player: string[]) => { const out: ClutchRow[] = []; addClutchRows(out, "m", f, { player }); return out; };
const t = (s: number) => FREEZE_END + 64 * s;

it("names the clutch player and counts their kills after the clutch started", () => {
  // fails if the row loses its player or counts kills from before the clutch. c kills a: b is in a
  // 1v2 and kills c and d (2 kills after). After b kills c, d is alone too: a 1v1 with no kills after
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "T", d: "T" },
    kills: [{ tick: t(1), killer: "c", victim: "a" }, { tick: t(2), killer: "b", victim: "c" }, { tick: t(3), killer: "b", victim: "d" }],
  });
  expect(rows(f, ["a", "b", "c", "d"]).map((r) => [r.player, r.opponents, r.won, r.kills])).toEqual([["b", 2, true, 2], ["d", 1, false, 0]]);
  expect(rows(f, ["d"]).map((r) => r.player)).toEqual(["d"]);
});

it("counts a side that starts the round with one player as a clutch before any kill", () => {
  // fails if the alive counts are read only after a death: a starts alone against c and d. Dying
  // first is still a lost 1v2; winning it is a won 1v2 with two kills, not a 1v1 that starts later
  const lost = oneRound({ players: { a: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T" }, kills: [{ tick: t(1), killer: "c", victim: "a" }] });
  expect(rows(lost, ["a"]).map((r) => [r.player, r.opponents, r.won, r.kills])).toEqual([["a", 2, false, 0]]);
  const won = oneRound({ players: { a: "CT", c: "T", d: "T" }, kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "d" }] });
  expect(rows(won, ["a"]).map((r) => [r.player, r.opponents, r.won, r.kills])).toEqual([["a", 2, true, 2]]);
});

it("reads the alive counts before any death only from a freeze-end roster", () => {
  // fails if a live-recorded round's rows, read at its end after b joined T mid-round, are taken for
  // the round-start roster: there a's clutch starts with the first death (a 1v1 with one kill after),
  // while the same rows read at freeze end make a 1v2 from the start with both kills
  const round = (freezeEnd: number | null) => oneRound({
    players: { a: "CT", c: "T", b: "T" }, roundRow: { freeze_end_tick: freezeEnd },
    kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "b" }],
  });
  expect(rows(round(null), ["a"]).map((r) => [r.opponents, r.won, r.kills])).toEqual([[1, true, 1]]);
  expect(rows(round(FREEZE_END), ["a"]).map((r) => [r.opponents, r.won, r.kills])).toEqual([[2, true, 2]]);
});
