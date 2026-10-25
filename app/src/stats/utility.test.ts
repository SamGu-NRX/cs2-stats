import { describe, expect, test } from "vitest";
import { buildCtx } from "./context";
import { countMatch } from "./counters";
import { computeTrades } from "./rules";
import { MatchBuilder } from "./testing/build";

// Players 0..4 are CT, 5..9 are T; player 0 is the human.
const util = (b: MatchBuilder, pi = 0) => {
  const ctx = buildCtx(b.build());
  return countMatch(ctx, computeTrades(ctx), []).counters[pi].util.ct;
};

describe("flashes", () => {
  test("effective = at least one enemy blinded ≥ 2.0 s; teammates and self are counted apart", () => {
    const b = new MatchBuilder()
      .grenade(0, 10, 0, "flash").blind(0, 10, 0, 5, 2000).blind(0, 10, 0, 6, 500).blind(0, 10, 0, 1, 1500).blind(0, 10, 0, 0, 800)
      .grenade(0, 30, 0, "flash").blind(0, 30, 0, 7, 1999);
    const u = util(b);
    expect(u.flashes).toBe(2);
    expect(u.enemiesFlashed).toBe(3);
    expect(u.enemyBlindMs).toBe(2000 + 500 + 1999);
    expect(u.effectiveFlashes).toBe(1);
    expect([u.teamFlashed, u.teamBlindMs, u.selfFlashed]).toEqual([1, 1500, 1]);
  });
  test("a flash leads to a kill when the blinded enemy dies to your team while still blind", () => {
    const b = new MatchBuilder()
      .blind(0, 10, 0, 5, 2000).kill(0, 11.9, 2, 5) // teammate kills while still blind
      .blind(0, 20, 0, 6, 1000).kill(0, 21.5, 1, 6) // blindness over at 21.0 s
      .blind(0, 30, 0, 7, 3000).kill(0, 31, 8, 7); // team kill by an enemy teammate: not ours
    expect(util(b).flashKills).toBe(1);
  });
  test("flash assists come from the kill's flash assister", () => {
    expect(util(new MatchBuilder().kill(0, 5, 2, 6, { flash: 0 })).flashAssists).toBe(1);
  });
});

describe("HE and fire", () => {
  test("damage, enemies hit per detonation, team damage", () => {
    const b = new MatchBuilder().grenade(0, 10, 0, "he")
      .damage(0, 10, 0, 5, 40, "hegrenade").damage(0, 10, 0, 6, 25, "hegrenade").damage(0, 10, 0, 1, 12, "hegrenade")
      .grenade(0, 20, 0, "molotov").damage(0, 21, 0, 7, 8, "inferno").damage(0, 22, 0, 7, 8, "inferno");
    const u = util(b);
    expect([u.hes, u.heDmg, u.heHits, u.heTeamDmg]).toEqual([1, 65, 2, 12]);
    expect([u.molotovs, u.fireDmg]).toEqual([1, 16]);
    expect(u.utilDmg).toBe(81);
  });
  test("utility is split by side", () => {
    const b = new MatchBuilder(13);
    b.round(12, 3, "elim", { side: [2, 2, 2, 2, 2, 3, 3, 3, 3, 3] });
    b.grenade(0, 5, 0, "smoke").grenade(12, 5, 0, "smoke").grenade(12, 6, 0, "smoke");
    const ctx = buildCtx(b.build());
    const c = countMatch(ctx, computeTrades(ctx), []).counters[0].util;
    expect([c.ct.smokes, c.t.smokes, c.ct.rounds, c.t.rounds]).toEqual([1, 2, 12, 1]);
  });
});


