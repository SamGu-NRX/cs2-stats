// The converted legacy matches against fixtures/reference_matchpage.py, whose numbers were checked
// against the game. Run it with: python -I reference_matchpage.py <snapshot> out.html events_two_matches.jsonl
import { beforeAll, describe, expect, test } from "vitest";
import { deriveMatch, type MatchView } from "./derive";
import { loadSample, SAMPLE_1714, SAMPLE_1809 } from "./testing/load";

describe("18:09 match", () => {
  let v: MatchView;
  beforeAll(async () => {
    v = deriveMatch(await loadSample(SAMPLE_1809), SAMPLE_1809);
  });
  const p = (name: string) => v.players.find((x) => x.name === name)!;

  test("score 8–13", () => {
    expect(v.score).toEqual({ us: 8, them: 13 });
    expect(v.result).toBe("L");
    expect(v.captured).toBe(21);
  });

  // Damage: the converter takes each hit's HP drop, which gives the game's own 2750 (ADR 131.0).
  // The live plugin stores player_hurt damage capped at the victim's HP, which truncates fractions:
  // for this match that would be 2735 (ADR 130.2). The app shows whatever the file's dmg column holds.
  test("you: 25–11, ADR 131.0, KAST 81.0 %, rating 1.85", () => {
    const h = v.players[v.human];
    expect(h.name).toBe("exzotikgaming6");
    expect([h.c.kills, h.c.deaths]).toEqual([25, 11]);
    expect(h.adr.toFixed(1)).toBe("131.0");
    expect(h.kast.toFixed(1)).toBe("81.0");
    expect(h.rating.toFixed(2)).toBe("1.85");
  });

  test("every player's line equals the reference generator", () => {
    // name: K, D, ADR, KAST, rating (reference_matchpage.py output for this snapshot)
    const ref: [string, number, number, string, string, string][] = [
      ["exzotikgaming6", 25, 11, "131.0", "81.0", "1.85"], ["Rip", 23, 16, "112.2", "85.7", "1.61"],
      ["Gunner", 17, 15, "93.3", "61.9", "1.16"], ["Shark", 15, 13, "92.5", "61.9", "1.14"],
      ["Stone", 16, 14, "75.2", "66.7", "1.12"], ["Buckshot", 12, 15, "57.9", "61.9", "0.84"],
      ["Delrow", 10, 13, "50.4", "66.7", "0.82"], ["Ricksaw", 8, 14, "35.2", "61.9", "0.61"],
      ["Crusher", 9, 16, "51.2", "52.4", "0.59"], ["Rebel", 6, 15, "49.6", "57.1", "0.52"],
    ];
    for (const [name, k, d, adr, kast, rating] of ref) {
      const x = p(name);
      expect([name, x.c.kills, x.c.deaths, x.adr.toFixed(1), x.kast.toFixed(1), x.rating.toFixed(2)]).toEqual([name, k, d, adr, kast, rating]);
    }
  });

  test("trade kills: Buckshot 6, Rip 4, Delrow 3, you 2 (CS Demo Manager counting)", () => {
    expect(p("Buckshot").c.tradeKills).toBe(6);
    expect(p("Rip").c.tradeKills).toBe(4);
    expect(p("Delrow").c.tradeKills).toBe(3);
    // The reference reports 3 for you because it counts avenged deaths: in round 7 one kill on
    // Gunner avenged both Rip and Rebel. CS Demo Manager counts that as one trade kill.
    expect(p("exzotikgaming6").c.tradeKills).toBe(2);
    const r7 = v.rounds[6];
    const kGunner = r7.kills.find((k) => k.killer === v.human && v.players[k.victim].name === "Gunner")!;
    expect(kGunner.tradeKill).toBe(true);
    const avenged = r7.kills.filter((k) => k.killer === kGunner.victim && k.tradeDeath).map((k) => v.players[k.victim].name);
    expect(avenged.sort()).toEqual(["Rebel", "Rip"]);
  });

  test("round strip: winner, how, and players left equal the game's AliveCT/AliveT", () => {
    // From the snapshot: RoundResults codes and AliveCT/AliveT, taking the winning side's count.
    const codes = [4, 3, 1, 3, 5, 5, 5, 5, 5, 3, 5, 1, 1, 3, 5, 6, 5, 5, 5, 5, 5];
    const aliveCT = [1, 4, 2, 5, 0, 0, 0, 0, 0, 1, 0, 3, 4, 4, 0, 1, 0, 0, 0, 0, 0];
    const aliveT = [1, 0, 0, 0, 5, 3, 3, 5, 5, 0, 5, 0, 0, 0, 3, 1, 3, 2, 1, 2, 4];
    const how = { 1: "elim", 3: "defuse", 4: "time", 5: "elim", 6: "bomb" } as Record<number, string>;
    v.rounds.forEach((r, i) => {
      const ctWon = [1, 3, 4].includes(codes[i]);
      expect([i, r.winSide, r.how, r.left]).toEqual([i, ctWon ? 3 : 2, how[codes[i]], ctWon ? aliveCT[i] : aliveT[i]]);
    });
  });

  test("detailed stats agree with the game's own match totals for you", () => {
    const h = v.players[v.human].c;
    // snapshot: Enemy2Ks 4, Enemy3Ks 1, Enemy4Ks 2, EntryWins 3 of EntryCount 4, HeadShotKills 12, UtilityDamage 98, I1v2Count 1
    expect(h.kc.slice(2)).toEqual([4, 1, 2, 0]);
    expect([h.openingKills, h.openingDeaths]).toEqual([3, 1]);
    expect(h.hsKills).toBe(12);
    expect(h.utilDmg).toBe(98);
    expect(h.assists).toBe(6);
  });
});

describe("17:14 match (kill log starts in round 16)", () => {
  test("score, round count and your line come from all 16 rounds", async () => {
    const v = deriveMatch(await loadSample(SAMPLE_1714), SAMPLE_1714);
    expect(v.score).toEqual({ us: 13, them: 3 });
    expect(v.nRounds).toBe(16);
    expect(v.statRounds).toBe(16);
    const h = v.players[v.human];
    expect([h.c.kills, h.c.deaths]).toEqual([18, 9]);
    expect(h.c.rounds).toBe(16);
    // reference_matchpage.py for this snapshot: ADR 127.2, KAST 81.2 % (no trades, since the log is partial).
    // KAST is 13 of 16 rounds = 81.25 %: Python prints that as 81.2 (round half to even), toFixed as 81.3.
    expect(h.adr.toFixed(1)).toBe("127.2");
    expect(h.c.kastRounds).toBe(13);
  });
  test("event-based stats keep to the one round with the kill log", async () => {
    const v = deriveMatch(await loadSample(SAMPLE_1714), SAMPLE_1714);
    expect(v.firstFullRound).toBe(15);
    expect(v.captured).toBe(1);
    expect(v.players[v.human].c.fullRounds).toBe(1);
    expect(v.rounds.filter((r) => r.captured).map((r) => r.ri)).toEqual([15]);
    expect(v.rounds.filter((r) => r.lite).length).toBe(15);
    // players left in lite rounds come from the game's AliveCT/AliveT
    expect(v.rounds[0].left).toBe(4);
  });
});
