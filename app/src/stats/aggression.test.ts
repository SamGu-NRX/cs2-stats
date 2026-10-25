// First contact, entry attempts and push depth on hand-built rounds: CT "c1", "c2" against T "t1", "t2".
import { expect, it } from "vitest";
import { FREEZE_END, oneRound, TICK_RATE } from "./testing/match";

const players = { c1: "CT", c2: "CT", t1: "T", t2: "T" } as const;

function sight(id: number, attacker: string, victim: string, from: number, aSpeed: number, vSpeed: number) {
  const rows = [];
  for (let t = from - 20; t <= from + 20; t++) {
    rows.push({ engagement_id: id, tick: t, mesh_visible: t >= from, smoke_blocked: false, a_vel_x: aSpeed, a_vel_y: 0, v_vel_x: vSpeed, v_vel_y: 0 });
  }
  return { eng: { engagement_id: id, attacker_steamid: attacker, victim_steamid: victim, start_tick: from - 20, end_tick: from + 20 }, rows };
}

it("ranks first contact within each team and counts an entry only for a moving first contact", () => {
  // fails if a victim's sighting is not contact, ranks mix teams, or a holder who is peeked first gets an entry
  const ws = [sight(0, "t1", "c2", 900, 200, 0), sight(1, "c1", "t2", 1000, 200, 0)];
  const f = oneRound({ players, engagements: ws.map((w) => w.eng), engagement_ticks: ws.flatMap((w) => w.rows) });
  const got = Object.fromEntries(f.aggression.map((a) => [f.players[a.pi].id, [a.contactS, a.contactRank, a.entry]]));
  expect(got).toEqual({
    t1: [(900 - FREEZE_END) / TICK_RATE, 1, true],
    c2: [(900 - FREEZE_END) / TICK_RATE, 1, false],
    c1: [(1000 - FREEZE_END) / TICK_RATE, 2, false],
    t2: [(1000 - FREEZE_END) / TICK_RATE, 2, false],
  });
});

it("measures push depth between the spawns and stops at the round's first kill", () => {
  // fails if samples after the first kill count, or progress is not measured from the player's own spawn
  const at = (steamid: string, tick: number, x: number, y = 0) => ({ steamid, tick, x, y });
  const f = oneRound({
    players,
    kills: [{ tick: 2000, killer: "t2", victim: "c2" }],
    positions: [
      at("c1", FREEZE_END, 0, 100), at("c2", FREEZE_END, 0, -100), at("t1", FREEZE_END, 1000, 100), at("t2", FREEZE_END, 1000, -100),
      at("c1", 1000, 250, 300), // 25% of the way, off the spawn-to-spawn line
      at("c1", 2500, 900), // after the first kill
      at("t1", 1000, 600), // 40% from the T spawn toward the CT spawn
    ],
  });
  const push = Object.fromEntries(f.aggression.map((a) => [f.players[a.pi].id, a.push]));
  expect(push.c1).toBeCloseTo(0.25, 9);
  expect(push.t1).toBeCloseTo(0.4, 9);
});
