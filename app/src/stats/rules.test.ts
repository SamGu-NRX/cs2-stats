import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { countMatch } from "./counters";
import { teamBuyType } from "./economy";
import { rating2 } from "./rating";
import { computeTrades, detectClutches, kastRound, openingKill } from "./rules";
import { CT, T, type KillState } from "./schema";
import { computeSwing } from "./swing";
import { MatchBuilder } from "./testing/build";
import { stubModel, STUB_TABLE } from "./winprob";

// Players 0..4 are CT, 5..9 are T; player 0 is the human.
const count = (b: MatchBuilder) => {
  const ctx = buildCtx(b.build());
  const trades = computeTrades(ctx);
  return { ctx, trades, ...countMatch(ctx, trades, []) };
};

describe("opening duel", () => {
  test("first enemy kill of the round is the opening; team kills before it are skipped", () => {
    const b = new MatchBuilder().kill(0, 3, 1, 2).kill(0, 5, 6, 0).kill(0, 8, 3, 6);
    const { ctx, counters } = count(b);
    expect(openingKill(ctx.killsByRound.get(0)!)?.victim).toBe(0);
    expect(counters[6].openingKills).toBe(1);
    expect(counters[0].openingDeaths).toBe(1);
    expect(counters[1].openingKills).toBe(0);
    expect(counters[3].openingKills).toBe(0);
  });
  test("a world death first takes the opening: victim gets the opening death, nobody the kill", () => {
    const { counters } = count(new MatchBuilder().kill(0, 2, null, 7, { weapon: "world" }).kill(0, 4, 0, 6));
    expect(counters[7].openingDeaths).toBe(1);
    expect(counters[0].openingKills).toBe(0);
  });
  test("win after opening kill counts only rounds the opener's side won", () => {
    const b = new MatchBuilder(2).round(1, T, "elim").kill(0, 2, 0, 5).kill(1, 2, 0, 6);
    expect(count(b).counters[0]).toMatchObject({ openingKills: 2, openingWins: 1 });
  });
});

describe("trades (5 s, as CS Demo Manager)", () => {
  test("killing the killer within 5 s trades the earlier death", () => {
    const { counters } = count(new MatchBuilder().kill(0, 10, 5, 1).kill(0, 14.9, 2, 5));
    expect(counters[2].tradeKills).toBe(1);
    expect(counters[1].tradedDeaths).toBe(1);
  });
  test("exactly 5 s later is too late", () => {
    const { counters } = count(new MatchBuilder().kill(0, 10, 5, 1).kill(0, 15, 2, 5));
    expect(counters[2].tradeKills).toBe(0);
    expect(counters[1].tradedDeaths).toBe(0);
  });
  test("one kill can trade two deaths but is one trade kill", () => {
    const { counters } = count(new MatchBuilder().kill(0, 10, 5, 1).kill(0, 11, 5, 3).kill(0, 12, 0, 5));
    expect(counters[0].tradeKills).toBe(1);
    expect(counters[1].tradedDeaths).toBe(1);
    expect(counters[3].tradedDeaths).toBe(1);
  });
  test("trades never cross rounds", () => {
    const b = new MatchBuilder(2).kill(0, 99, 5, 1).kill(1, 0.5, 2, 5);
    expect(count(b).counters[2].tradeKills).toBe(0);
  });
  test("a world death of the killer is not a trade", () => {
    const { counters } = count(new MatchBuilder().kill(0, 10, 5, 1).kill(0, 11, null, 5, { weapon: "world" }));
    expect(counters[1].tradedDeaths).toBe(0);
  });
});

