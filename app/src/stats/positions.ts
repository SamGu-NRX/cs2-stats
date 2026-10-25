// Position aggregates on a fixed world grid, so grids from different matches on a map add up.
import { fullRoundTest } from "./context";
import type { MatchFile } from "./schema";

/** World units per grid cell, and the grid covers ±4096 on x and y. */
export const CELL = 64;
export const HALF_EXTENT = 4096;
export const GRID = (2 * HALF_EXTENT) / CELL;

export const cellOf = (x: number, y: number) => {
  const cx = Math.floor((x + HALF_EXTENT) / CELL);
  const cy = Math.floor((y + HALF_EXTENT) / CELL);
  return cx < 0 || cy < 0 || cx >= GRID || cy >= GRID ? -1 : cy * GRID + cx;
};

export interface PosAgg {
  map: string;
  /** human alive samples per cell */
  human: Record<number, number>;
  /** every player's alive samples per cell: the map's walkable shape, drawn as a backdrop */
  all: Record<number, number>;
  /** seconds the human spent alive per place name */
  places: Record<string, number>;
  /** human kill and death spots [x, y] */
  kills: [number, number][];
  deaths: [number, number][];
}

export function emptyPos(map: string): PosAgg {
  return { map, human: {}, all: {}, places: {}, kills: [], deaths: [] };
}

export function mergePos(a: PosAgg, b: PosAgg): PosAgg {
  for (const [c, n] of Object.entries(b.human)) a.human[+c] = (a.human[+c] ?? 0) + n;
  for (const [c, n] of Object.entries(b.all)) a.all[+c] = (a.all[+c] ?? 0) + n;
  for (const [p, s] of Object.entries(b.places)) a.places[p] = (a.places[p] ?? 0) + s;
  a.kills.push(...b.kills);
  a.deaths.push(...b.deaths);
  return a;
}

export function positionsAggregate(m: MatchFile): PosAgg {
  const a = emptyPos(m.map);
  const p = m.pos;
  const tr = m.env.tickrate || 64;
  const isFull = fullRoundTest(m);
  // Sampling interval per player, from the median gap between their consecutive samples.
  const last = new Map<number, number>();
  const gaps = new Map<number, number[]>();
  for (let i = 0; i < p.ri.length; i++) {
    const prev = last.get(p.pi[i]);
    if (prev !== undefined && p.tick[i] > prev) {
      let g = gaps.get(p.pi[i]);
      if (!g) gaps.set(p.pi[i], (g = []));
      if (g.length < 200) g.push(p.tick[i] - prev);
    }
    last.set(p.pi[i], p.tick[i]);
  }
  const humanGaps = (gaps.get(m.human) ?? []).sort((x, y) => x - y);
  const humanSecs = (humanGaps.length ? humanGaps[humanGaps.length >> 1] : 16) / tr;
  for (let i = 0; i < p.ri.length; i++) {
    if (!p.alive[i] || !isFull(p.ri[i])) continue;
    const c = cellOf(p.x[i], p.y[i]);
    if (c >= 0) a.all[c] = (a.all[c] ?? 0) + 1;
    if (p.pi[i] !== m.human) continue;
    if (c >= 0) a.human[c] = (a.human[c] ?? 0) + 1;
    const pl = p.place[i];
    const name = pl === null ? "Unknown" : m.places[pl] ?? "Unknown";
    a.places[name] = (a.places[name] ?? 0) + humanSecs;
  }
  const k = m.kills;
  for (let i = 0; i < k.ri.length; i++) {
    if (!isFull(k.ri[i])) continue;
    if (k.killer[i] === m.human && k.kpos[i]) a.kills.push([k.kpos[i]![0], k.kpos[i]![1]]);
    if (k.victim[i] === m.human && k.vpos[i]) a.deaths.push([k.vpos[i]![0], k.vpos[i]![1]]);
  }
  return a;
}
