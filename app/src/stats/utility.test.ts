// Utility usage on hand-built rounds: who a flash blinded, grenade damage by kind, and thrown grenades.
import { expect, it } from "vitest";
import { METRIC } from "./metrics";
import { emptySummary, rollup } from "./rollup";
import { FREEZE_END, oneRound } from "./testing/match";

it("splits blinds into enemies and teammates and grenade damage into fire and the rest", () => {
  // fails if a team flash counts as an enemy flashed, a blind at or under 1.1 s counts, or fire damage (named "inferno") is missed
  const blind = (victim: string, duration: number, team = false) => ({ tick: FREEZE_END + 300, attacker_steamid: "a", victim_steamid: victim, duration, is_team_flash: team });
  const hit = (weapon: string, dmg: number) => ({ tick: FREEZE_END + 400, attacker_steamid: "a", victim_steamid: "c", weapon, dmg_health: dmg, dmg_health_capped: dmg, health_before: 100 });
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "T" },
    blinds: [blind("c", 2.5), blind("c", 1.0), blind("b", 3, true)],
    damages: [hit("inferno", 8), hit("hegrenade", 40)],
  });
  const m = f.pr.find((r) => f.players[r.pi].id === "a")!.m;
  expect([m.enemiesFlashed, m.enemyBlindSecs, m.teamFlashed, m.teamBlindSecs]).toEqual([1, 2.5, 1, 3]);
  expect([m.utilDmg, m.fireDmg, m.heDmg]).toEqual([48, 8, 40]);
});

it("records each thrown grenade with its time and landing point", () => {
  // fails if the landing map loses grenades or places them at the thrower
  const f = oneRound({
    players: { a: "CT", c: "T" },
    grenade_throws: [{ tick: FREEZE_END + 640, steamid: "a", weapon: "smokegrenade", x: 10, y: 20, land_x: 900.4, land_y: -50 }],
  });
  expect(f.grenades).toEqual([{ ri: 0, pi: 0, weapon: "smokegrenade", t: 10, from: [10, 20], land: [900, -50] }]);
});

it("counts money spent on grenades, less refunds, over rounds with purchases only", () => {
  // fails if a refunded grenade or a rifle counts as utility bought, or a source without purchases dilutes the rate
  const buy = (item: string, cost: number, was_sold = false) => ({ tick: 100, steamid: "a", item, cost, was_sold });
  const f = oneRound({
    players: { a: "CT", c: "T" },
    purchases: [buy("Smoke Grenade", 300), buy("Flashbang", 200), buy("Molotov", 400, true), buy("M4A4", 2900)],
  });
  const m = f.pr.find((r) => f.players[r.pi].id === "a")!.m;
  expect([m.utilSpent, m.purchaseRounds]).toEqual([500, 1]);
  expect(oneRound({ players: { a: "CT", c: "T" } }).pr[0].m.purchaseRounds).toBeUndefined();
});

it("rates flash-to-kills per flash and unused utility per death", () => {
  // fails if either is divided by rounds, which ranks a player by how much he flashes or how early he dies
  const s = emptySummary();
  Object.assign(s.m, { rounds: 10, flashes: 4, flashKills: 1, deaths: 5, utilDeaths: 2, utilUnused: 600 });
  expect([METRIC.flashKillsPerFlash.value(s), METRIC.utilUnused.value(s)]).toEqual([0.25, 300]);
});

it("counts each enemy a molotov burned once for that molotov", () => {
  // fails if every tick of fire damage counts as another enemy burned, or a second enemy is missed
  const burn = (victim: string, tick: number) => ({ tick, attacker_steamid: "a", victim_steamid: victim, weapon: "inferno", dmg_health: 8, dmg_health_capped: 8, health_before: 100, grenade_entity_id: 7 });
  const f = oneRound({
    players: { a: "CT", c: "T", d: "T" },
    grenade_throws: [{ tick: FREEZE_END + 100, steamid: "a", weapon: "molotov", x: 0, y: 0, land_x: 10, land_y: 10 }],
    damages: [burn("c", FREEZE_END + 200), burn("c", FREEZE_END + 210), burn("d", FREEZE_END + 220)],
  });
  const s = rollup([f], { player: "a" });
  expect([s.m.molotovHits, METRIC.molotovEnemiesHit.value(s), METRIC.molotovDmg.value(s)]).toEqual([2, 2, 24]);
});

it("marks a match's rounds as recording utility only when it holds a throw, detonation or blind", () => {
  // fails if a source with no grenade or flash events (some plugin files) reads as one that recorded
  // a round without utility: no events gives 0 known rounds; one blind, or one throw, gives both rounds
  const known = (m: Parameters<typeof oneRound>[0]) => rollup([oneRound(m)], { player: ["a", "c"] }).m.utilityRounds;
  expect(known({ players: { a: "CT", c: "T" } })).toBe(0);
  expect(known({ players: { a: "CT", c: "T" }, blinds: [{ tick: FREEZE_END + 300, attacker_steamid: "a", victim_steamid: "c", duration: 2 }] })).toBe(2);
  expect(known({ players: { a: "CT", c: "T" }, grenade_throws: [{ tick: FREEZE_END + 300, steamid: "c", weapon: "smokegrenade" }] })).toBe(2);
});
