// Where a player spends their time: alive position samples per player and side, as seconds on a fixed
// world grid and seconds per place name. rollup adds them per map (Summary.presence) for the movement
// heatmap and the top places. One round's places ("where you spent the round") are read from the
// tables by roundPlaces. Kill and death spots come from facts.kills.
import type { Ctx } from "./derive";
import type { PresenceFact } from "./facts";
import type { MatchTables, Side } from "./tables";

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

/** Seconds per position sample: the extractor's stride, read from the sample ticks themselves; null without samples. */
function sampleSecs(t: MatchTables): number | null {
  const p = t.positions;
  if (!p) return null;
  let stride = Infinity;
  for (let i = 1; i < Math.min(p.n, 200); i++) if (p.tick[i] > p.tick[i - 1]) stride = Math.min(stride, p.tick[i] - p.tick[i - 1]);
  return Number.isFinite(stride) ? stride / t.match.tick_rate[0] : null;
}

/** Seconds alive per cell and per place name, by player and side. Empty without positions. */
export function derivePresence(c: Ctx): PresenceFact[] {
  const p = c.t.positions;
  const secs = sampleSecs(c.t);
  if (!p || secs === null) return [];
  const acc = new Map<number, { cells: Map<number, number>; places: Record<string, number> }>();
  for (let i = 0; i < p.n; i++) {
    if (!p.is_alive[i]) continue;
    const ri = c.riOf(p.round[i]);
    const pi = c.pi.get(p.steamid[i]);
    if (ri === undefined || pi === undefined || !c.pr[ri][pi]) continue;
    const key = pi * 2 + (c.side[ri][pi] === "CT" ? 1 : 0);
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { cells: new Map(), places: {} }));
    const cell = cellOf(p.x[i], p.y[i]);
    if (cell >= 0) a.cells.set(cell, (a.cells.get(cell) ?? 0) + secs);
    const place = p.place[i] || "Unknown";
    a.places[place] = (a.places[place] ?? 0) + secs;
  }
  return [...acc].sort(([x], [y]) => x - y).map(([key, a]) => ({
    pi: Math.floor(key / 2), side: (key % 2 ? "CT" : "T") as Side, cells: [...a.cells].flat(), places: a.places,
  }));
}

/** Seconds a player spent alive per place name in one round (by round number): "where you spent the round". */
export function roundPlaces(t: MatchTables, round: number, steamid: string): Record<string, number> {
  const p = t.positions;
  const secs = sampleSecs(t);
  const out: Record<string, number> = {};
  if (!p || secs === null) return out;
  for (let i = 0; i < p.n; i++) {
    if (p.round[i] !== round || p.steamid[i] !== steamid || !p.is_alive[i]) continue;
    const place = p.place[i] || "Unknown";
    out[place] = (out[place] ?? 0) + secs;
  }
  return out;
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

// ---- spawns

/**
 * A spawn this far (units) or more from the middle of its side's spawn area, along the line to the
 * enemy spawn or across it, is to the front, back, left or right. Ours, no fit: two player widths.
 */
export const SPAWN_OFFSET_UNITS = 64;

const xy = (key: string): [number, number] => { const [x, y] = key.split(",").map(Number); return [x, y]; };

/**
 * Where a spawn ("x,y", PlayerRound.spawn) sits in its side's spawn area, facing the enemy spawn:
 * "front left", "back", "centre" and so on. `own` and `enemy` are the spawn keys seen for each side on
 * the map; their means are the two spawn areas' middles. Null when either side has none, or both
 * middles fall on one point, so there is no facing.
 */
export function spawnPosition(spawn: string, own: string[], enemy: string[]): string | null {
  if (!own.length || !enemy.length) return null;
  const mean = (keys: string[]) => keys.map(xy).reduce(([a, b], [x, y]) => [a + x / keys.length, b + y / keys.length], [0, 0]);
  const o = mean(own), e = mean(enemy);
  const len = Math.hypot(e[0] - o[0], e[1] - o[1]);
  if (!len) return null;
  const f: [number, number] = [(e[0] - o[0]) / len, (e[1] - o[1]) / len];
  const [x, y] = xy(spawn);
  const dx = x - o[0], dy = y - o[1];
  const ahead = dx * f[0] + dy * f[1];
  // world y points north and x east, so facing f, left is f turned a quarter counter-clockwise
  const left = -dx * f[1] + dy * f[0];
  const parts = [
    ahead >= SPAWN_OFFSET_UNITS ? "front" : ahead <= -SPAWN_OFFSET_UNITS ? "back" : null,
    left >= SPAWN_OFFSET_UNITS ? "left" : left <= -SPAWN_OFFSET_UNITS ? "right" : null,
  ].filter((p) => p !== null);
  return parts.length ? parts.join(" ") : "centre";
}
