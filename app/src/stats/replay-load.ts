// Loads what the 2D replay reads from an extracted match folder: the engine's tables with positions,
// grenade events and the smoke and fire lifetimes (load.ts), plus grenade_paths, which only the replay
// uses and so is not in the engine's SCHEMA (tables.ts). A folder without grenade_paths.parquet
// replays without grenade flights.
import { parquetMetadata, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { loadTables, TableError, type ReadFile } from "./load";
import type { GrenadePaths } from "./replay";
import { rosterTables, type RosterTables } from "./roster";

const PATH_COLUMNS = ["projectile", "entity_id", "round", "tick", "type", "steamid", "x", "y", "z"] as const;

/** Decodes grenade_paths.parquet; a missing column or a null outside `steamid` throws a TableError. */
export async function readGrenadePaths(bytes: ArrayBuffer): Promise<GrenadePaths> {
  const metadata = parquetMetadata(bytes);
  const n = Number(metadata.num_rows);
  const present = new Set(parquetSchema(metadata).children.map((c) => c.element.name));
  const missing = PATH_COLUMNS.filter((c) => !present.has(c));
  if (missing.length) throw new TableError(`grenade_paths: columns missing from the file: ${missing.join(", ")}`);
  const raw: Record<string, unknown[]> = Object.fromEntries(PATH_COLUMNS.map((c) => [c, new Array(n).fill(null)]));
  await parquetRead({
    file: bytes, metadata, columns: [...PATH_COLUMNS], compressors,
    onChunk: ({ columnName, columnData, rowStart }) => {
      const dst = raw[columnName];
      for (let i = 0; i < columnData.length && rowStart + i < n; i++) dst[rowStart + i] = columnData[i];
    },
  });
  const num = (c: string) => raw[c].map((v, i) => {
    if (v === null || v === undefined) throw new TableError(`grenade_paths.${c} row ${i} is null; the column is not nullable`);
    return Number(v);
  });
  return {
    n,
    projectile: num("projectile"), entity_id: num("entity_id"), round: num("round"), tick: num("tick"),
    type: raw.type.map((v, i) => { if (v === null || v === undefined) throw new TableError(`grenade_paths.type row ${i} is null`); return String(v); }),
    steamid: raw.steamid.map((v) => (v === null || v === undefined ? null : String(v))),
    x: num("x"), y: num("y"), z: num("z"),
  };
}

export interface ReplayTables { tables: RosterTables; paths: GrenadePaths | null }

/**
 * One extracted match's tables for the replay; `read` resolves a table file's bytes, or null when absent.
 * The roster is applied as derive applies it (roster.ts), disconnects included, so a player off a
 * round's roster has no dot, kill, hit or grenade in it; their grenade flights go too.
 */
export async function loadReplayTables(read: ReadFile): Promise<ReplayTables> {
  const tables = rosterTables(await loadTables(read, ["positions", "grenade_events", "smokes", "infernos", "leaves"]));
  const bytes = await read("grenade_paths.parquet");
  return { tables, paths: bytes ? rosterPaths(await readGrenadePaths(bytes), tables) : null };
}

/** The grenade flights without those thrown by a player off the round's roster. */
export function rosterPaths(p: GrenadePaths, t: RosterTables): GrenadePaths {
  const keep = [...Array(p.n).keys()].filter((i) => !(p.steamid[i] !== null && t.roster.off.get(p.round[i])?.has(p.steamid[i]!)));
  if (keep.length === p.n) return p;
  const pick = <T,>(col: T[]) => keep.map((i) => col[i]);
  return { n: keep.length, projectile: pick(p.projectile), entity_id: pick(p.entity_id), round: pick(p.round), tick: pick(p.tick), type: pick(p.type), steamid: pick(p.steamid), x: pick(p.x), y: pick(p.y), z: pick(p.z) };
}
