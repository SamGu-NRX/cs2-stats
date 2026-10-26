// Test helper: builds tables row by row for hand-made matches.
import { SCHEMA, type Table, type TableName } from "../tables";

type Row<N extends TableName> = { [C in keyof (typeof SCHEMA)[N]]: Table<N>[C] extends (infer V)[] ? V : never };

/** Appends one row; every column must be given (undefined is an error, null is a value). */
export function pushRow<N extends TableName>(t: Table<N>, row: Row<N>): void {
  const cols = t as unknown as Record<string, unknown[]>;
  for (const c of Object.keys(cols)) {
    if (c === "n") continue;
    const v = (row as Record<string, unknown>)[c];
    if (v === undefined) throw new Error(`pushRow: column "${c}" is missing`);
    cols[c].push(v);
  }
  t.n++;
}
