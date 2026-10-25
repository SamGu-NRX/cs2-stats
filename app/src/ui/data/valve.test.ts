// The user's Valve matches in the app: whose match it is, how it is labelled, and where it counts.
// Matches are hand-built one-round tables (stats/testing/match.ts) through the real derive and entryOf.
import { expect, it } from "vitest";
import { derive } from "../../stats/derive";
import { withPov } from "../../stats/load";
import { CS2RB, modelFingerprint } from "../../stats/model-params";
import type { MatchTables } from "../../stats/tables";
import { oneRoundTables } from "../../stats/testing/match";
import { factsKey } from "../../worker/keys";
import { entryOf } from "../../worker/views";
import { careerEntries, isWingman, listedEntries } from "./engine";
import type { MatchEntry } from "./match";
import { sourceOf } from "./sources";

/** A Valve demo's tables: source "valve", no pov, and a round limit of maxRounds. */
function valveTables(players: Record<string, "CT" | "T">, maxRounds: number): MatchTables {
  const t = oneRoundTables({ players, kills: [{ tick: 2000, killer: "1", victim: "3" }] });
  return { ...t, match: { ...t.match, source: ["valve"], convars: [JSON.stringify({ mp_maxrounds: String(maxRounds) })] } };
}

it("sees a Valve match from the user's SteamID64, which the host passes, not from the demo", () => {
  // fails if the importer's user is not applied: the match cannot be shown at all (no recording player)
  const t = valveTables({ 1: "CT", 2: "CT", 3: "T", 4: "T" }, 16);
  expect(() => entryOf("valve/a/v-1-00000000", "", derive(t, CS2RB))).toThrow(/recording player/);
  const e = entryOf("valve/a/v-1-00000000", "", derive(withPov(t, "3"), CS2RB));
  expect([e.players[e.you].id, e.result, sourceOf(e).id]).toEqual(["3", "L", "valve"]);
});

it("re-derives a Valve match when the user changes", () => {
  // fails if facts derived for one user are served to another from the cache
  const f = { file: "valve/a/v-1-00000000", size: 3, mtime: 1 };
  const m = modelFingerprint(CS2RB);
  expect(factsKey({ ...f, pov: "1" }, m)).not.toBe(factsKey({ ...f, pov: "3" }, m));
  expect(factsKey(f, m)).toBe(factsKey({ ...f }, m));
});

/** An entry from the tables, marked finished (one round cannot finish a match) unless said otherwise. */
const entry = (t: MatchTables, change: Partial<MatchEntry["match"]> = {}, score?: MatchEntry["score"]): MatchEntry => {
  const e = entryOf(`valve/${Math.random()}`, "", derive(withPov(t, "1"), CS2RB));
  return { ...e, match: { ...e.match, complete: true, ...change }, ...(score && { score }) };
};

it("labels wingman and leaves it out of career views, whose models and baselines are 5v5", () => {
  // fails if 2v2 numbers move career averages and percentiles built for 5v5
  const five = entry(valveTables({ 1: "CT", 2: "CT", 5: "CT", 6: "CT", 7: "CT", 3: "T", 4: "T", 8: "T", 9: "T", 10: "T" }, 24));
  const two = entry(valveTables({ 1: "CT", 2: "CT", 3: "T", 4: "T" }, 16));
  // a 2v2 bot match on a 24-round limit is not wingman, and neither is a 5v5 one on 16 rounds
  const twoLong = entry(valveTables({ 1: "CT", 2: "CT", 3: "T", 4: "T" }, 24));
  const fiveShort = entry(valveTables({ 1: "CT", 2: "CT", 5: "CT", 6: "CT", 7: "CT", 3: "T", 4: "T", 8: "T", 9: "T", 10: "T" }, 16));
  expect([five, two, twoLong, fiveShort].map(isWingman)).toEqual([false, true, false, false]);
  expect(careerEntries([five, two], null)).toEqual([five]);
});

it("hides a recording with no round won and no kill, and nothing hidden counts in career views", () => {
  // fails if a 0–0 stub is listed or counted (review of #29: a hidden finished 0–0 still counted), or if a
  // winnerless recording with real kills is hidden instead of listed as unfinished
  const t = valveTables({ 1: "CT", 3: "T" }, 24);
  const done = entry(t);
  const winnerless = entry(t, { complete: false }, { us: 0, them: 0 });
  const stub = { ...entry(t, {}, { us: 0, them: 0 }), kills: 0 };
  expect(winnerless.kills).toBeGreaterThan(0);
  expect(listedEntries([done, winnerless, stub], null)).toEqual([done, winnerless]);
  expect(careerEntries([done, winnerless, stub], null)).toEqual([done]);
});
