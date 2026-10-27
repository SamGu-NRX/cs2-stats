// Swing credit for flashes (model/rating3/SPEC.md "Swing credits"), on hand-built rounds.
import { expect, it } from "vitest";
import { PARAMS } from "./model-params";
import { FREEZE_END, oneRound } from "./testing/match";

const E = PARAMS.swing.event_credit;

const t = (s: number) => FREEZE_END + s * 64;
const equip = { equip_value_game: 4000 };

it("gives an eligible flash its weight in a kill's credit, beside the killer's kill weight", () => {
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
  // neither did damage, so the shares are the flash weight and the kill weight alone
  expect(credit.fl / gain).toBeCloseTo(E.flash_weight / (E.flash_weight + E.kill_weight), 12);
  const fl = f.pr.find((r) => f.players[r.pi].id === "fl")!.m;
  expect(fl.flashSwing).toBeCloseTo(credit.fl);
});

it("files every swing credit under one source, so the sources sum to swing", () => {
  // fails if a credit lands under the wrong source or under none. a hits c for 40, c kills a (c's own
  // kill, no damage on a: all of it to c), b hits c for 60 and kills him within the trade window. The
  // gain on c is shared 60 + kill weight to b (a trade kill), 40 to a as damage, and the trade weight to
  // a as the traded teammate. Each victim is charged what his killer's side gained.
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
  expect(m("b").swingTrades! / m("a").swingDamage!).toBeCloseTo((60 + E.kill_weight) / 40, 12);
  expect(m("a").swingTrades! / m("a").swingDamage!).toBeCloseTo(E.trade_weight / 40, 12);
  expect(m("c").swingDeaths).toBeCloseTo(-(m("a").swingDamage! + m("a").swingTrades! + m("b").swingTrades!), 12);
  expect([m("b").swingKills ?? 0, m("b").swingDamage ?? 0]).toEqual([0, 0]);
});

it("shares a victim's charge with the teammate the same killer kills within the trade window", () => {
  // fails if a failed trader is not charged, or is charged for a kill outside the window. x kills y,
  // then z 2 s later (z failed to trade y), then w 20 s after that (outside the window).
  const f = oneRound({
    round: 5,
    players: { x: "CT", q: "CT", y: "T", z: "T", w: "T" },
    player_rounds: { x: equip, q: equip, y: equip, z: equip, w: equip },
    kills: [{ tick: t(2), killer: "x", victim: "y" }, { tick: t(4), killer: "x", victim: "z" }, { tick: t(24), killer: "x", victim: "w" }],
  });
  const charge = (k: number) => Object.fromEntries(f.kills[k].credits.filter(([, v]) => v < 0).map(([p, v]) => [f.players[p].id, v]));
  const first = charge(0);
  expect(Object.keys(first).sort()).toEqual(["y", "z"]);
  expect(first.z / first.y).toBeCloseTo(E.failed_trade_weight / E.victim_weight, 12);
  expect(Object.keys(charge(1))).toEqual(["z"]);
});
