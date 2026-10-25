// What earned each KAST round, and team damage, on hand-built rounds.
import { expect, it } from "vitest";
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
