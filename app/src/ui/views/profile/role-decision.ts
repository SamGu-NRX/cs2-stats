import { fmtPct } from "../../lib/format";
import type { RoleBlend } from "../../../stats/identity";

/** Render the engine's gated decision without inferring a primary from its distribution. */
export function roleDecisionLabel(b: RoleBlend): string | null {
  if (b.primary) return `${b.primary} ${fmtPct(100 * (b.probability ?? 0), 0)}`;
  if (b.top2) return b.top2.join(" / ");
  return b.reason;
}
