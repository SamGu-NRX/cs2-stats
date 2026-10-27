// Utility usage on hand-built rounds: who a flash blinded, grenade damage by kind, and thrown grenades.
import { describe, expect, it } from "vitest";
import { MEASURES, THROW_LOGGED } from "./facts";
import { METRIC, METRICS } from "./metrics";
import { emptySummary, rollup } from "./rollup";
import { derive } from "./derive";
import { CS2RB } from "./model-params";
import { FREEZE_END, oneRound, oneRoundTables, ROUND_END } from "./testing/match";
import { pushRow } from "./testing/tables";
import { emptyTable } from "./tables";

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
  Object.assign(s.m, { rounds: 10, throwRounds: 10, flashes: 4, flashKills: 1, flashKillsLogged: 1, deaths: 5, utilDeaths: 2, utilUnused: 600 });
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

it("marks a round as recording utility only when it holds a throw, detonation or blind", () => {
  // fails if a source with no grenade or flash events (some plugin files) reads as one that recorded
  // a round without utility: no events gives 0 known player-rounds; one blind, or one throw, gives both
  const known = (m: Parameters<typeof oneRound>[0]) => rollup([oneRound(m)], { player: ["a", "c"] }).m.utilityRounds;
  expect(known({ players: { a: "CT", c: "T" } })).toBe(0);
  expect(known({ players: { a: "CT", c: "T" }, blinds: [{ tick: FREEZE_END + 300, attacker_steamid: "a", victim_steamid: "c", duration: 2 }] })).toBe(2);
  expect(known({ players: { a: "CT", c: "T" }, grenade_throws: [{ tick: FREEZE_END + 300, steamid: "c", weapon: "smokegrenade" }] })).toBe(2);
  // a detonation alone (a plugin file without a throw log) counts too
  const tables = oneRoundTables({ players: { a: "CT", c: "T" } });
  tables.grenade_events = emptyTable("grenade_events");
  pushRow(tables.grenade_events, { tick: FREEZE_END + 300, round: 1, event: "smoke_detonate", entity_id: 0, steamid: "c", x: null, y: null, z: null });
  expect(rollup([derive(tables, CS2RB)], { player: ["a", "c"] }).m.utilityRounds).toBe(2);
});

it("marks utility coverage round by round, not for the whole match", () => {
  // fails if one round's blind covers the match: round 1 holds a blind, round 2 (a copy of its rows
  // with no events) holds none, so 2 of the 4 player-rounds are known
  const tables = oneRoundTables({ players: { a: "CT", c: "T" }, blinds: [{ tick: FREEZE_END + 300, attacker_steamid: "a", victim_steamid: "c", duration: 2 }] });
  const rowOf = (t: object, i: number) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "n").map(([k, col]) => [k, (col as unknown[])[i]]));
  pushRow(tables.rounds, { ...rowOf(tables.rounds, 0), round: 2, start_tick: ROUND_END, freeze_end_tick: ROUND_END + FREEZE_END, end_tick: 2 * ROUND_END } as Parameters<typeof pushRow<"rounds">>[1]);
  for (let i = 0, n = tables.player_rounds.n; i < n; i++) pushRow(tables.player_rounds, { ...rowOf(tables.player_rounds, i), round: 2 } as Parameters<typeof pushRow<"player_rounds">>[1]);
  const s = rollup([derive(tables, CS2RB)], { player: ["a", "c"] });
  expect([s.m.utilityRounds, s.m.rounds]).toEqual([2, 4]);
});

it("rates grenades thrown per round over the rounds of matches with a throw log only", () => {
  // fails if a match without a throw log (the Valve imports) counts as rounds with no throws: a throws
  // two flashbangs in a logged one-round match and plays one round of a match with no throw log.
  // Over both, 2 flashbangs in 1 logged round is 2.00 a round, not 1.00; over the unlogged match alone
  // there is no rate, and the metric says why
  const logged = oneRound({ players: { a: "CT", c: "T" }, grenade_throws: [
    { tick: FREEZE_END + 100, steamid: "a", weapon: "flashbang" }, { tick: FREEZE_END + 300, steamid: "a", weapon: "flashbang" },
  ] });
  const unlogged = oneRound({ players: { a: "CT", c: "T" } });
  const both = rollup([logged, unlogged], { player: "a" });
  expect([both.m.rounds, both.m.throwRounds, both.m.flashes]).toEqual([2, 1, 2]);
  expect(METRIC.flashesPR.value(both)).toBe(2);
  expect(METRIC.smokesPR.value(both)).toBe(0);
  const none = rollup([unlogged], { player: "a" });
  expect([METRIC.flashesPR.value(none), METRIC.hesPR.value(none), METRIC.molotovsPR.value(none), METRIC.smokesPR.value(none)]).toEqual([null, null, null, null]);
  expect(METRIC.flashesPR.why!(none)).toBe("none of these matches logs grenade throws");
  expect(METRIC.flashesPR.why!(both)).toBeNull();
});

