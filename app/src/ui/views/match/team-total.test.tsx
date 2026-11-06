// @vitest-environment jsdom
// The scoreboard's team total under the takeover credit (Overview.tsx teamLine): it sums the players'
// game-credit lines, so "You" cannot move play into or out of a team's total.
import { describe, expect, it } from "vitest";
import { emptyMeasures, type Measures } from "../../../stats/facts";
import { credited } from "../../data/credit";
import { lineOf } from "../../data/engine";
import { teamLine } from "./Overview";

const line = (m: Partial<Measures>) => lineOf({ m: { ...emptyMeasures(), rounds: 10, ...m }, v: {} }, null);

describe("teamLine", () => {
  it("totals the game's figures under You, even when a driver's body was on the other team", () => {
    // the driver made 2 kills and 300 damage in a body the other team's total holds. Fails if his team's
    // total takes the credited kills, deaths or damage rates: it must read 8 kills, 9 deaths, ADR 120
    const driver = credited(line({ kills: 5, deaths: 4, dmg: 700, takeoverKills: 2, takeoverDeaths: 1, takeoverDmg: 300 }), "you");
    const mate = credited(line({ kills: 3, deaths: 5, dmg: 500 }), "you");
    expect([driver.kills, driver.deaths]).toEqual([7, 5]);
    const t = teamLine([driver, mate], null);
    expect([t.kills, t.deaths, t.diff, t.adr, t.moved]).toEqual([8, 9, -1, 60, false]);
  });
});
