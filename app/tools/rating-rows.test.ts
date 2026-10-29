import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { killPoints, type EcoGroup } from "../src/stats/rating3";
import { FREEZE_END, oneRound, oneRoundTables, type OneRound } from "../src/stats/testing/match";
import type { HltvJoin, HltvLine, HltvMap, HltvPlayer } from "./hltv";
import { hitRows, joinRow, killRows, tablesLayout } from "./rating-rows";

// One round: CT a (AWP at freeze end) and d, T b (AK-47 at freeze end) and c (no primary, $900 of equipment).
// Kill groups come from the best primary held at the kill (a), from the equipment value at the kill (c), or from
// the freeze end; hits use the freeze-end groups.
const match: OneRound = {
  players: { a: "CT", d: "CT", b: "T", c: "T" },
  player_rounds: {
    a: { best_primary: "AWP", equip_value_game: 5700 },
    d: { best_primary: "M4A1-S", equip_value_game: 4100 },
    b: { best_primary: "AK-47", equip_value_game: 3700 },
    c: { equip_value_game: 900 },
  },
  kills: [
    { tick: FREEZE_END + 100, killer: "a", victim: "c", at: { a_best_primary: "AWP", v_equip_value_game: 900 } },
    { tick: FREEZE_END + 200, killer: "b", victim: "d", at: { a_best_primary: "AK-47", v_best_primary: "M4A1-S" } },
    { tick: FREEZE_END + 300, killer: "d", victim: "b", at: { a_equip_value_game: 1800, v_best_primary: "AK-47" } },
  ],
  damages: [
    { tick: FREEZE_END + 90, attacker_steamid: "a", victim_steamid: "c", dmg_health_capped: 100, health_before: 100, health_after: 0, a_side: "CT", v_side: "T" },
    { tick: FREEZE_END + 190, attacker_steamid: "b", victim_steamid: "d", dmg_health_capped: 64, health_before: 100, health_after: 36, a_side: "T", v_side: "CT" },
    { tick: FREEZE_END + 195, attacker_steamid: "b", victim_steamid: "d", dmg_health_capped: 36, health_before: 36, health_after: 0, a_side: "T", v_side: "CT" },
    { tick: FREEZE_END + 290, attacker_steamid: "d", victim_steamid: "b", dmg_health_capped: 100, health_before: 100, health_after: 0, a_side: "CT", v_side: "T" },
  ],
};

const line = {} as HltvLine;
const page = (players: HltvPlayer[]): HltvMap => ({ file: "map_1.json", map: "de_test", date: "2026-10-28", teams: [["A", 1], ["B", 0]], players, equip: [], swingPerRound: new Map() });

describe("the rating dump's duel groups", () => {
  it("are the groups derive valued each kill and hit with", () => {
    // Review of PR 80: model/rating3/eco_fit.py worked out its own weapon groups (active weapon, round-start
    // loadout), so the duel block it fitted scored worse in the app, which groups by the best primary held at the
    // kill. The dump now writes derive's groups; fails if a dumped group ever differs from the one derive used.
    const f = oneRound(match);
    const players = f.players.map((p) => ({ nick: p.id, pid: `pid-${p.id}`, team: "A", total: line, ct: null, t: null }));
    const j: HltvJoin = { hltv: page(players), player: new Map(players.map((p, i) => [i, p])), team: [0, 1], unmatched: [] };
    const kills = killRows(f, oneRoundTables(match), j);
    expect(kills.map((r) => [r.killer, r.aGroup, r.vGroup])).toEqual([
      ["pid-a", "sniper", "pistolPlus"], ["pid-b", "rifle1", "rifle1"], ["pid-d", "smg", "rifle1"],
    ]);
    for (const [r, kf] of kills.map((r, i) => [r, f.kills[i]] as const)) {
      expect(killPoints(r.aGroup as EcoGroup, r.vGroup as EcoGroup, kf.killerSide!)).toBe(kf.ecoPoints);
    }
    const hits = hitRows(f, oneRoundTables(match), j);
    expect(hits.map((h) => [h.attacker, h.aGroup, h.vGroup])).toEqual([
      ["pid-a", "sniper", "pistolPlus"], ["pid-b", "rifle1", "rifle1"], ["pid-b", "rifle1", "rifle1"], ["pid-d", "rifle1", "rifle1"],
    ]);
    const ecoDmg = new Map<string, number>();
    for (const h of hits) {
      const v = (h.dmg as number) * killPoints(h.aGroup as EcoGroup, h.vGroup as EcoGroup, h.aSide as "CT" | "T");
      ecoDmg.set(h.attacker as string, (ecoDmg.get(h.attacker as string) ?? 0) + v);
    }
    for (const r of f.pr) {
      expect(ecoDmg.get(`pid-${f.players[r.pi].id}`) ?? 0).toBeCloseTo(r.m.ecoDmg ?? 0, 9);
    }
    expect(Math.max(...f.pr.map((r) => r.m.ecoDmg ?? 0))).toBeGreaterThan(0);
  });
});

describe("the rating dump's join record", () => {
  it("names the join and the table layout the map's rows came from", () => {
    // Review of PR 80: eco_fit matched dump rows to joins by HLTV file only and counted every map as schema v1. The
    // dump now records each map's join and layout, by demo_paths.demo_layout's rule; fails if either is lost.
    const root = mkdtempSync(path.join(tmpdir(), "rating-rows-"));
    try {
      const make = (name: string, files: string[]) => {
        const dir = path.join(root, name);
        mkdirSync(dir);
        for (const f of files) writeFileSync(path.join(dir, f), "");
        return dir;
      };
      const v1 = make("v1", ["match.parquet", "player_rounds.parquet"]);
      const legacy = make("legacy", ["meta.parquet", "economy.parquet"]);
      const half = make("half", ["match.parquet", "economy.parquet"]);
      expect([tablesLayout(v1), tablesLayout(legacy)]).toEqual(["schema_v1", "legacy"]);
      expect(() => tablesLayout(half)).toThrow(/neither schema v1/);
      const rec = { demo: "demos\\a-vs-b\\m1-nuke", hltv: "map_1.json", players: { "11": { hltv: "ana", pid: "1" } } };
      const j: HltvJoin = { hltv: page([]), player: new Map(), team: [0, 1], unmatched: [] };
      expect(joinRow(rec, j, legacy)).toEqual({ hltv: "map_1.json", demo: rec.demo, players: rec.players, layout: "legacy" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
