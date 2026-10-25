// Peek classes and exposure before the first shot, on hand-built engagement windows. Player "a"
// (CT) moves along x toward "b" (T); a window's rows carry a's velocity and position per tick.
import { expect, it } from "vitest";
import { oneRound, TICK_RATE } from "./testing/match";
import type { MoveFact } from "./movement";

type Window = { eng: Record<string, unknown>; rows: Record<string, unknown>[] };

function window(id: number, from: number, to: number, vel: (t: number) => number, seen: (t: number) => boolean): Window {
  const rows = [];
  let x = 0;
  for (let t = from; t <= to; t++) {
    rows.push({ engagement_id: id, tick: t, a_x: x, a_y: 0, a_vel_x: vel(t), a_vel_y: 0, mesh_visible: seen(t), smoke_blocked: false });
    x += vel(t) / TICK_RATE;
  }
  return { eng: { engagement_id: id, attacker_steamid: "a", victim_steamid: "b", start_tick: from, end_tick: to }, rows };
}

function facts(ws: Window[], shotTicks: number[] = []) {
  const f = oneRound({
    players: { a: "CT", b: "T" },
    engagements: ws.map((w) => w.eng),
    engagement_ticks: ws.flatMap((w) => w.rows),
    shots: shotTicks.map((tick) => ({ tick, steamid: "a", ducked: false })),
  });
  const round = f.movement.find((x): x is Extract<MoveFact, { k: "round" }> => x.k === "round" && f.players[x.pi].id === "a")!;
  const exposures = f.movement.flatMap((x) => (x.k === "weapon" ? x.exposures : []));
  return { peek: { peeks: round.peeks, shoulder: round.shoulder, jiggle: round.jiggle, wide: round.wide }, exposures };
}

const between = (a: number, b: number) => (t: number) => t >= a && t <= b;
// out at 200 u/s, then decelerating by 40 u/s per tick from 1110: moving back from tick 1116
const outAndBack = (t: number) => (t < 1110 ? 200 : 200 - (t - 1110) * 40);

it("classifies a short exposure as a shoulder peek only without a shot and within 0.3 s", () => {
  // fails if a peek that fired counts as a shoulder peek, or the 0.3 s limit is off by a tick
  expect(facts([window(0, 1000, 1300, outAndBack, between(1100, 1109))]).peek).toEqual({ peeks: 1, shoulder: 1, jiggle: 0, wide: 0 });
  expect(facts([window(0, 1000, 1300, outAndBack, between(1100, 1109))], [1105]).peek).toEqual({ peeks: 1, shoulder: 0, jiggle: 0, wide: 0 });
  expect(facts([window(0, 1000, 1300, outAndBack, between(1100, 1118))]).peek.shoulder).toBe(1); // 19 ticks = 0.297 s
  expect(facts([window(0, 1000, 1300, outAndBack, between(1100, 1119))]).peek.shoulder).toBe(0); // 20 ticks = 0.3125 s
});

it("counts a peek only when the player was moving into it, and splits wide from stopping", () => {
  // fails if a holder seen by a moving enemy gets a peek, or a peek that stops at the edge counts as wide
  expect(facts([window(0, 1000, 1300, () => 0, between(1100, 1200))]).peek.peeks).toBe(0);
  expect(facts([window(0, 1000, 1300, () => 200, between(1100, 1200))]).peek).toEqual({ peeks: 1, shoulder: 0, jiggle: 0, wide: 1 });
  expect(facts([window(0, 1000, 1300, (t) => (t < 1104 ? 200 : 0), between(1100, 1200))]).peek).toEqual({ peeks: 1, shoulder: 0, jiggle: 0, wide: 0 });
});

it("marks every shoulder peek of a chain at one enemy as a jiggle, and not an isolated one", () => {
  // fails if the first peek of a jiggle is left uncounted, or a peek 4 s later joins the chain
  const bursts = [1100, 1160, 1220];
  const vel = (b: number) => (t: number) => (t >= b - 10 && t < b + 3 ? 200 : t >= b + 3 && t < b + 20 ? -200 : 0);
  const chain = window(0, 1000, 1400, (t) => bursts.reduce((v, b) => v + vel(b)(t), 0), (t) => bursts.some((b) => t >= b && t <= b + 4));
  const later = window(1, 1450, 1700, vel(1500), between(1500, 1504));
  expect(facts([chain, later]).peek).toEqual({ peeks: 4, shoulder: 4, jiggle: 3, wide: 0 });
});

it("measures exposure from the onset to the first gun shot, and skips exposures open at the window start", () => {
  // fails if the onset or shot tick is off, or an exposure whose onset was not seen gives a sample
  expect(facts([window(0, 1000, 1300, () => 0, between(1100, 1200))], [1115]).exposures).toEqual([15 / TICK_RATE]);
  expect(facts([window(0, 1000, 1300, () => 0, between(1000, 1200))], [1115]).exposures).toEqual([]);
});
