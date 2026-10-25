// Where a player spends their time: alive position samples counted on a fixed world grid, and seconds
// per place name. Computed from one match's tables when a view asks, because positions are most of a
// match's size and the facts do not keep them (architecture.md keeps the tables on disk). Grids from
// different matches on one map add cell by cell; kill and death spots come from facts.kills.
import type { Side, MatchTables } from "./tables";

/** World units per grid cell; the grid spans ±4096 on x and y, which covers every competitive map. */
export const CELL = 64;
export const HALF_EXTENT = 4096;
export const GRID = (2 * HALF_EXTENT) / CELL;

export interface Presence {
  map: string;
  /** alive samples per cell index (cy * GRID + cx) */
  cells: Record<number, number>;
  /** seconds alive per place name */
  places: Record<string, number>;
}

export const cellOf = (x: number, y: number): number => {
  const cx = Math.floor((x + HALF_EXTENT) / CELL);
  const cy = Math.floor((y + HALF_EXTENT) / CELL);
  return cx < 0 || cy < 0 || cx >= GRID || cy >= GRID ? -1 : cy * GRID + cx;
};

/**
 * One player's presence in one match (or every player's, for the map's walkable backdrop, with
 * player = null), optionally on one side. Null when the tables have no positions.
 */
export function presence(t: MatchTables, player: string | null, side?: Side): Presence | null {
  const p = t.positions;
  if (!p) return null;
  // seconds per sample: the extractor's stride, read from the sample ticks themselves
  let stride = Infinity;
  for (let i = 1; i < Math.min(p.n, 200); i++) if (p.tick[i] > p.tick[i - 1]) stride = Math.min(stride, p.tick[i] - p.tick[i - 1]);
  const secs = Number.isFinite(stride) ? stride / t.match.tick_rate[0] : 0;
  const out: Presence = { map: t.match.map[0], cells: {}, places: {} };
  for (let i = 0; i < p.n; i++) {
    if (!p.is_alive[i] || (player !== null && p.steamid[i] !== player) || (side && p.side[i] !== side)) continue;
    const c = cellOf(p.x[i], p.y[i]);
    if (c >= 0) out.cells[c] = (out.cells[c] ?? 0) + 1;
    const place = p.place[i] || "Unknown";
    out.places[place] = (out.places[place] ?? 0) + secs;
  }
  return out;
}

/** a += b, cell by cell and place by place (both on the same map). */
export function addPresence(a: Presence, b: Presence): Presence {
  for (const [c, n] of Object.entries(b.cells)) a.cells[+c] = (a.cells[+c] ?? 0) + n;
  for (const [pl, s] of Object.entries(b.places)) a.places[pl] = (a.places[pl] ?? 0) + s;
  return a;
}
