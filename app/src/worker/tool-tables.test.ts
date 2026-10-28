// Which tables and columns the open match is read with for each tool (tool-tables.ts tablesToLoad, loadArgs).
import { expect, it } from "vitest";
import { loadArgs, tablesToLoad, type Columns, type OptionalTable } from "./tool-tables";

const sorted = (m: ReadonlyMap<OptionalTable, Columns>) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([t, c]) => [t, c === "all" ? c : [...c].sort()]));

it("reloads only for a table or column not yet read, and keeps what earlier tools read", () => {
  // fails if a tool is answered from tables missing a table or column it reads, or a reload drops
  // another tool's
  const first = tablesToLoad(null, "places")!;
  expect(sorted(first)).toEqual({ leaves: "all", positions: ["is_alive", "place", "round", "steamid", "tick"] });
  expect(tablesToLoad(first, "places")).toBeNull();
  expect(tablesToLoad(first, "bombsites")).toBeNull();
  // the flash tool needs x and y as well: a reload with both tools' columns
  const both = tablesToLoad(first, "flashes")!;
  expect(sorted(both)).toEqual({ grenade_events: "all", grenade_throws: "all", leaves: "all", positions: ["is_alive", "place", "round", "steamid", "tick", "x", "y"] });
  for (const tool of ["flashes", "headToHead", "mapZones", "bombsites", "places"] as const) expect(tablesToLoad(both, tool)).toBeNull();
  // a table read whole holds any columns of it
  expect(tablesToLoad(new Map<OptionalTable, Columns>([["positions", "all"], ["leaves", "all"]]), "places")).toBeNull();
});

it("hands loadTables the tables, and columns only for the tables narrowed", () => {
  // fails if a table meant whole is narrowed, or a narrowed one is read whole
  const a = loadArgs(new Map<OptionalTable, Columns>([["positions", ["tick", "x"]], ["leaves", "all"]]));
  expect(a).toEqual({ optional: ["positions", "leaves"], columns: { positions: ["tick", "x"] } });
});
