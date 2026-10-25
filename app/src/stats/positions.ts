// Where a player spends their time: alive position samples per player-round, as seconds on a fixed
// world grid and seconds per place name. rollup adds them per map (Summary.presence) for the movement
// heatmap and the top places; one round's fact is "where you spent the round". Kill and death spots
// come from facts.kills.
import type { Ctx } from "./derive";
import type { PresenceFact } from "./facts";

/**
 * World units per grid cell: four player widths (a player model is 32 units wide). Ours, no fit; the
 * cached size it gives is in VALIDATION.md (pnpm family-check).
 */
export const CELL = 128;
/** The grid spans ±HALF_EXTENT on x and y, which covers every competitive map. */
export const HALF_EXTENT = 4096;
export const GRID = (2 * HALF_EXTENT) / CELL;

export const cellOf = (x: number, y: number): number => {
  const cx = Math.floor((x + HALF_EXTENT) / CELL);
  const cy = Math.floor((y + HALF_EXTENT) / CELL);
  return cx < 0 || cy < 0 || cx >= GRID || cy >= GRID ? -1 : cy * GRID + cx;
};

/** Centre of a cell in world units, [x, y]. */
export const cellCentre = (cell: number): [number, number] => [
  (cell % GRID) * CELL - HALF_EXTENT + CELL / 2, Math.floor(cell / GRID) * CELL - HALF_EXTENT + CELL / 2,
];

/** Seconds alive per cell and per place name, by player-round. Empty without positions. */
export function derivePresence(c: Ctx): PresenceFact[] {
  const p = c.t.positions;
  if (!p || !p.n) return [];
  // seconds per sample: the extractor's stride, read from the sample ticks themselves
  let stride = Infinity;
  for (let i = 1; i < Math.min(p.n, 200); i++) if (p.tick[i] > p.tick[i - 1]) stride = Math.min(stride, p.tick[i] - p.tick[i - 1]);
  if (!Number.isFinite(stride)) return [];
  const secs = stride / c.tickRate;
  const acc = new Map<number, { cells: Map<number, number>; places: Record<string, number> }>();
  for (let i = 0; i < p.n; i++) {
    if (!p.is_alive[i]) continue;
    const ri = c.riOf(p.round[i]);
    const pi = c.pi.get(p.steamid[i]);
    if (ri === undefined || pi === undefined || !c.pr[ri][pi]) continue;
    const key = ri * 1024 + pi;
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { cells: new Map(), places: {} }));
    const cell = cellOf(p.x[i], p.y[i]);
    if (cell >= 0) a.cells.set(cell, (a.cells.get(cell) ?? 0) + secs);
    const place = p.place[i] || "Unknown";
    a.places[place] = (a.places[place] ?? 0) + secs;
  }
  return [...acc].sort(([x], [y]) => x - y).map(([key, a]) => ({
    ri: Math.floor(key / 1024), pi: key % 1024, cells: [...a.cells].flat(), places: a.places,
  }));
}

/** Presence summed over player-rounds on one map: seconds per cell and per place. */
export interface Presence {
  cells: Record<number, number>;
  places: Record<string, number>;
}

export function foldPresence(a: Presence, f: PresenceFact): void {
  for (let j = 0; j < f.cells.length; j += 2) a.cells[f.cells[j]] = (a.cells[f.cells[j]] ?? 0) + f.cells[j + 1];
  for (const [pl, s] of Object.entries(f.places)) a.places[pl] = (a.places[pl] ?? 0) + s;
}
