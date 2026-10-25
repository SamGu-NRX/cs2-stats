// Stub wired into facts, rollup and metrics; replaced by the family's implementation.
// Facts come from engagement windows (aim.ts).
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

export interface AimFact { ri: number; pi: number }
export interface AimAgg { n: number }
export const emptyAim = (): AimAgg => ({ n: 0 });
export function foldAim(a: AimAgg, _f: AimFact): void { a.n++; }
export function deriveAim(_c: Ctx): AimFact[] { return []; }
export const AIM_METRICS: Metric[] = [];
