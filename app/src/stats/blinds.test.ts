// blindWindows (blinds.ts) with a detonation the extractor recovered: the recording skipped the tick a flashbang
// detonated on, so its blinds show on the next tick, name no thrower, and grenade_events holds a recovered
// flash_detonate for them on the skipped tick (SCHEMA-v1.md, blinds in Not in the demo).
import { describe, expect, it } from "vitest";
import { blindWindows } from "./blinds";
import { FREEZE_END, oneRoundTables } from "./testing/match";

const t = (s: number) => FREEZE_END + 64 * s;
const players = { a: "CT", b: "CT", c: "T", d: "T", e: "T" } as const;

describe("blindWindows", () => {
  it("keeps a recovered flash's blind apart from an older flash that had the same entity id", () => {
    // fails if the 0.2 s blind of the recovered flash (no thrower, entity id 93, which an older flash of a's had
    // used) is linked to a's detonation and merged into c's 3.5 s blind: an OpenCS2 demo showed one 3.5625 s blind
    // where there were two
    const tables = oneRoundTables({
      players,
      grenade_events: [
        { tick: t(10), event: "flash_detonate", entity_id: 93, steamid: "a", x: 100, y: 200 },
        { tick: t(20) - 1, event: "flash_detonate", entity_id: 93, steamid: null, x: 300, y: 400 },
      ],
      blinds: [
        { tick: t(10), attacker_steamid: "a", victim_steamid: "c", duration: 3.5, flash_entity_id: 93 },
        { tick: t(20), attacker_steamid: null, victim_steamid: "c", duration: 0.2, flash_entity_id: 93 },
      ],
    });
    const w = blindWindows(tables).get(1)!;
    expect(w.map((x) => [x.tick, x.secs, x.attacker, x.det])).toEqual([
      [t(10), 3.5, "a", `1|a|93|${t(10)}`],
      [t(20), 0.2, null, `1|null|93|${t(20) - 1}`],
    ]);
  });
});
