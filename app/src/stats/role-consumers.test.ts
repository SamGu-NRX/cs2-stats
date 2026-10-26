import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { FEATURES, ROLE_TIPS } from "./identity";
import { emptySummary } from "./rollup";

it("gives every observable role a profile description without legacy labels", () => {
  // Only this dictionary belongs to the engine change. Check its keys without mounting
  // the profile or changing its exports; interaction verification belongs to the UI branch.
  const source = readFileSync(new URL("../ui/views/profile/parts.tsx", import.meta.url), "utf8");
  const dictionary = source.match(/const ROLE_WHAT: Record<string, string> = \{([\s\S]*?)\n\};/)?.[1];
  expect(dictionary).toBeDefined();
  const entries = [...dictionary!.matchAll(/^\s+(\w+): "([^"]+)"/gm)];
  expect(entries.map((entry) => entry[1]).sort()).toEqual(Object.keys(ROLE_TIPS).sort());
  for (const entry of entries) expect(entry[2].trim().length).toBeGreaterThan(20);
});

it("runs identity-check without counting Mixed or skipping a single primary", async () => {
  const rows = ["AWPer", "Mixed"].map((role, i) => ({
    steamid: String(i + 1), player_name: role, team_clan_name: "fixture", map_count: "20", role_t: role, role_ct: role,
    ...Object.fromEntries(FEATURES.flatMap((f) => ["t", "ct"].map((s) => [`${f === "adnt" || f === "adat" ? f + "_rank" : f}_${s}`, "1"]))),
  }));
  const columns = Object.keys(rows[0]);
  const csv = [columns.join(","), ...rows.map((row) => columns.map((c) => (row as Record<string, string>)[c]).join(","))].join("\n");
  const s = emptySummary();
  Object.assign(s.m, { rounds: 100, loadoutRounds: 100, roundsWithAwp: 80, kills: 30, deaths: 50, spacingSamples: 100, deathTimeSum: 2400, adntRank: 50, adatRank: 50 });
  const roll = vi.fn((_facts: unknown, _filter: { player: string }) => s);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const argv = process.argv;
  try {
    process.argv = [argv[0], "identity-check.ts", "role-check-fixture.csv"];
    vi.doMock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), readFileSync: () => csv }));
    vi.doMock("../../tools/node-read", () => ({ WINPROB: {}, proMaps: async function* () { yield { t: {} }; } }));
    vi.doMock("./derive", () => ({ derive: () => ({ players: rows.map((row) => ({ id: row.steamid })) }) }));
    vi.doMock("./rollup", async (original) => ({ ...await original<typeof import("./rollup")>(), rollup: roll }));
    await import("../../tools/identity-check");
    expect(roll).toHaveBeenCalledTimes(2);
    expect(roll.mock.calls.every(([, filter]) => filter.player === "1")).toBe(true);
    expect(log.mock.calls.filter(([text]) => String(text).includes("single-primary matches 1/1"))).toHaveLength(2);
    expect(log.mock.calls.filter(([text]) => String(text).includes("1 labelled players with features"))).toHaveLength(2);
  } finally {
    process.argv = argv;
    for (const id of ["node:fs", "../../tools/node-read", "./derive", "./rollup"]) vi.doUnmock(id);
    log.mockRestore();
    vi.resetModules();
  }
});

it("documents the confidence contract and distinguishes AWP pools from identity", () => {
  const metrics = readFileSync(new URL("./METRICS.md", import.meta.url), "utf8");
  const identity = metrics.split("## Identity beyond HLTV")[1];
  expect(identity).toContain("T outputs Entry, Trader, Support, Lurker and AWPer");
  expect(identity).toContain("CT outputs Anchor, Rotator, Aggressor, Support and AWPer");
  expect(identity).toContain("Mixed labels are excluded");
  expect(identity).toContain("`top2: [a,b]`");
  expect(metrics).toContain("AWPer comparison pool");
  expect(metrics).toContain("AWPer identity share");
  expect(metrics).toContain("measured AWP rounds");
});
