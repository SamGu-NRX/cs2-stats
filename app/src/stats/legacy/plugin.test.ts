// The three matches recorded by capture plugin 1.0.0 (testing/matches) decode and derive, and the
// kill-state convention they use (victim counted with its HP before the fatal hit) is handled.
import { describe, expect, test } from "vitest";
import { winProbabilityCT } from "@model/winprob";
import { deriveMatch } from "./derive";
import { stateAfterKill } from "./swing";
import { loadPluginMatch, PLUGIN_MATCHES } from "./testing/load";
import { modelFromModule, type RoundState } from "./winprob";

const base: RoundState = { ctAlive: 5, tAlive: 5, ctHp: 270, tHp: 375, ctEquip: 3750, tEquip: 3700, planted: 0, secondsSincePlant: null, secondsSinceFreezeEnd: 12 };

describe("stateAfterKill", () => {
  test("removes the victim and its HP from its side", () => {
    expect(stateAfterKill(base, 3, 10)).toMatchObject({ ctAlive: 4, ctHp: 260, tAlive: 5, tHp: 375 });
    expect(stateAfterKill(base, 2, 75)).toMatchObject({ ctAlive: 5, ctHp: 270, tAlive: 4, tHp: 300 });
  });
  test("caps the side's HP at 100 per living player when the victim's HP is unknown", () => {
    expect(stateAfterKill({ ...base, ctAlive: 2, ctHp: 202 }, 3)).toMatchObject({ ctAlive: 1, ctHp: 100 });
    expect(stateAfterKill({ ...base, ctAlive: 1, ctHp: 49 }, 3)).toMatchObject({ ctAlive: 0, ctHp: 0 });
  });
  test("leaves a zero-HP victim's total unchanged (legacy and synthetic files)", () => {
    expect(stateAfterKill({ ...base, ctHp: 250 }, 3)).toMatchObject({ ctAlive: 4, ctHp: 250 });
  });
});

describe("plugin 1.0.0 recordings", () => {
  test("decode and derive with the placeholder model", async () => {
    const scores: string[] = [];
    for (const f of PLUGIN_MATCHES) {
      const v = deriveMatch(await loadPluginMatch(f), f);
      scores.push(`${v.score.us}-${v.score.them} ${v.captured}/${v.nRounds}`);
    }
    expect(scores).toEqual(["3-5 8/9", "13-10 23/23", "13-3 16/16"]);
  });

  test.skipIf(winProbabilityCT === undefined)("the trained model values every captured round", async () => {
    const model = modelFromModule(winProbabilityCT);
    for (const f of PLUGIN_MATCHES) {
      const v = deriveMatch(await loadPluginMatch(f), f, model);
      const unknown = v.rounds.filter((r) => r.captured && r.swing === null).map((r) => r.ri);
      expect(unknown, f).toEqual([]);
      for (const p of v.players) expect(p.swingPerRound, `${f} ${p.name}`).not.toBeNull();
    }
  });
});