describe("KAST", () => {
  const kast = (b: MatchBuilder, pi: number) => {
    const { ctx, trades } = count(b);
    const pos = new Map(ctx.kills.map((k, j) => [k, j]));
    return kastRound(ctx.killsByRound.get(0)!, pi, (k) => trades.tradeDeath[pos.get(k)!]);
  };
  test("kill, assist, survival and traded death each count", () => {
    const b = new MatchBuilder().kill(0, 5, 0, 5).kill(0, 6, 1, 6, { assister: 2 }).kill(0, 7, 7, 3).kill(0, 8, 4, 7).kill(0, 30, 8, 4);
    expect(kast(b, 0)).toBe(true); // kill
    expect(kast(b, 2)).toBe(true); // assist
    expect(kast(b, 3)).toBe(true); // traded: 4 killed 7 one second later
    expect(kast(b, 1)).toBe(true); // kill
    expect(kast(b, 9)).toBe(true); // survived
    expect(kast(b, 4)).toBe(true); // had a kill before dying
    expect(kast(b, 5)).toBe(false); // died, untraded, nothing else
  });
  test("a team-killed player counts as surviving, as in CS Demo Manager", () => {
    expect(kast(new MatchBuilder().kill(0, 5, 1, 2), 2)).toBe(true);
  });
  test("a world death without other events is not KAST", () => {
    expect(kast(new MatchBuilder().kill(0, 5, null, 2, { weapon: "world" }), 2)).toBe(false);
  });
});

describe("clutches", () => {
  test("last CT alive against five, wins", () => {
    const b = new MatchBuilder().kill(0, 1, 5, 1).kill(0, 2, 5, 2).kill(0, 3, 6, 3).kill(0, 4, 7, 4).kill(0, 5, 0, 5).kill(0, 6, 0, 6).kill(0, 7, 0, 7).kill(0, 8, 0, 8).kill(0, 9, 0, 9);
    const c = detectClutches(buildCtx(b.build()), 0);
    expect(c).toEqual([
      { ri: 0, player: 0, side: CT, opponents: 5, won: true, survived: true, kills: 5 },
      // once both sides are down to one, the last T is in a 1v1 too (and loses it)
      { ri: 0, player: 9, side: T, opponents: 1, won: false, survived: false, kills: 0 },
    ]);
  });
  test("1vX that turns into a 1v1 gives the other side's last player a 1v1", () => {
    const b = new MatchBuilder().round(0, T, "elim")
      .kill(0, 1, 5, 1).kill(0, 2, 5, 2).kill(0, 3, 5, 3).kill(0, 4, 5, 4) // CT 0 alone vs 5
      .kill(0, 5, 0, 6).kill(0, 6, 0, 7).kill(0, 7, 0, 8).kill(0, 8, 0, 9) // 1v1: 0 vs 5
      .kill(0, 9, 5, 0);
    const c = detectClutches(buildCtx(b.build()), 0);
    expect(c.map((x) => [x.player, x.opponents, x.won, x.survived, x.kills])).toEqual([[0, 5, false, false, 4], [5, 1, true, true, 1]]);
    const { counters } = count(b);
    expect(counters[0].clutchN).toEqual([0, 0, 0, 0, 1]);
    expect(counters[5].clutchW).toEqual([1, 0, 0, 0, 0]);
    expect(counters[5].clutchPoints).toBe(1);
  });
});

describe("multi-kills", () => {
  test("rounds are counted by exact kill count; team kills do not count", () => {
    const b = new MatchBuilder(3).kill(0, 1, 0, 5).kill(0, 2, 0, 6).kill(1, 1, 0, 5).kill(1, 2, 0, 6).kill(1, 3, 0, 7).kill(2, 1, 0, 1).kill(2, 2, 0, 5);
    const c = count(b).counters[0];
    expect(c.kc).toEqual([0, 1, 1, 1, 0, 0]);
    expect(c.multiKillRounds).toBe(2);
    expect(c.kills).toBe(6);
  });
});

describe("rating 2.0 approximation", () => {
  test("known inputs", () => {
    // KPR 1, DPR 0.5, APR 0.2, ADR 90, KAST 80 % → impact 1.804 → rating 1.5512588
    expect(rating2({ rounds: 10, kills: 10, deaths: 5, assists: 2, dmg: 900, kastRounds: 8 })).toBeCloseTo(1.5512588, 6);
  });
  test("floored at zero", () => {
    expect(rating2({ rounds: 10, kills: 0, deaths: 10, assists: 0, dmg: 0, kastRounds: 0 })).toBe(0);
  });
});