describe("ratios per grenade thrown", () => {
  // One round each: a throws two flashbangs, an HE and a molotov; one flash blinds c for 2.5 s, b kills
  // the blind c with a's flash assist, the HE deals 40 and the fire 8 to c. Only the logged match has
  // the throw log. Each ratio over both matches must read the logged match alone: the unlogged one has
  // the same blinds, damage and assist but no thrown count to divide them by.
  const match = (logged: boolean) => oneRound({
    players: { a: "CT", b: "CT", c: "T" },
    ...(logged ? { grenade_throws: ["flashbang", "flashbang", "hegrenade", "molotov"].map((weapon, i) => ({ tick: FREEZE_END + 100 + i, steamid: "a", weapon })) } : {}),
    blinds: [{ tick: FREEZE_END + 300, attacker_steamid: "a", victim_steamid: "c", duration: 2.5 }],
    damages: [
      { tick: FREEZE_END + 305, attacker_steamid: "a", victim_steamid: "c", weapon: "hegrenade", dmg_health: 40, dmg_health_capped: 40, health_before: 100 },
      { tick: FREEZE_END + 310, attacker_steamid: "a", victim_steamid: "c", weapon: "inferno", dmg_health: 8, dmg_health_capped: 8, health_before: 60, grenade_entity_id: 7 },
    ],
    kills: [{ tick: FREEZE_END + 320, killer: "b", victim: "c", assister: "a", at: { assistedflash: true } }],
  });
  const both = rollup([match(true), match(false)], { player: "a" });
  const ids = ["assistsPerFlash", "flashKillsPerFlash", "enemiesPerFlash", "blindPerFlash", "dmgPerHe", "molotovEnemiesHit", "molotovDmg"];

  it("counts every numerator in both matches, so the match views keep the unlogged match's blinds and damage", () => {
    expect([both.m.flashAssists, both.m.flashKills, both.m.enemiesFlashed, both.m.enemyBlindSecs, both.m.heDmg, both.m.molotovHits, both.m.fireDmg]).toEqual([2, 2, 2, 5, 80, 2, 16]);
    expect([both.m.flashes, both.m.hes, both.m.molotovs]).toEqual([2, 1, 1]);
  });

  it("divides the flash, HE and molotov ratios over the logged match only", () => {
    // fails if a ratio adds the unlogged match's numerator to the logged match's thrown count: mixed,
    // they would read 1, 1, 1, 2.5, 80, 2 and 16
    expect(ids.map((id) => METRIC[id].value(both))).toEqual([0.5, 0.5, 0.5, 1.25, 40, 1, 8]);
    expect(ids.map((id) => METRIC[id].why!(both))).toEqual(ids.map(() => null));
  });

  it("has no ratio, and says why, with no logged match in scope", () => {
    const none = rollup([match(false)], { player: "a" });
    expect(ids.map((id) => METRIC[id].value(none))).toEqual(ids.map(() => null));
    expect(ids.map((id) => METRIC[id].why!(none))).toEqual(ids.map(() => "none of these matches logs grenade throws"));
  });
});

it("lets no metric read a thrown count without the throw-log rule", () => {
  // fails if a metric added later divides by flashes, HEs, molotovs or smokes some other way than
  // perThrown or over throwRounds: a metric whose value moves with a thrown count must say it has no
  // value when no match in scope logs throws
  const base = emptySummary();
  for (const k of MEASURES) base.m[k] = 3;
  base.m.rounds = 6;
  const reading: string[] = [];
  for (const m of METRICS) {
    const moved = (["flashes", "hes", "molotovs", "smokes"] as const).some((k) => {
      const a = structuredClone(base), b = structuredClone(base);
      b.m[k] = 7;
      return m.value(a) !== m.value(b);
    });
    if (!moved) continue;
    reading.push(m.id);
    const none = structuredClone(base);
    none.m.throwRounds = 0;
    expect(m.why?.(none), m.id).toBe("none of these matches logs grenade throws");
  }
  expect(reading.sort()).toEqual(["assistsPerFlash", "blindPerFlash", "dmgPerHe", "enemiesPerFlash", "flashKillsPerFlash", "flashesPR", "hesPR", "molotovDmg", "molotovEnemiesHit", "molotovsPR", "smokesPR"]);
  // and none of them reads a numerator over every match: only its twin over the logged ones (THROW_LOGGED)
  for (const id of reading) for (const k of Object.keys(THROW_LOGGED) as (keyof typeof THROW_LOGGED)[]) {
    const b = structuredClone(base);
    b.m[k] = 11;
    expect(METRIC[id].value(b), `${id} reads ${k}`).toBe(METRIC[id].value(base));
  }
});
