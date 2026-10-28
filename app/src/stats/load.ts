// Reads one match's parquet tables into MatchTables. The same code runs in the app (WebView) and in
// Node: the caller supplies `read`, which returns a file's bytes or null when the file is absent.
//
// hyparquet (pure JS, MIT) decodes parquet; hyparquet-compressors adds zstd, which the extractor
// writes. Only the columns in SCHEMA are decoded. A required table or a declared column that is
// missing, or a null in a non-nullable column, throws an error naming the table and column.
import { parquetMetadata, parquetRead, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { kindOf, OPTIONAL_TABLES, REQUIRED_TABLES, SCHEMA, SOURCE_COLUMNS, type MatchTables, type Table, type TableName } from "./tables";

export type ReadFile = (name: string) => Promise<ArrayBuffer | null>;

export class TableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableError";
  }
}

/**
 * Tables the current extractor still writes under their pre-v1 names. Each entry reads the old file
 * and maps it to the v1 table. Remove an entry once the extractor writes the v1 file
 * (extractor/SCHEMA-v1.md, branch feat/extractor-v1).
 */
const LEGACY: Partial<Record<TableName, (read: ReadFile) => Promise<Table<TableName> | null>>> = {
  match: async (read) => {
    const bytes = await read("meta.parquet");
    if (!bytes) return null;
    const meta = await readRaw(bytes, "meta", ["map_name", "map_key", "tick_rate", "demoparser2_version", "team_ct_start", "team_t_start", "convars", "extra", "archive"]);
    const extra = JSON.parse(String(meta.extra[0])) as Record<string, unknown>;
    const t: Table<"match"> = {
      n: 1,
      match_id: [`${extra.archive_slug ?? meta.archive[0]}/${meta.map_key[0]}`],
      source: ["hltv"],
      map: [String(meta.map_name[0])],
      tick_rate: [Number(meta.tick_rate[0])],
      team_ct_start: [String(meta.team_ct_start[0])],
      team_t_start: [String(meta.team_t_start[0])],
      schema_version: [1],
      extractor_version: [`pre-v1 (demoparser2 ${meta.demoparser2_version[0]})`],
      convars: [String(meta.convars[0])],
      extra: [String(meta.extra[0])],
      visibility_status: ["no_mapdata"],
    };
    return t as unknown as Table<TableName>;
  },
  players: async (read) => {
    const bytes = await read("players.parquet");
    if (!bytes) return null;
    const raw = await readRaw(bytes, "players", ["steamid", "name", "team"]);
    const t: Table<"players"> = {
      n: raw.__n, steamid: raw.steamid.map(String), name: raw.name.map(String),
      team: raw.team.map((v) => (v === null ? null : String(v))), is_bot: raw.steamid.map(() => false),
    };
    return t as unknown as Table<TableName>;
  },
  player_rounds: async (read) => {
    const bytes = await read("economy.parquet");
    return bytes ? ((await readTable(bytes, "player_rounds")) as unknown as Table<TableName>) : null;
  },
  // Pre-v1 spotted rows hold the full spotter list from each change; v1 rows are one spotter's change.
  spotted: async (read) => {
    const bytes = await read("spotted.parquet");
    if (!bytes) return null;
    const raw = await readRaw(bytes, "spotted", ["tick", "round", "steamid", "spotted_by"]);
    const t: Table<"spotted"> = { n: 0, tick: [], round: [], spotted: [], spotter_steamid: [], target_steamid: [] };
    const prev = new Map<string, Set<string>>();
    for (let i = 0; i < raw.__n; i++) {
      const target = String(raw.steamid[i]);
      const now = new Set(((raw.spotted_by[i] as unknown[] | null) ?? []).map(String));
      const before = prev.get(target) ?? new Set<string>();
      const push = (spotter: string, on: boolean) => {
        t.tick.push(Number(raw.tick[i])); t.round.push(Number(raw.round[i])); t.spotted.push(on);
        t.spotter_steamid.push(spotter); t.target_steamid.push(target); t.n++;
      };
      for (const s of now) if (!before.has(s)) push(s, true);
      for (const s of before) if (!now.has(s)) push(s, false);
      prev.set(target, now);
    }
    return t as unknown as Table<TableName>;
  },
};

/**
 * Loads every required table and the optional ones named in `optional` (all by default); optional
 * tables that are absent or not asked for are null. A scoreboard needs none of them, and positions,
 * shots and engagement ticks are most of a match's size. `columns` narrows a v1 table to the named
 * SCHEMA columns: the table then carries only those, and reading another gives undefined, so it is
 * for callers whose reads are known (worker/tool-tables.ts).
 */
