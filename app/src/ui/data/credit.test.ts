// The takeover credit on one stat line (credit.ts credited): what "you" moves, what it leaves, and
// the saved choice. The derive side, which counts the moved play, is stats/takeover-credit.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyMeasures, type Measures } from "../../stats/facts";
import { credited, creditedBest, creditedRow, hasTakeover, moves, shiftOf } from "./credit";
import { lineOf } from "./engine";

/** A line over 10 rounds with these measures, and values as the worker gives them. */
function line(over: Partial<Measures>) {
  const m = { ...emptyMeasures(), rounds: 10, ...over };
  const v = { adr: m.dmg / 10, kpr: m.kills / 10, dpr: m.deaths / 10, hs: m.kills ? (100 * m.hsKills) / m.kills : null, kast: 70, mk: 20, swing: 1.5 };
  return lineOf({ m, v }, 1.05);
}

// The user drove a bot after dying: 2 kills (1 a headshot), 2 deaths and 150 damage made in its body.
const YOU = line({ kills: 5, hsKills: 2, deaths: 6, dmg: 700, assists: 3, kast: 7, takeoverKills: 2, takeoverHsKills: 1, takeoverDeaths: 2, takeoverDmg: 150 });
const BOT = line({ kills: 4, hsKills: 1, deaths: 5, dmg: 600, assists: 1, kast: 6, drivenKills: 2, drivenHsKills: 1, drivenDeaths: 2, drivenDmg: 150 });

describe("credited", () => {
  it("leaves every line as the game credits it under bot", () => {
    // fails if bot, the default, changes a number
    for (const l of [YOU, BOT]) {
      const c = credited(l, "bot");
      expect([c.kills, c.deaths, c.diff, c.adr, c.kpr, c.dpr, c.hs, c.m]).toEqual([l.kills, l.deaths, l.diff, l.adr, l.kpr, l.dpr, l.hs, l.m]);
      expect(c.moved).toBe(false);
    }
    // the shift is known under either credit, so a number can mark its change when the switch flips
    expect(credited(YOU, "bot").shift).toEqual({ kills: 2, hsKills: 1, deaths: 2, dmg: 150 });
  });

  it("moves kills, headshot kills, deaths and damage from the bot's line to the driver's under you", () => {
    // fails if a figure read from the moved counts keeps the game's value, or the bot keeps the play
    const you = credited(YOU, "you"), bot = credited(BOT, "you");
    expect([you.kills, you.deaths, you.diff, you.adr, you.kpr, you.dpr, you.hs]).toEqual([7, 8, -1, 85, 0.7, 0.8, (100 * 3) / 7]);
    expect([bot.kills, bot.deaths, bot.diff, bot.adr, bot.kpr, bot.dpr, bot.hs]).toEqual([2, 3, -1, 45, 0.2, 0.3, 0]);
    expect([you.v.adr, you.v.kpr, you.v.dpr, you.v.hs, bot.v.adr]).toEqual([85, 0.7, 0.8, (100 * 3) / 7, 45]);
    expect([you.moved, bot.moved, you.game, bot.game]).toEqual([true, true, YOU, BOT]);
  });

  it("keeps the team's totals", () => {
    // fails if what leaves the bot does not arrive at the driver
    const sum = (k: "kills" | "hsKills" | "deaths" | "dmg", c: "bot" | "you") => credited(YOU, c).m[k] + credited(BOT, c).m[k];
    for (const k of ["kills", "hsKills", "deaths", "dmg"] as const) expect(sum(k, "you")).toBe(sum(k, "bot"));
  });

  it("never moves assists, KAST, rating, multi-kills or swing", () => {
    // fails if a per-round model figure, which assumes one life a round, follows the takeover
    const you = credited(YOU, "you");
    expect([you.assists, you.m.assists, you.kast, you.m.kast, you.rating, you.mk, you.swing, you.v.kast]).toEqual([3, 3, 70, 7, 1.05, 20, 0.015, 70]);
  });

  it("changes nothing on a line without takeover play", () => {
    // fails if a line with no takeover measures is marked or recomputed
    const plain = line({ kills: 3, deaths: 4, dmg: 500 });
    expect(hasTakeover(plain.m)).toBe(false);
    expect(credited(plain, "you")).toMatchObject({ kills: 3, deaths: 4, adr: 50, shift: null, moved: false });
  });

  it("gives no rate over no rounds", () => {
    // fails if a line with no rounds reads 0 or NaN for ADR, KPR or DPR
    const c = credited(line({ rounds: 0, takeoverKills: 1, takeoverDmg: 40, takeoverDeaths: 1 }), "you");
    expect([c.kills, c.deaths, c.adr, c.kpr, c.dpr, c.hs]).toEqual([1, 1, null, null, null, 0]);
  });

  it("keeps a rate the coverage rule hid hidden, and moves only the rates the line shows", () => {
    // a thin log's entry keeps its counts and hides every rate (engine.ts coverEntry). Fails if "You"
    // brings ADR, KPR, DPR or HS% back from its counts, or marks a hidden rate as moved (+/- does not
    // move here: the takeover adds two kills and two deaths)
    const thin = { ...YOU, adr: null, kpr: null, dpr: null, hs: null, v: Object.fromEntries(Object.keys(YOU.v).map((k) => [k, null])) };
    const c = credited(thin, "you");
    expect([c.kills, c.deaths, c.adr, c.kpr, c.dpr, c.hs, c.v.adr]).toEqual([7, 8, null, null, null, null, null]);
    expect((["kills", "deaths", "diff", "adr", "kpr", "dpr", "hs"] as const).map((f) => moves(c, f))).toEqual([true, true, false, false, false, false, false]);
  });

  it("gives a rate that was missing only for want of a denominator once the moved counts give one", () => {
    // HS% over no kills is not hidden, just undefined: fails if two kills made in a bot's body (one a
    // headshot) leave it a dash, or if it is not marked as moved
    const none = line({ kills: 0, hsKills: 0, deaths: 3, dmg: 100, takeoverKills: 2, takeoverHsKills: 1 });
    expect(none.hs).toBeNull();
    const c = credited(none, "you");
    expect([c.hs, moves(c, "hs")]).toEqual([50, true]);
  });

  it("marks only the figures whose value changes, not every figure a shift touches", () => {
    // 4 kills (2 headshots) of his own and, in a bot's body, 2 kills (1 a headshot) and 2 deaths: HS%
    // is 50% either way, and +/- is the same. Fails if HS% or +/- is marked as moved (CodeRabbit,
    // Home.tsx: the tile showed "game's count" beside an unchanged HS%)
    const l = credited(line({ kills: 4, hsKills: 2, deaths: 5, dmg: 500, takeoverKills: 2, takeoverHsKills: 1, takeoverDeaths: 2 }), "you");
    expect([l.hs, l.game.hs]).toEqual([50, 50]);
    expect((["kills", "deaths", "diff", "hs", "kpr", "dpr", "adr"] as const).filter((f) => moves(l, f))).toEqual(["kills", "deaths", "kpr", "dpr"]);
    // under Bot the line says the same, so a flip back can fade exactly these
    expect([...credited(line({ kills: 4, hsKills: 2, deaths: 5, dmg: 500, takeoverKills: 2, takeoverHsKills: 1, takeoverDeaths: 2 }), "bot").changed].sort()).toEqual(["deaths", "dpr", "kills", "kpr"]);
  });

  it("reads absent measures, as cached facts leave zeros out, as none", () => {
    // fails if a missing measure is read as NaN
    expect(shiftOf({ takeoverKills: 1 })).toEqual({ kills: 1, hsKills: 0, deaths: 0, dmg: 0 });
    expect(hasTakeover({ drivenDeaths: 1 })).toBe(true);
    expect(hasTakeover({ kills: 9 })).toBe(false);
  });
});

