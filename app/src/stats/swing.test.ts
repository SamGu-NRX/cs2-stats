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
