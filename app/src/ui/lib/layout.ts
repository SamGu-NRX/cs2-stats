// Column layout for round-by-round views (the round inspector, the economy chart). Teams swap
// sides at each half, so a gap separates halves: regulation halves are maxrounds / 2 long, and
// overtime halves are 3 rounds (CS2's default mp_overtime_maxrounds of 6).

export const OT_HALF = 3;

/** Index of the half a round belongs to: 0 and 1 are regulation, 2+ are overtime halves. */
export function halfOf(ri: number, maxrounds: number): number {
  const half = Math.max(1, Math.floor(maxrounds / 2));
  if (ri < maxrounds) return Math.floor(ri / half);
  return 2 + Math.floor((ri - maxrounds) / OT_HALF);
}

/** True when round ri starts a new half (and is not the first round). */
export const startsHalf = (ri: number, maxrounds: number) => ri > 0 && halfOf(ri, maxrounds) !== halfOf(ri - 1, maxrounds);

export interface Column { ri: number; x: number; half: number; gapBefore: boolean }

/**
 * x position of every round column. `cell` is the column width, `gap` the space between columns
 * and `halfGap` the extra space at a side swap. Returns the columns and the total width.
 */
export function roundColumns(nRounds: number, maxrounds: number, cell: number, gap: number, halfGap: number): { cols: Column[]; width: number } {
  const cols: Column[] = [];
  let x = 0;
  for (let ri = 0; ri < nRounds; ri++) {
    const gapBefore = startsHalf(ri, maxrounds);
    if (ri > 0) x += gap + (gapBefore ? halfGap : 0);
    cols.push({ ri, x, half: halfOf(ri, maxrounds), gapBefore });
    x += cell;
  }
  return { cols, width: nRounds ? x : 0 };
}

/**
 * Kill icons for a cell: up to `perRow` per row, at most `rows` rows. Returns the icon slots in
 * reading order with the overflow folded into the last slot as a count ("+2").
 */
export function killSlots<T>(kills: readonly T[], perRow: number, rows: number): { items: T[]; overflow: number } {
  const max = perRow * rows;
  if (kills.length <= max) return { items: [...kills], overflow: 0 };
  return { items: kills.slice(0, max - 1), overflow: kills.length - (max - 1) };
}

/** Next index for keyboard movement in a grid, clamped at the edges (no wrap). */
export function moveIndex(i: number, delta: number, n: number): number {
  return Math.max(0, Math.min(n - 1, i + delta));
}
