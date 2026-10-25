// Table sorting. Missing values (null, undefined, NaN) always sort last, whichever the direction,
// so flipping a column never brings a block of dashes to the top. Ties keep their input order.

export type SortDir = "asc" | "desc";
export type SortValue = number | string | null | undefined;
export interface SortState { key: string; dir: SortDir }

const missing = (v: SortValue) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));

export function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const ma = missing(a);
  const mb = missing(b);
  if (ma || mb) return ma === mb ? 0 : ma ? 1 : -1;
  const c = typeof a === "string" || typeof b === "string"
    ? String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" })
    : (a as number) - (b as number);
  return dir === "asc" ? c : -c;
}

export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((x, y) => compareValues(x.v, y.v, dir) || x.i - y.i)
    .map((x) => x.row);
}

/**
 * Next sort state after a header click: a new column starts in its natural direction (numbers
 * descending, text ascending); clicking the sorted column flips it.
 */
export function nextSort(current: SortState | null, key: string, firstDir: SortDir): SortState {
  if (current?.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: firstDir };
}