describe("the saved choice", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it("starts on bot, is kept, and reads anything else saved as bot", async () => {
    // fails if the default is not the game's credit, or a saved choice is not read back
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.resetModules();
    const a = await import("./credit");
    expect(a.creditNow()).toBe("bot");
    expect(a.setCredit("you")).toBeNull();
    expect(store.get("cs2stats.takeoverCredit")).toBe("you");
    vi.resetModules();
    expect((await import("./credit")).creditNow()).toBe("you");
    store.set("cs2stats.takeoverCredit", "both");
    vi.resetModules();
    expect((await import("./credit")).creditNow()).toBe("bot");
  });

  it("applies a choice storage refuses for the session, and says so", async () => {
    // fails if a refused write throws, leaves the old choice, or passes silently
    vi.stubGlobal("localStorage", { getItem: () => { throw new DOMException("denied", "SecurityError"); }, setItem: () => { throw new DOMException("full", "QuotaExceededError"); } });
    vi.resetModules();
    const c = await import("./credit");
    expect(c.creditNow()).toBe("bot");
    expect(c.setCredit("you")).toMatch(/could not be saved/);
    expect(c.creditNow()).toBe("you");
  });
});

describe("creditedBest", () => {
  it("gives the best \"You\" chose under you, and the game's under bot, with the game's beside it", () => {
    // fails if a record under "You" keeps the game's value or match, or one "You" leaves alone changes
    const kills = { id: "kills", value: 10, file: "a", you: { value: 14, file: "b" } };
    expect(creditedBest(kills, "you")).toMatchObject({ value: 14, file: "b", game: kills });
    expect(creditedBest(kills, "bot")).toMatchObject({ value: 10, file: "a" });
    expect(creditedBest({ id: "assists", value: 4, file: "a" }, "you")).toMatchObject({ value: 4, file: "a" });
  });
});

describe("creditedRow", () => {
  it("reads a comparison row's figures under You where the worker gave them, and the game's otherwise", () => {
    // fails if a row keeps the game's figures under You, or one without "You" figures is marked moved
    const row = { id: "adr", value: 70, before: 80, delta: -10, direction: "worse" as const, you: { value: 80, before: 80, delta: 0, direction: "same" as const } };
    expect(creditedRow(row, "you")).toMatchObject({ value: 80, delta: 0, direction: "same", moved: true });
    expect(creditedRow(row, "bot")).toMatchObject({ value: 70, delta: -10, moved: false });
    const kast: { id: string; value: number; before: number; you?: object } = { id: "kast", value: 70, before: 70 };
    expect(creditedRow(kast, "you")).toMatchObject({ value: 70, moved: false });
  });
});
