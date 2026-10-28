// The optional tables (stats/tables.ts) each per-match tool reads beyond the required ones, and for
// positions the columns, so the stats worker decodes only those when a match view asks. Decoding every
// table of a pro map was about 0.5 s of the Utility tab's 1.2 s first open (a CPU profile of the
// release build); engagement_ticks alone is over half of a map's bytes, and no tool reads it. Of what
// the tools do read, positions costs most: 225 to 373 ms with its 21 columns against 55 to 72 ms with
// the six the flash tool reads, over six pro maps in Node.
// The lists were found by recording which tables and columns each tool touched over the pro library;
// tools/perf-maps.ts --tools checks every tool's output with these against its output with every table
// whole. `leaves`, and positions' round, steamid, tick and is_alive, are in each because rosterTables
// reads them to take off-roster players' rows out.
import type { OPTIONAL_TABLES } from "../stats/tables";

export type OptionalTable = (typeof OPTIONAL_TABLES)[number];

/** Every column of a table, or only the named ones. */
export type Columns = "all" | readonly string[];

const ROSTER_POSITIONS = ["round", "steamid", "tick", "is_alive"];

export const TOOL_TABLES = {
  flashes: { grenade_throws: "all", grenade_events: "all", positions: [...ROSTER_POSITIONS, "x", "y"], leaves: "all" },
  headToHead: { grenade_events: "all", leaves: "all" },
  mapZones: { positions: [...ROSTER_POSITIONS, "place"], leaves: "all" },
  bombsites: { positions: [...ROSTER_POSITIONS, "place"], leaves: "all" },
  places: { positions: [...ROSTER_POSITIONS, "place"], leaves: "all" },
} as const satisfies Record<string, Partial<Record<OptionalTable, Columns>>>;

export type Tool = keyof typeof TOOL_TABLES;

/** The optional tables the open match was read with, and their columns. */
export type Loaded = ReadonlyMap<OptionalTable, Columns>;

/** Both column choices together: every column if either is. */
const joined = (a: Columns | undefined, b: Columns): Columns => (a === undefined ? b : a === "all" || b === "all" ? "all" : [...new Set([...a, ...b])]);

/**
 * What the open match must be read with for `tool`: null when what was read (`have`) already holds
 * every table and column it reads, else that and the tool's together, so an earlier tool keeps its own.
 */
export function tablesToLoad(have: Loaded | null, tool: Tool): Map<OptionalTable, Columns> | null {
  const need = Object.entries(TOOL_TABLES[tool]) as [OptionalTable, Columns][];
  const holds = (got: Columns | undefined, want: Columns) => got === "all" || (got !== undefined && want !== "all" && want.every((c) => got.includes(c)));
  if (have && need.every(([t, c]) => holds(have.get(t), c))) return null;
  const out = new Map(have ?? []);
  for (const [t, c] of need) out.set(t, joined(out.get(t), c));
  return out;
}

/** loadTables' arguments for what tablesToLoad returned: the optional tables, and the columns of those narrowed. */
export function loadArgs(load: Loaded): { optional: OptionalTable[]; columns: Partial<Record<OptionalTable, readonly string[]>> } {
  const columns: Partial<Record<OptionalTable, readonly string[]>> = {};
  for (const [t, c] of load) if (c !== "all") columns[t] = c;
  return { optional: [...load.keys()], columns };
}
