// The optional tables (stats/tables.ts) the per-match tools read beyond the required ones, and for
// positions the columns, so the stats worker decodes only those when a match view asks. Decoding every
// table of a pro map was about 0.5 s of the Utility tab's 1.2 s first open (a CPU profile of the
// release build); engagement_ticks alone is over half of a map's bytes, and no tool reads it. Of what
// the tools do read, positions costs most: 225 to 373 ms with its 21 columns against 55 to 72 ms with
// the six the flash tool reads, over six pro maps in Node.
// The lists were found by recording which tables and columns each tool touched over the pro library.
// `leaves`, and positions' round, steamid, tick and is_alive, are in each because rosterTables reads
// them to take off-roster players' rows out.
import type { OPTIONAL_TABLES } from "../stats/tables";

export type OptionalTable = (typeof OPTIONAL_TABLES)[number];

/** Every column of a table, or only the named ones. */
export type Columns = "all" | readonly string[];

const ROSTER_POSITIONS = ["round", "steamid", "tick", "is_alive"];

/** What each tool reads. */
export const TOOL_TABLES = {
  flashes: { grenade_throws: "all", grenade_events: "all", positions: [...ROSTER_POSITIONS, "x", "y"], leaves: "all" },
  headToHead: { grenade_events: "all", leaves: "all" },
  mapZones: { positions: [...ROSTER_POSITIONS, "place"], leaves: "all" },
  bombsites: { positions: [...ROSTER_POSITIONS, "place"], leaves: "all" },
  places: { positions: [...ROSTER_POSITIONS, "place"], leaves: "all" },
} as const satisfies Record<string, Partial<Record<OptionalTable, Columns>>>;

export type Tool = keyof typeof TOOL_TABLES;

/**
 * loadTables' arguments for every tool's tables and columns together. The open match is read once with
 * these: reading per tool made a second tab read positions again for one more column, which cost more
 * than the column (Positions after Utility went from 66 to 207 ms).
 */
export function toolLoad(tools: readonly Tool[] = Object.keys(TOOL_TABLES) as Tool[]): { optional: OptionalTable[]; columns: Partial<Record<OptionalTable, readonly string[]>> } {
  const all = new Map<OptionalTable, Columns>();
  for (const tool of tools) {
    for (const [t, c] of Object.entries(TOOL_TABLES[tool]) as [OptionalTable, Columns][]) {
      const had = all.get(t);
      all.set(t, had === undefined ? c : had === "all" || c === "all" ? "all" : [...new Set([...had, ...c])]);
    }
  }
  const columns: Partial<Record<OptionalTable, readonly string[]>> = {};
  for (const [t, c] of all) if (c !== "all") columns[t] = c;
  return { optional: [...all.keys()], columns };
}
