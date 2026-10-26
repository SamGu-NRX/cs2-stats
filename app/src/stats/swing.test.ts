// Swing credit for flashes (model/rating3/SPEC.md "Swing credits"), on hand-built rounds.
import { expect, it } from "vitest";
import { PARAMS } from "./model-params";
import { FREEZE_END, oneRound } from "./testing/match";

const t = (s: number) => FREEZE_END + s * 64;
const equip = { equip_value_game: 4000 };

it("gives an eligible flash the flash share of a kill's credit, and the killer the rest", () => {
  // fails if a teammate's flash on the victim earns nothing, or a team flash or the killer's own flash takes the share
  const blind = (attacker: string, victim: string, extra: Record<string, unknown> = {}) => ({ tick: t(2), attacker_steamid: attacker, victim_steamid: victim, duration: 3, ...extra });
  const f = oneRound({
    round: 5,
    players: { k: "CT", fl: "CT", own: "CT", v: "T", w: "T" },
    player_rounds: { k: equip, fl: equip, own: equip, v: equip, w: equip },
    blinds: [blind("fl", "v"), blind("k", "v"), blind("w", "v", { is_team_flash: true })],
    kills: [{ tick: t(3), killer: "k", victim: "v" }],
  });
  const credit = Object.fromEntries(f.kills[0].credits.filter(([, x]) => x > 0).map(([p, x]) => [f.players[p].id, x]));
  const gain = credit.k + credit.fl;
  expect(Object.keys(credit).sort()).toEqual(["fl", "k"]);
  expect(credit.fl / gain).toBeCloseTo(PARAMS.swing.flash_credit_fraction);
  const fl = f.pr.find((r) => f.players[r.pi].id === "fl")!.m;
  expect(fl.flashSwing).toBeCloseTo(credit.fl);
});

it("files every swing credit under one source, so the sources sum to swing", () => {
  // fails if a credit lands under the wrong source or under none. a hits c for 40, c kills a (c's own
  // kill, no damage on a: all of it to c), b hits c for 60 and kills him within the trade window: b's
  // 60% share is a trade, a's 40% is damage. Each victim is charged what his killer's side gained.
  const f = oneRound({
    round: 5,
    players: { a: "CT", b: "CT", c: "T", d: "T" },
    player_rounds: { a: equip, b: equip, c: equip, d: equip },
    damages: [
      { tick: t(1), attacker_steamid: "a", victim_steamid: "c", weapon: "ak47", dmg_health: 40, dmg_health_capped: 40, health_before: 100, health_after: 60, a_side: "CT", v_side: "T" },
      { tick: t(3), attacker_steamid: "b", victim_steamid: "c", weapon: "ak47", dmg_health: 60, dmg_health_capped: 60, health_before: 60, health_after: 0, a_side: "CT", v_side: "T" },
    ],
    kills: [{ tick: t(2), killer: "c", victim: "a" }, { tick: t(3), killer: "b", victim: "c" }],
  });
  const m = (id: string) => f.pr.find((r) => f.players[r.pi].id === id)!.m;
  const sources = ["swingKills", "swingTrades", "swingDamage", "flashSwing", "swingDeaths", "swingEnd"] as const;
  for (const id of ["a", "b", "c", "d"]) expect(sources.reduce((x, k) => x + (m(id)[k] ?? 0), 0)).toBeCloseTo(m(id).swing ?? 0, 12);
  expect(m("c").swingKills).toBeCloseTo(-m("a").swingDeaths!, 12);
  expect(m("b").swingTrades! / m("a").swingDamage!).toBeCloseTo(60 / 40, 12);
  expect(m("c").swingDeaths).toBeCloseTo(-(m("a").swingDamage! + m("b").swingTrades!), 12);
  expect([m("b").swingKills ?? 0, m("a").swingTrades ?? 0, m("b").swingDamage ?? 0]).toEqual([0, 0, 0]);
});
