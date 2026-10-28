// Moment clip windows (moments.ts) on seeded random rounds: player a kills some of c, d, e and f at random
// ticks, may die or disconnect at a random tick, and the clip's window must keep every rule at once. A seeded
// generator rather than a property-testing library: the rules are few, the inputs small, and a failure names
// its seed, so it reproduces exactly.
import { describe, expect, it } from "vitest";
import { DEATH_TAIL_S, scoreMoments } from "./moments";
import { FREEZE_END, oneRound, ROUND_END, TICK_RATE } from "./testing/match";

/** mulberry32: a small seeded PRNG, so every run checks the same rounds */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const players = { a: "CT", b: "CT", c: "T", d: "T", e: "T", f: "T" } as const;
const equip = Object.fromEntries(Object.keys(players).map((id) => [id, { equip_value_game: 4000 }]));

/** A random round: a's kills, then maybe a's death (by an enemy still alive) or alive disconnect. */
function randomRound(r: () => number) {
  const tick = () => FREEZE_END + Math.floor(r() * (ROUND_END + 4 * TICK_RATE - FREEZE_END));
  const victims = ["c", "d", "e", "f"].filter(() => r() < 0.7);
  const kills = victims.map((v) => ({ tick: tick(), killer: "a", victim: v })).sort((x, y) => x.tick - y.tick);
  const exit = r();
  const alive = ["c", "d", "e", "f"].filter((v) => !victims.includes(v));
  const deathTick = tick();
  const death = exit < 0.4 && alive.length ? [{ tick: deathTick, killer: alive[0], victim: "a" }] : [];
  const leaves = exit >= 0.4 && exit < 0.55 ? [{ tick: deathTick, steamid: "a", alive: true }] : [];
  const all = [...kills, ...death].sort((x, y) => x.tick - y.tick);
  return { facts: oneRound({ round: 5, players, player_rounds: equip, kills: all, leaves }), kills, exitTick: death.length || leaves.length ? deathTick : null };
}

describe("moment clip windows on random rounds", () => {
  it("keep every kill made while alive, draw only kills inside the window, and never run into the next round", () => {
    // fails if a clip has no length, starts before freeze end, runs past the round (or its last kill), cuts a
    // kill made before the player died or left, marks a kill as in the clip that lies outside its window, or
    // leaves out the note exactly when some kill falls after the clip's end
    const tail = Math.round(DEATH_TAIL_S * TICK_RATE);
    let checked = 0, clamped = 0, noted = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const { facts, kills, exitTick } = randomRound(r);
      for (const m of scoreMoments(facts, { player: "a" })) {
        checked++;
        const at = `seed ${seed}`;
        const last = Math.max(...kills.map((k) => k.tick));
        expect(m.endTick, at).toBeGreaterThan(m.startTick);
        expect(m.startTick, at).toBeGreaterThanOrEqual(FREEZE_END);
        expect(m.endTick, at).toBeLessThanOrEqual(Math.max(ROUND_END, last));
        if (exitTick !== null && exitTick >= m.startTick) expect(m.endTick, at).toBeLessThanOrEqual(exitTick + tail);
        for (const k of m.kills) {
          expect(k.inClip, at).toBe(k.tick >= m.startTick && k.tick <= m.endTick);
          if (exitTick === null || k.tick <= exitTick) expect(k.inClip, `${at}: a kill made alive was cut`).toBe(true);
        }
        expect(m.clipNote !== null, at).toBe(m.kills.some((k) => !k.inClip));
        if (exitTick !== null && m.endTick === exitTick + tail) clamped++;
        if (m.clipNote !== null) noted++;
      }
    }
    // the generator reaches the rules it claims to: moments, deaths that cut kills, and notes
    expect([checked > 200, clamped > 20, noted > 5], `${checked} moments, ${clamped} ended by a death, ${noted} with a note`).toEqual([true, true, true]);
  });
});
