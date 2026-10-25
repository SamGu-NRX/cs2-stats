// Stub wired into facts, rollup and metrics; replaced by the family's implementation.
// Facts come from the spotted table (information.ts).
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

export interface InfoFact { ri: number; pi: number }
export interface InfoAgg { n: number }
export const emptyInfo = (): InfoAgg => ({ n: 0 });
export function foldInfo(a: InfoAgg, _f: InfoFact): void { a.n++; }
export function deriveInfo(_c: Ctx): InfoFact[] { return []; }
export const INFORMATION_METRICS: Metric[] = [];
