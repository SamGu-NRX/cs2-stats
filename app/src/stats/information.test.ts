// Radar spotting on hand-built rounds: CT "a" and "c" against T "b". Freeze ends at tick 640.
import { expect, it } from "vitest";
import { oneRound, TICK_RATE } from "./testing/match";

const spot = (tick: number, spotter: string, target: string, spotted: boolean) => ({ tick, spotter_steamid: spotter, target_steamid: target, spotted });
const of = (f: ReturnType<typeof oneRound>, id: string) => f.information.find((x) => f.players[x.pi].id === id)!;

it("clips spotted time to freeze end and the target's death, and credits a teammate's kill inside the window", () => {
  // fails if radar state from freeze time or after a death counts, or the assist window is off by a tick
  const kill = 1280;
  // the assist window is 3 s: 192 ticks at 64 tick
  const run = (spotEnd: number) => of(oneRound({
    players: { a: "CT", c: "CT", b: "T" },
    kills: [{ tick: kill, killer: "c", victim: "b" }],
    spotted: [spot(300, "a", "b", true), spot(spotEnd, "a", "b", false)],
  }), "a");
  expect(run(3000)).toMatchObject({ spotSecs: (kill - 640) / TICK_RATE, spotAssists: 1 });
  expect(run(kill - 192).spotAssists).toBe(1);
  expect(run(kill - 193).spotAssists).toBe(0);
});

it("leaves first spots out when a teammate is a bot", () => {
  // fails if a team with a bot, which can never appear as a spotter, still ranks its humans
  const spotted = [spot(700, "a", "b", true), spot(800, "c", "b", true)];
  const f = oneRound({ players: { a: "CT", c: "CT", b: "T" }, spotted });
  expect([of(f, "a").firstSpot, of(f, "c").firstSpot]).toEqual([true, false]);
  const withBot = oneRound({ players: { a: "CT", c: "CT", b: "T" }, bots: ["c"], spotted: [spotted[0]] });
  expect(of(withBot, "a").firstSpot).toBeNull();
});
