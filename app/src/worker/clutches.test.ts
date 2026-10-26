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
