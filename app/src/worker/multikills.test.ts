// Multi-kill rows through the worker's row builder (views.ts addMultiKillRows), on a hand-built round.
import { expect, it } from "vitest";
import { FREEZE_END, oneRound } from "../stats/testing/match";
import type { MultiKillRow } from "./protocol";
import { addMultiKillRows } from "./views";

it("lists each round where a kept player got two or more kills", () => {
  // fails if a one-kill round is listed, the kill count is wrong, or the filter's player is ignored
  const t = (s: number) => FREEZE_END + 64 * s;
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "T", d: "T", e: "T" },
    kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "d" }, { tick: t(3), killer: "b", victim: "e" }],
  });
  const rows = (player: string[]) => { const out: MultiKillRow[] = []; addMultiKillRows(out, "m", f, { player }); return out; };
  expect(rows(["a", "b"])).toEqual([{ file: "m", round: 1, side: "CT", player: "a", kills: 2, won: true }]);
  expect(rows(["b"])).toEqual([]);
});
