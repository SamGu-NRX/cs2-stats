// The worker's per-match calls (matchcalls.ts) on hand-built one-round matches, streamed the way the
// worker streams them: each match with its own file.
import { expect, it } from "vitest";
import type { MatchFacts } from "../stats/facts";
import { rollup } from "../stats/rollup";
import { FREEZE_END, oneRound } from "../stats/testing/match";
import { matchCalls } from "./matchcalls";

const t = (s: number) => FREEZE_END + 64 * s;

/** Calls over `facts` by file, streamed in the order asked for. */
const callsOver = (facts: Record<string, MatchFacts>) => matchCalls(
  async (files, visit) => { for (const file of files) visit(facts[file], file); },
  async (q) => rollup(q.files.map((file) => facts[file]), q.filter),
);

/** One round on `map` starting at `startedAt` (30 minutes long) in which a kills `kills` of c, d and e. */
const match = (kills: number, startedAt: string, map = "de_test") => {
  const f = oneRound({
    players: { a: "CT", c: "T", d: "T", e: "T" },
    kills: ["c", "d", "e"].slice(0, kills).map((victim, i) => ({ tick: t(i + 1), killer: "a", victim })),
  });
  return { ...f, match: { ...f.match, map, startedAt, date: startedAt.slice(0, 10), durationS: 1800 } };
};

it("keeps each match's own file when two files hold the same match id", async () => {
  // fails if results are keyed by match id: both files hold match "test", a.json with 3 kills and
  // b.json with 1, so the kills best, the session's most kills and the multi-kill round all come
  // from a.json, not from the file seen last
  const calls = callsOver({ "a.json": match(3, "2026-10-24T20:00:00Z"), "b.json": match(1, "2026-10-24T21:00:00Z") });
  const q = { files: ["a.json", "b.json"], filter: { player: "a" } };
  expect((await calls.personalBests(q)).find((b) => b.id === "kills")).toEqual({ id: "kills", value: 3, file: "a.json" });
  const [session] = await calls.sessions(q);
  expect([session.files, session.kills, session.awards.mostKills]).toEqual([["a.json", "b.json"], 4, { file: "a.json", kills: 3 }]);
  expect((await calls.multiKills(q)).map((r) => [r.file, r.kills])).toEqual([["a.json", 3]]);
});
