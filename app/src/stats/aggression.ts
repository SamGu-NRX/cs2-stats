// Stub wired into facts, rollup and metrics; replaced by the family's implementation.
// Facts come from positions and kills (aggression.ts).
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

export interface AggroFact { ri: number; pi: number }
export interface AggroAgg { n: number }
export const emptyAggro = (): AggroAgg => ({ n: 0 });
export function foldAggro(a: AggroAgg, _f: AggroFact): void { a.n++; }
export function deriveAggro(_c: Ctx): AggroFact[] { return []; }
export const AGGRESSION_METRICS: Metric[] = [];
