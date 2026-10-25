// Known answers for the issues found in the independent review (Sol, 2026-10-24).
import { describe, expect, test } from "vitest";
import { shotsFor, aimAggregate } from "./aim";
import { buildCtx } from "./context";
import { countMatch } from "./counters";
import { deriveMatch, reconSummary } from "./derive";
import { computeTrades, detectClutches, openingKill } from "./rules";
import { MatchBuilder } from "./testing/build";
import { validateMatch } from "./schema";
import { planSync } from "../worker/plan";

// Players 0..4 are CT, 5..9 are T; player 0 is the human.
const counters = (b: MatchBuilder) => {
  const ctx = buildCtx(b.build());
  return countMatch(ctx, computeTrades(ctx)).counters;
};

describe("1. flash assists count as assists and for KAST", () => {
  test("a flash assister who then dies untraded keeps the assist and the KAST round", () => {
    const b = new MatchBuilder().kill(0, 5, 2, 6).kill(0, 30, 7, 0);
    b.m.kills.assister[0] = null;
    b.m.kills.flashAssister[0] = 0; // separate column, as the plugin writes it
    const c = counters(b)[0];
    expect(c.assists).toBe(1);
    expect(c.kastRounds).toBe(1);
  });
  test("the same player in both columns is one assist", () => {
    const b = new MatchBuilder().kill(0, 5, 2, 6, { assister: 0, flash: 0 });
    expect(counters(b)[0].assists).toBe(1);
  });
});

describe("2. visibility gating", () => {
  test("visTarget 0 is not spotted; adjusted needs smoke 0 and pen 0, unknowns set aside", () => {
    const b = new MatchBuilder();
    for (let i = 0; i < 5; i++) b.shot(0, 100 + i * 100, { hit: 2 });
    const s = b.m.aim.shots;
    s.visTarget = [0, 1, 1, 1, 1];
    s.smoke = [0, 0, 1, 0, null];
    s.pen = [0, 0, 0, 1, 0];
    const r = shotsFor(aimAggregate(b.build())!, "all", "all");
    expect([r.spotted, r.spottedHits]).toEqual([4, 4]);
    expect([r.adjusted, r.adjUnknown]).toEqual([1, 1]); // shot 2 counts, shot 5 unknown, 3 smoke and 4 wallbang out
    expect(r.onTarget).toBe(5); // first-bullet and spray use any target
  });
});

describe("3. partial rounds", () => {
  test("rounds in recon.partial leave event stats, aim and denominators", () => {
    const b = new MatchBuilder(2).kill(0, 5, 0, 5).kill(1, 5, 0, 6).shot(0, 100).shot(1, b0(1));
    b.m.recon = { partial: [1] };
    const m = b.build();
    const v = deriveMatch(m, "t");
    const c = v.players[0].c;
    expect([c.fullRounds, c.openingKills, c.rounds]).toEqual([1, 1, 1]); // no basic totals for round 1, so it has no stats at all
    expect(v.rounds[1].captured).toBe(false);
    expect(shotsFor(aimAggregate(m)!, "all", "all").shots).toBe(1);
  });
});
function b0(ri: number) { return 10_000 + ri * 64 * 200 + 100; }

describe("4. reconciliation", () => {
  test("player counts, not booleans; 'matches' needs every round fully checked", () => {
    const b = new MatchBuilder(3);
    b.m.recon = { rounds: { ri: [0, 1, 2], checked: [10, 10, 9], kOk: [], dOk: [], aOk: [], dmgOk: [], missing: [] } };
    expect(reconSummary(b.build())).toMatchObject({ rounds: 3, fullyChecked: 2, matches: false });
    b.m.recon.rounds!.checked = [10, 10, 10];
    expect(reconSummary(b.build())!.matches).toBe(true);
  });
  test("newer checkedPlayers / expectedPlayers shape", () => {
    const b = new MatchBuilder(2);
    b.m.recon = { rounds: { ri: [0, 1], checked: [0, 0], checkedPlayers: [8, 8], expectedPlayers: [8, 9], kOk: [], dOk: [], aOk: [], dmgOk: [], missing: [] } };
    expect(reconSummary(b.build())).toMatchObject({ fullyChecked: 1, matches: false });
  });
  test("no checks means no 'matches' claim", () => {
    const b = new MatchBuilder(2);
    b.m.recon = { rounds: { ri: [], checked: [], kOk: [], dOk: [], aOk: [], dmgOk: [], missing: [] } };
    expect(reconSummary(b.build())!.matches).toBe(false);
  });
});

