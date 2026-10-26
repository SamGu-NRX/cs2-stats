// Clutch rows through the worker's row builder (views.ts addClutchRows), on hand-built rounds: CT
// a and b against T c and d unless a test says otherwise.
import { expect, it } from "vitest";
import { addSituations, type Situations } from "../stats/matchviews";
import { rollup } from "../stats/rollup";
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

it("counts a player as last alive before any death only from a freeze-end roster", () => {
  // fails if a live-recorded round's end-of-round rows, where a is CT's only row, make a the last
  // alive although no CT player died; the same rows read at freeze end do
  const round = (freezeEnd: number | null) => oneRound({
    players: { a: "CT", c: "T", b: "T" }, roundRow: { freeze_end_tick: freezeEnd },
    kills: [{ tick: t(1), killer: "a", victim: "c" }, { tick: t(2), killer: "a", victim: "b" }],
  });
  const lastAlive = (f: ReturnType<typeof oneRound>) => rollup([f], { player: "a" }).m.lastAlive;
  expect([lastAlive(round(null)), lastAlive(round(FREEZE_END))]).toEqual([0, 1]);
});

it("counts the clutch a teammate's disconnect leaves the player in", () => {
  // fails if a living player who disconnects still counts as alive: b leaves at 5 s, so a's death at
  // 10 s leaves c alone against d and e, a 1v2 c wins with two kills; c's kill on d then leaves e
  // alone too, a 1v1. Without the leave, CT keeps b and c, and e gets a 1v2 instead
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "CT", d: "T", e: "T" },
    leaves: [{ tick: t(5), steamid: "b", alive: true }],
    kills: [{ tick: t(10), killer: "d", victim: "a" }, { tick: t(20), killer: "c", victim: "d" }, { tick: t(30), killer: "c", victim: "e" }],
  });
  expect(rows(f, ["a", "b", "c", "d", "e"]).map((r) => [r.player, r.opponents, r.won, r.kills, r.t])).toEqual([["c", 2, true, 2, 10], ["e", 1, false, 0, 20]]);
});

it("gives no clutch to a player who disconnected", () => {
  // fails if b, who left at 5 s, still counts as alive: then a's death at 10 s makes b CT's last player
  // in a false 1v2. With the leave, a is the one left alone, in a 1v2 from 5 s that a loses
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T" },
    leaves: [{ tick: t(5), steamid: "b", alive: true }],
    kills: [{ tick: t(10), killer: "c", victim: "a" }],
  });
  expect(rows(f, ["a", "b", "c", "d"]).map((r) => [r.player, r.opponents, r.won, r.saved, r.t])).toEqual([["a", 2, false, false, 5]]);
});

it("leaves a player dead at freeze end out of the clutch population", () => {
  // fails if b, whom the source marks dead at freeze end, counts as alive: a is CT's only player from
  // the start, a 1v2 from 0 s that a wins with two kills, and a's kill on c leaves d alone in a 1v1.
  // Counting b, CT never gets down to one and d gets a false 1v2
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "T", d: "T" },
    player_rounds: { b: { alive_at_start: false } },
    kills: [{ tick: t(10), killer: "a", victim: "c" }, { tick: t(20), killer: "a", victim: "d" }],
  });
  expect(rows(f, ["a", "b", "c", "d"]).map((r) => [r.player, r.opponents, r.won, r.kills, r.t])).toEqual([["a", 2, true, 2, 0], ["d", 1, false, 0, 10]]);
});

it("agrees with the saves count: a clutch player who disconnects in a lost round saved nothing", () => {
  // fails if the clutch row and the saves measure disagree about a disconnect. c kills b at 5 s,
  // leaving a in a 1v2; a disconnects alive at 20 s and T wins. a was not alive at the end: no clutch
  // save and no save. e, whom the source marks dead at freeze end, saved nothing either
  const f = oneRound({
    players: { a: "CT", b: "CT", e: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T" },
    player_rounds: { e: { alive_at_start: false } },
    leaves: [{ tick: t(20), steamid: "a", alive: true }],
    kills: [{ tick: t(5), killer: "c", victim: "b" }],
  });
  expect(rows(f, ["a"]).map((r) => [r.player, r.opponents, r.won, r.saved])).toEqual([["a", 2, false, false]]);
  expect(["a", "e"].map((p) => rollup([f], { player: p }).m.saves)).toEqual([0, 0]);
});

it("leaves a player who disconnected at or before freeze end out of the population, whatever alive_at_start says", () => {
  // fails if b, who left at freeze end with no alive-at-start flag, counts as alive: then a's death at
  // 10 s makes b CT's last player in a 1v2 b "saves" by never dying. b was never in the round: a is
  // alone from the start, a 1v2 a loses, and b saved nothing
  const round = (leftAt: number) => oneRound({
    players: { a: "CT", b: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T" },
    leaves: [{ tick: leftAt, steamid: "b", alive: true }],
    kills: [{ tick: t(10), killer: "c", victim: "a" }],
  });
  for (const leftAt of [FREEZE_END - 64, FREEZE_END]) {
    const f = round(leftAt);
    expect(rows(f, ["a", "b", "c", "d"]).map((r) => [r.player, r.opponents, r.won, r.saved, r.t])).toEqual([["a", 2, false, false, 0]]);
    expect(rollup([f], { player: "b" }).m.saves).toBe(0);
  }
});

it("agrees with the man-advantage states on who is in the round", () => {
  // fails if the two views read different populations: b disconnected at freeze end with no
  // alive-at-start flag, so CT starts with a alone. The clutch list has a in a 1v2 from the start, and
  // the man-advantage states have a's side at 1v2 and nothing else (counting b, they would add 2v2)
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "T", d: "T" }, roundRow: { winner_side: "T" },
    leaves: [{ tick: FREEZE_END, steamid: "b", alive: true }],
    kills: [{ tick: t(10), killer: "c", victim: "a" }],
  });
  expect(rows(f, ["a"]).map((r) => [r.player, r.opponents, r.t])).toEqual([["a", 2, 0]]);
  const states: Situations = {};
  addSituations(states, f, { player: "a" });
  expect(states).toEqual({ "1v2": { rounds: 1, won: 0 } });
});
