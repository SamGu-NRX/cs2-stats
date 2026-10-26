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

it("builds sessions from the matches the query's filters keep", async () => {
  // fails if a filtered-out match joins a session or bridges two: with the Mirage match (20:00 to
  // 20:30) the Dust2 matches at 18:00 and 23:00 sit 1.5 and 2.5 hours from it, one session; under a
  // Dust2 filter they are 4.5 hours apart, two sessions. The match without player a is left out too
  const z = oneRound({ players: { z: "CT", c: "T" } });
  const calls = callsOver({
    d1: match(1, "2026-10-24T18:00:00Z", "de_dust2"), m: match(1, "2026-10-24T20:00:00Z", "de_mirage"),
    d2: match(2, "2026-10-24T23:00:00Z", "de_dust2"), none: { ...z, match: { ...z.match, map: "de_dust2", startedAt: "2026-10-24T21:00:00Z" } },
  });
  const sessions = await calls.sessions({ files: ["d1", "m", "d2", "none"], filter: { player: "a", maps: ["de_dust2"] } });
  expect(sessions.map((s) => [s.files, s.kills, s.wins + s.losses + s.ties])).toEqual([[["d1"], 1, 1], [["d2"], 2, 1]]);
  expect((await calls.sessions({ files: ["d1", "m", "d2"], filter: { player: "a" } })).map((s) => s.files)).toEqual([["d1", "m", "d2"]]);
});