export async function loadTables(read: ReadFile, optional: readonly TableName[] = OPTIONAL_TABLES, columns: Partial<Record<TableName, readonly string[]>> = {}): Promise<MatchTables> {
  const out: Record<string, unknown> = {};
  // A folder is v1 when it has match.parquet (SCHEMA-v1.md, "Versions"); those bytes are the match table's.
  const matchFile = read("match.parquet");
  const v1 = (await matchFile) !== null;
  const names = ([...REQUIRED_TABLES, ...OPTIONAL_TABLES] as TableName[]).filter((name) => (REQUIRED_TABLES as readonly string[]).includes(name) || optional.includes(name));
  // In the app every read is a round trip from the worker to the UI thread and the host, so every
  // file is asked for at once and decoded in order as it arrives. A failed read is handled where it
  // is awaited, in order, as before.
  const files = new Map<TableName, Promise<ArrayBuffer | null>>();
  for (const name of names) {
    if (!v1 && LEGACY[name]) continue;
    const p = name === "match" ? matchFile : read(`${name}.parquet`);
    p.catch(() => {});
    files.set(name, p);
  }
  for (const name of [...REQUIRED_TABLES, ...OPTIONAL_TABLES] as TableName[]) {
    if (!names.includes(name)) { out[name] = null; continue; }
    let t: Table<TableName> | null;
    if (!v1 && LEGACY[name]) t = await LEGACY[name]!(read);
    else {
      const bytes = await files.get(name)!;
      t = bytes ? await readTable(bytes, name, columns[name]) : null;
    }
    if (!t && (REQUIRED_TABLES as readonly string[]).includes(name)) throw new TableError(`table "${name}" is missing (${name}.parquet)`);
    out[name] = t;
  }
  return out as unknown as MatchTables;
}

/** Decodes the SCHEMA columns of one table, or only `only` of them. */
async function readTable<N extends TableName>(bytes: ArrayBuffer, name: N, only?: readonly string[]): Promise<Table<N>> {
  const cols = Object.keys(SCHEMA[name]);
  const unknown = only?.find((c) => !cols.includes(c));
  if (unknown !== undefined) throw new TableError(`${name}: "${unknown}" is not one of its columns`);
  if (only) cols.splice(0, cols.length, ...cols.filter((c) => only.includes(c)));
  const raw = await readRaw(bytes, name, cols, SOURCE_COLUMNS[name] ?? []);
  const t: Record<string, unknown> = { n: raw.__n };
  for (const c of cols) {
    const kind = kindOf(name, c);
    const src = raw[c];
    const nullable = kind.endsWith("?");
    const conv = new Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v === null || v === undefined) {
        if (kind === "ss") { conv[i] = []; continue; }
        if (!nullable) throw new TableError(`${name}.${c} row ${i} is null; the column is not nullable`);
        conv[i] = null;
        continue;
      }
      conv[i] = convert(kind, v, name, c);
    }
    t[c] = conv;
  }
  return t as Table<N>;
}

function convert(kind: string, v: unknown, table: string, col: string): unknown {
  switch (kind) {
    case "i": case "i?": case "f": case "f?": return typeof v === "bigint" ? Number(v) : (v as number);
    case "s": case "s?": return String(v);
    case "b": case "b?": return Boolean(v);
    case "id": case "id?": return String(v);
    case "ss": return (v as unknown[]).map(String);
  }
  throw new TableError(`${table}.${col}: unknown kind ${kind}`);
}

/**
 * The tables with match.extra's "pov" set to `pov`: whose match it is. An extracted demo does not say which
 * player recorded it; for the user's imported Valve matches it is the SteamID64 in valve-user.local.json,
 * which the host passes with each entry (host.ts FileEntry.pov).
 */
export function withPov(t: MatchTables, pov: string): MatchTables {
  const extra = { ...(JSON.parse(t.match.extra[0]) as Record<string, unknown>), pov };
  return { ...t, match: { ...t.match, extra: [JSON.stringify(extra)] } };
}

/** Raw decoded columns (hyparquet values), plus the row count. */
async function readRaw(bytes: ArrayBuffer, table: string, columns: string[], sourceOnly: readonly string[] = []): Promise<Record<string, unknown[]> & { __n: number }> {
  const metadata = parquetMetadata(bytes);
  const n = Number(metadata.num_rows);
  const present = new Set(parquetSchema(metadata).children.map((c) => c.element.name));
  const missing = columns.filter((c) => !present.has(c) && !sourceOnly.includes(c));
  if (missing.length) throw new TableError(`${table}: columns missing from the file: ${missing.join(", ")}`);
  // a source-only column the file lacks reads as null (tables.ts SOURCE_COLUMNS)
  const out: Record<string, unknown[]> = Object.fromEntries(columns.map((c) => [c, new Array(n).fill(null)]));
  await parquetRead({
    file: bytes, metadata, columns: columns.filter((c) => present.has(c)), compressors,
    onChunk: ({ columnName, columnData, rowStart }) => {
      const dst = out[columnName];
      for (let i = 0; i < columnData.length && rowStart + i < n; i++) dst[rowStart + i] = columnData[i];
    },
  });
  return Object.assign(out, { __n: n });
}
