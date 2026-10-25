// HLTV's one-decimal display, which the HLTV comparisons round the engine's values with.
import { expect, it } from "vitest";
import { hltvRound1 } from "../../tools/hltv";

it("rounds halves to the even digit and everything else to the nearest", () => {
  // fails if 13 of 16 KAST rounds (81.25%) compares as 81.3 against HLTV's 81.2
  expect([hltvRound1((100 * 13) / 16), hltvRound1(81.35), hltvRound1((100 * 19) / 28), hltvRound1(70)]).toEqual([81.2, 81.4, 67.9, 70]);
});
