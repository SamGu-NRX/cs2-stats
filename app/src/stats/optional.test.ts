// Optional fields from capture plugin 1.0.0 (SCHEMA.md "Optional fields") and rounds whose result
// the plugin could not read.
import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { countMatch } from "./counters";
import { deriveMatch } from "./derive";
import { teamBuyType } from "./economy";
import { computeTrades, detectClutches } from "./rules";
import { validateMatch } from "./schema";
import { MatchBuilder } from "./testing/build";

const counters = (b: MatchBuilder) => {
  const ctx = buildCtx(b.build());
  return countMatch(ctx, computeTrades(ctx)).counters;
};

describe("saves with rounds.survPrimary", () => {
  test("a save needs a primary at round end; equipment value no longer decides", () => {
    const b = new MatchBuilder().round(0, 2, "elim", { equip: new Array(10).fill(500) });
    for (const v of [2, 3, 4]) b.kill(0, v, 5, v);
    b.m.rounds.survPrimary = [[1, 0, null, null, null, 1, 1, 1, 1, 1]];
    const c = counters(b);
    expect(c[0].saves).toBe(1); // eco equipment, but kept a primary
    expect(c[1].saves).toBe(0); // survived without a primary
  });
});

describe("utility links", () => {
  test("throws count grenades thrown, not detonated; incendiaries count as molotovs", () => {
    const b = new MatchBuilder().grenade(0, 5, 0, "flash");
    b.m.throws = { ri: [0, 0, 0], tick: [b.t(0, 4), b.t(0, 6), b.t(0, 7)], thrower: [0, 0, 0], type: ["flash", "flash", "incgrenade"], pos: [null, null, null] };
    const u = counters(b)[0].util.ct;
    expect([u.flashes, u.molotovs]).toEqual([2, 1]);
  });
  test("blinds.flash groups blinds by flash even when ticks differ", () => {
    const b = new MatchBuilder().blind(0, 10, 0, 5, 2500).blind(0, 10.02, 0, 6, 2500).blind(0, 30, 0, 7, 300);
    b.m.blinds.flash = [4, 4, 9];
    expect(counters(b)[0].util.ct.effectiveFlashes).toBe(1);
  });
  test("damage.nade counts enemies hit per HE", () => {
    const b = new MatchBuilder().damage(0, 10, 0, 5, 30, "hegrenade").damage(0, 10.1, 0, 6, 20, "hegrenade").damage(0, 10.1, 0, 5, 5, "hegrenade");
    b.m.damage.nade = [2, 2, 2];
    expect(counters(b)[0].util.ct.heHits).toBe(2);
  });
  test("utility spent and unused utility at death", () => {
    const b = new MatchBuilder().kill(0, 20, 5, 0);
    b.m.rounds.utilSpent = [[900, null, null, null, null, null, null, null, null, null]];
    b.m.kills.vUtil = [[1, 2, 0, 0, 1, 0]]; // HE 300 + 2 flashes 400 + incendiary 500
    const u = counters(b)[0].util.ct;
    expect([u.spentRounds, u.spent]).toEqual([1, 900]);
    expect([u.heldDeaths, u.heldValue]).toEqual([1, 1200]);
  });
});

describe("rounds with an unknown result", () => {
  const unknownRound = () => {
    const b = new MatchBuilder(3).kill(1, 5, 5, 0).kill(1, 6, 5, 1).kill(1, 7, 5, 2).kill(1, 8, 5, 3);
    b.m.rounds.winSide[1] = null;
    b.m.rounds.how[1] = null;
    return b;
  };
  test("count for neither team, and nobody wins or loses them", () => {
    const v = deriveMatch(unknownRound().build(), "t");
    expect(v.score).toEqual({ us: 2, them: 0 });
    expect(v.rounds[1].winner).toBeNull();
    expect(v.players[0].c.lostRounds).toBe(0);
    expect(v.players[0].c.rounds).toBe(3);
  });
  test("a clutch in such a round is not scored", () => {
    expect(detectClutches(buildCtx(unknownRound().build()), 1)).toEqual([]);
  });
  test("force-buy needs the previous result", () => {
    const b = unknownRound();
    b.round(2, 3, "elim", { equip: new Array(10).fill(3000), money: new Array(10).fill(0) });
    expect(teamBuyType(buildCtx(b.build()), 2, 3)).toBeNull();
  });
  test("null per-player rows before capture are read as unknown players", () => {
    const b = new MatchBuilder(2);
    b.m.firstFullRound = 1;
    (b.m.rounds.equip as unknown[])[0] = null;
    (b.m.rounds.money as unknown[])[0] = null;
    const m = validateMatch(JSON.parse(JSON.stringify(b.m)), "t");
    expect(m.rounds.equip[0]).toEqual(new Array(10).fill(null));
  });
});