describe("economy (CS Demo Manager thresholds)", () => {
  const n = 10;
  const buy = (ri: number, equip: number, money = 1000, prevWin: 2 | 3 = 3, side: 2 | 3 = 3) => {
    const b = new MatchBuilder(ri + 1);
    for (let r = 0; r < ri; r++) b.round(r, prevWin, "elim");
    b.round(ri, 3, "elim", { equip: new Array(n).fill(equip), money: new Array(n).fill(money) });
    return teamBuyType(buildCtx(b.build()), ri, side);
  };
  test("pistol rounds", () => {
    expect(buy(0, 5000)).toBe("pistol");
    expect(buy(12, 5000)).toBe("pistol");
  });
  test("eco ≤ $1,000 per player", () => {
    expect(buy(1, 1000)).toBe("eco");
    expect(buy(1, 1001)).toBe("semi");
  });
  test("full ≥ $4,500 CT, ≥ $4,000 T", () => {
    expect(buy(1, 4500)).toBe("full");
    expect(buy(1, 4499)).toBe("semi");
    expect(buy(1, 4000, 1000, 3, 2)).toBe("full");
  });
  test("force-buy after a lost round with < $400 per player left", () => {
    expect(buy(1, 3000, 399, 2)).toBe("force-buy");
    expect(buy(1, 3000, 400, 2)).toBe("semi");
    expect(buy(1, 3000, 0, 3)).toBe("semi");
  });
  test("unknown equipment gives no type", () => {
    const b = new MatchBuilder(2);
    b.round(1, 3, "elim", { equip: [null, ...new Array(9).fill(3000)] });
    expect(teamBuyType(buildCtx(b.build()), 1, 3)).toBeNull();
  });
});

describe("saves", () => {
  test("alive at the end of a lost round with more than $1,000 equipment", () => {
    const b = new MatchBuilder(1).round(0, T, "elim", { equip: [5000, 900, ...new Array(8).fill(5000)] });
    for (const v of [2, 3, 4]) b.kill(0, v, 5, v);
    const c = count(b).counters;
    expect(c[0].saves).toBe(1);
    expect(c[1].saves).toBe(0); // eco gear: not a save
    expect(c[5].saves).toBe(0); // won the round
  });
});

describe("round swing", () => {
  const s0: KillState = [5, 5, 500, 500, 20000, 20000, 0, null];
  test("stub table is symmetric and alive-count based", () => {
    expect(STUB_TABLE[5][5]).toBe(0.5);
    expect(STUB_TABLE[5][4]).toBeCloseTo(25 / 41, 12);
    expect(STUB_TABLE[0][3]).toBe(0);
  });
  test("victim is charged the full drop; the killer side splits it by damage share", () => {
    const b = new MatchBuilder().kill(0, 10, 5, 1, { state: s0 }).damage(0, 8, 6, 1, 40).damage(0, 10, 5, 1, 60);
    const ctx = buildCtx(b.build());
    const [s] = computeSwing(ctx, stubModel);
    const drop = 0.5 - 16 / 41; // CT 5v5 → 4v5
    expect(s.before).toBe(0.5);
    expect(s.after).toBeCloseTo(16 / 41, 12);
    const credit = new Map(s.credits);
    expect(credit.get(1)).toBeCloseTo(-drop, 12);
    expect(credit.get(5)).toBeCloseTo(0.6 * drop, 12);
    expect(credit.get(6)).toBeCloseTo(0.4 * drop, 12);
  });
  test("no damage logged: the killer gets it all", () => {
    const ctx = buildCtx(new MatchBuilder().kill(0, 10, 0, 5, { state: s0 }).build());
    const [s] = computeSwing(ctx, stubModel);
    expect(new Map(s.credits).get(0)).toBeCloseTo(0.5 - 16 / 41, 12);
  });
});
