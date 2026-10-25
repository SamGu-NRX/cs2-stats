// What earned each KAST round, and team damage, on hand-built rounds.
import { expect, it } from "vitest";
import { METRIC } from "./metrics";
import { rollup } from "./rollup";
import { FREEZE_END, oneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + s * 64;

it("credits each KAST round to one of kill, assist, survival or trade, in that order", () => {
  // fails if a round earned two ways is counted twice (the parts must sum to KAST), or a flash assist earns A
  const f = oneRound({
    players: { k: "CT", a: "CT", s: "CT", tr: "CT", x: "CT", sv: "CT", e1: "T", e2: "T", e3: "T" },
    kills: [
      { tick: t(5), killer: "k", victim: "e1", assister: "a" }, // k: K; a: A (and survives, still A)
      { tick: t(10), killer: "e2", victim: "tr" },
      { tick: t(12), killer: "x", victim: "e2" }, // x: K; tr: traded, T
      { tick: t(20), killer: "e3", victim: "s" }, // s dies untraded: no KAST
    ],
  });
  const m = (id: string) => f.pr.find((r) => f.players[r.pi].id === id)!.m;
  const parts = (id: string) => [m(id).killRounds ?? 0, m(id).kastA ?? 0, m(id).kastS ?? 0, m(id).kastT ?? 0, m(id).kast ?? 0];
  expect(parts("k")).toEqual([1, 0, 0, 0, 1]);
  expect(parts("a")).toEqual([0, 1, 0, 0, 1]);
  expect(parts("tr")).toEqual([0, 0, 0, 1, 1]);
  expect(parts("s")).toEqual([0, 0, 0, 0, 0]);
  expect(parts("sv")).toEqual([0, 0, 1, 0, 1]);
});

it("counts damage to teammates apart from ADR damage", () => {
  // fails if team damage leaks into dmg or is not recorded
  const hit = (victim: string, team: boolean) => ({ tick: t(3), attacker_steamid: "a", victim_steamid: victim, weapon: "ak47", dmg_health: 27, dmg_health_capped: 27, health_before: 100, is_team_damage: team });
  const f = oneRound({ players: { a: "CT", b: "CT", c: "T" }, damages: [hit("b", true), hit("c", false)] });
  const a = f.pr.find((r) => f.players[r.pi].id === "a")!.m;
  expect([a.dmg, a.teamDmg]).toEqual([27, 27]);
});

it("gives damage whose attacker the demo lost to nobody, in ADR or in swing's damage share", () => {
  // fails if a rebuilt hit with no attacker (match.unattributed_damage_hp) is credited to anyone
  const hit = (attacker: string | null, dmg: number, tick: number) => ({ tick, attacker_steamid: attacker, victim_steamid: "v", weapon: attacker ? "ak47" : null, dmg_health: attacker ? dmg : null, dmg_health_capped: dmg, health_before: 100 });
  const equip = { equip_value_game: 4000 };
  const f = oneRound({
    round: 5,
    players: { k: "CT", h: "CT", v: "T", w: "T" },
    player_rounds: { k: equip, h: equip, v: equip, w: equip },
    damages: [hit(null, 60, t(3)), hit("h", 40, t(4))],
    kills: [{ tick: t(4), killer: "k", victim: "v" }],
  });
  const dmg = (id: string) => f.pr.find((r) => f.players[r.pi].id === id)!.m.dmg ?? 0;
  expect([dmg("k"), dmg("h"), dmg("w")]).toEqual([0, 40, 0]);
  const credited = f.kills[0].credits.filter(([, x]) => x > 0).map(([p]) => f.players[p].id);
  expect(credited).toEqual(["h"]);
});

it("rates traded death success over tradeable deaths only, so it cannot pass 100%", () => {
  // fails if traded deaths outside the tradeable ones (no positions, or no teammate near) count in the
  // numerator: the profile once showed 136%
  const death = { tick: t(5), killer: "e", victim: "v", at: { v_x: 0, v_y: 0 } };
  const trade = { tick: t(7), killer: "m", victim: "e" };
  const players = { v: "CT", m: "CT", e: "T" } as const;
  const near = oneRound({ players, kills: [death], positions: [{ tick: t(5), steamid: "m", x: 300, y: 0 }, { tick: t(5), steamid: "v", x: 0, y: 0 }] });
  const unlogged = oneRound({ players, kills: [death, trade] });
  const s = rollup([near, unlogged, unlogged], { player: "v" });
  expect([s.m.tradedDeaths, s.m.tradeableDeaths, METRIC.tradedDeathSuccess.value(s)]).toEqual([2, 1, 0]);
});

it("marks a demo match that stopped before either team won as incomplete", () => {
  // fails if an abandoned one-round match counts as finished in career views
  expect(oneRound({ players: { a: "CT", b: "T" } }).match).toMatchObject({ score: [1, 0], complete: false });
});

it("counts trade opportunities, attempts and successes for the trader and for the traded", () => {
  // fails if a teammate who hit the killer without killing him is not an attempt, or the death it
  // follows does not count as attempted
  const death = { tick: t(5), killer: "e", victim: "v", at: { v_x: 0, v_y: 0 } };
  const f = oneRound({
    players: { v: "CT", m: "CT", e: "T" },
    kills: [death],
    positions: [{ tick: t(5), steamid: "m", x: 300, y: 0 }, { tick: t(5), steamid: "v", x: 0, y: 0 }],
    damages: [{ tick: t(6), attacker_steamid: "m", victim_steamid: "e", weapon: "ak47", dmg_health: 27, dmg_health_capped: 27, health_before: 100 }],
  });
  const m = (id: string) => f.pr.find((r) => f.players[r.pi].id === id)!.m;
  expect([m("m").tradeOpps, m("m").tradeAttempts ?? 0, m("m").tradeOppsTaken ?? 0]).toEqual([1, 1, 0]);
  expect([m("v").tradeableDeaths, m("v").tradedAttempts, m("v").tradeableTraded ?? 0]).toEqual([1, 1, 0]);
});

it("lists each clutch with its round, opponents and result", () => {
  // fails if the clutch list loses the 1vX that the clutch measures count
  const f = oneRound({
    players: { a: "CT", b: "CT", c: "T", d: "T" },
    kills: [{ tick: t(5), killer: "c", victim: "b" }, { tick: t(8), killer: "a", victim: "c" }, { tick: t(9), killer: "a", victim: "d" }],
  });
  // a goes 1v2 after b dies; once c dies, d is left 1v1 against a
  expect(f.clutches.map((c) => [f.players[c.pi].id, c.opponents, c.won])).toEqual([["a", 2, true], ["d", 1, false]]);
});
