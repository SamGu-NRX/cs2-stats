import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { deriveMatch } from "./derive";
import { hltvCounts, SUBSTATS, TRADE_DISTANCE } from "./hltv";
import { buildRoundDetails } from "./rounds";
import { MatchBuilder } from "./testing/build";
import { loadPluginMatch, PLUGIN_MATCHES } from "./testing/load";
import type { WinModel } from "./winprob";

describe("HLTV sub-stat counts on a built round", () => {
  // CT 0-4, T 5-9. T5 hurts CT1 first, CT0 then kills T5 clean, CT1 kills T6 after T6 hurt him.
  const b = new MatchBuilder();
  b.damage(0, 5, 5, 1, 20);
  b.damage(0, 6, 0, 5, 100).kill(0, 6, 0, 5, { state: [5, 5, 500, 500, 23500, 23500, 0, null] });
  b.damage(0, 8, 6, 1, 30).damage(0, 9, 1, 6, 100).kill(0, 9, 1, 6, { state: [5, 4, 480, 400, 23500, 23500, 0, null] });
  b.kill(0, 12, 7, 2, { state: [5, 3, 450, 300, 23500, 23500, 0, null] });
  const p = b.m.pos;
  const at = (pi: number, secs: number, x: number) => {
    p.ri.push(0); p.tick.push(b.t(0, secs)); p.pi.push(pi); p.x.push(x); p.y.push(0); p.z.push(0); p.place.push(null); p.alive.push(true);
  };
  at(2, 12, 0); at(3, 12, TRADE_DISTANCE - 1); at(4, 12, TRADE_DISTANCE + 1);
  const m = b.build();
  const fake: WinModel = { kind: "model", label: "test", winProbability: (s) => 0.5 + 0.1 * (s.ctAlive - s.tAlive) };
  const h = hltvCounts(buildCtx(m), buildRoundDetails(m, fake));

  test("perfect kills: the victim had not hurt the killer", () => {
    expect([h[0].perfectKills, h[1].perfectKills, h[7].perfectKills]).toEqual([1, 0, 1]);
  });
  test("first duel rank and time", () => {
    // first enemy damage: 5 and 1 at 5 s (rank 1), 0 at 6 s (rank 3), 6 at 8 s (rank 4)
    expect([h[5].duelRankSum, h[1].duelRankSum, h[0].duelRankSum, h[6].duelRankSum]).toEqual([1, 1, 3, 4]);
    expect(h[0].duelTimeSum).toBe(6);
  });
  test("tradeable death and trade opportunities by distance", () => {
    expect([h[2].deathsWithPos, h[2].tradeableDeaths]).toEqual([1, 1]);
    expect([h[3].tradeOpps, h[4].tradeOpps]).toEqual([1, 0]);
  });
  test("round win shares split the winners' positive swing", () => {
    const won = [0, 1, 2, 3, 4].map((pi) => h[pi]);
    expect(won.every((x) => x.winRounds === 1)).toBe(true);
    expect(won.reduce((s, x) => s + x.rws, 0)).toBeCloseTo(1, 12);
    expect(h[5].winRounds).toBe(0);
  });
  test("gun hits count enemy damage with a gun", () => {
    expect([h[0].gunHits, h[1].gunHits, h[5].gunHits]).toEqual([1, 1, 1]);
  });
});

describe("sub-stat registry", () => {
  test("every entry has a status, a definition and a unique id", () => {
    const ids = new Set(SUBSTATS.map((s) => s.id));
    expect(ids.size).toBe(SUBSTATS.length);
    for (const s of SUBSTATS) {
      expect(["exact", "approx", "unavailable"]).toContain(s.status);
      expect(s.def.length).toBeGreaterThan(20);
    }
  });
  test("on a plugin recording, every available stat has a value for the human", async () => {
    const f = PLUGIN_MATCHES[1];
    const v = deriveMatch(await loadPluginMatch(f), f);
    const c = v.players[v.human].c;
    const missing = SUBSTATS.filter((s) => s.status !== "unavailable" && s.value(c) === null).map((s) => s.id);
    expect(missing).toEqual([]);
  });
});
