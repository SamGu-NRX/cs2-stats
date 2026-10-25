// Stub wired into facts, rollup and metrics; replaced by the family's implementation.
// Facts come from smokes, infernos, flashes and positions (utilq.ts).
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

export interface UtilQFact { ri: number; pi: number }
export interface UtilQAgg { n: number }
export const emptyUtilQ = (): UtilQAgg => ({ n: 0 });
export function foldUtilQ(a: UtilQAgg, _f: UtilQFact): void { a.n++; }
export function deriveUtilQ(_c: Ctx): UtilQFact[] { return []; }
export const UTILQ_METRICS: Metric[] = [];