describe("5. kill attribution (CS Demo Manager)", () => {
  test("opening skips suicides, freeze-time kills and kills by a player controlling a bot", () => {
    const b = new MatchBuilder().kill(0, 1, null, 6).kill(0, 2, 7, 1).kill(0, 3, 0, 8).kill(0, 4, 5, 2);
    b.m.kills.flags = [64, 128, 0, 0]; // suicide, freeze time
    b.m.kills.kBody = [null, null, 3, null]; // the human killed while in bot 3's body
    const ctx = buildCtx(b.build());
    expect(ctx.kills.length).toBe(3); // the freeze-time kill is not recorded at all
    expect(openingKill(ctx.killsByRound.get(0)!)?.killer).toBe(5);
    expect(counters(b)[0].kills).toBe(0); // the bot-controlled kill is not the human's
  });
  test("a suicide is a same-side death: KAST counts the player as surviving", () => {
    const b = new MatchBuilder().kill(0, 5, null, 6);
    b.m.kills.flags = [64];
    expect(counters(b)[6].kastRounds).toBe(1);
    // a world death (killer null, no flag 64) is a real death
    const w = new MatchBuilder().kill(0, 5, null, 6);
    expect(counters(w)[6].kastRounds).toBe(0);
  });
  test("a suicide within 5 s of the suicider's kill trades that death, as CS Demo Manager does", () => {
    const b = new MatchBuilder().kill(0, 5, 6, 1).kill(0, 7, null, 6);
    b.m.kills.flags = [0, 64];
    expect(counters(b)[1].tradedDeaths).toBe(1);
  });
  test("deaths while controlling a bot are not the player's", () => {
    const b = new MatchBuilder().kill(0, 5, 6, 0);
    b.m.kills.vBody = [2];
    expect(counters(b)[0].deaths).toBe(0);
  });
});

describe("6. clutches", () => {
  test("players dead at freeze end are not in the population", () => {
    const b = new MatchBuilder().kill(0, 2, 5, 1).kill(0, 3, 5, 2).kill(0, 4, 5, 3);
    b.m.rounds.alive0 = [[1, 1, 1, 1, 0, 1, 1, 1, 1, 1]]; // player 4 was not alive
    const c = detectClutches(buildCtx(b.build()), 0);
    expect(c[0]).toMatchObject({ player: 0, opponents: 5 });
  });
  test("a kill after round end cannot start a clutch", () => {
    const b = new MatchBuilder().round(0, 3, "elim", { dur: 10 });
    for (const v of [1, 2, 3, 4]) b.kill(0, 20 + v, 5, v); // all after the 10 s round end
    expect(detectClutches(buildCtx(b.build()), 0)).toEqual([]);
  });
  test("a disconnect removes the player like a death", () => {
    const b = new MatchBuilder().kill(0, 2, 5, 1).kill(0, 3, 5, 2).kill(0, 5, 6, 3);
    expect(detectClutches(buildCtx(b.build()), 0)).toEqual([]); // players 0 and 4 still alive
    b.m.leaves = { ri: [0], tick: [b.t(0, 4)], pi: [4], alive: [1] };
    expect(detectClutches(buildCtx(b.build()), 0)[0]).toMatchObject({ player: 0, opponents: 5 });
  });
});

describe("plugin 1.0.0 encodings", () => {
  test("delta-encoded positions decode per player by running sum", () => {
    const b = new MatchBuilder();
    b.m.pos = { enc: "delta", ri: [0, 0, 0, 0], tick: [1000, 2000, 16, 64], pi: [0, 5, 0, 5], x: [100, -50, 10, 5], y: [200, 0, -20, 5], z: [0, 0, 1, 0], place: [null, null, null, null], alive: [true, true, true, true] };
    const m = validateMatch(JSON.parse(JSON.stringify(b.m)), "t");
    expect([m.pos.tick, m.pos.x, m.pos.y, m.pos.z]).toEqual([[1000, 2000, 1016, 2064], [100, -50, 110, -45], [200, 0, 180, 5], [0, 0, 1, 0]]);
    expect(m.pos.enc).toBeUndefined();
  });
  test("recon rounds with checkedPlayers 0 are partial coverage", () => {
    const b = new MatchBuilder(2);
    b.m.recon = { rounds: { ri: [0, 1], checkedPlayers: [10, 0], expectedPlayers: [10, 10] }, partial: [1] };
    expect(reconSummary(b.build())).toMatchObject({ fullyChecked: 1, rounds: 2, matches: false });
  });
});

describe("7. cache invalidation", () => {
  test("a changed file is not reused, compared against the previous keys", () => {
    const prev = new Map([["a", "a|1|1"], ["b", "b|1|1"]]);
    const plan = planSync([{ file: "a", key: "a|1|1" }, { file: "b", key: "b|2|5" }, { file: "c", key: "c|1|1" }], prev);
    expect([...plan.reuse]).toEqual(["a"]);
    expect(plan.changed).toEqual(["b", "c"]);
  });
});
