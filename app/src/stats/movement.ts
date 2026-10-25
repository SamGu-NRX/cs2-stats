// Stub wired into facts, rollup and metrics; replaced by the family's implementation.
// Facts come from positions and shots (movement.ts).
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

export interface MoveFact { ri: number; pi: number }
export interface MoveAgg { n: number }
export const emptyMove = (): MoveAgg => ({ n: 0 });
export function foldMove(a: MoveAgg, _f: MoveFact): void { a.n++; }
export function deriveMove(_c: Ctx): MoveFact[] { return []; }
export const MOVEMENT_METRICS: Metric[] = [];
