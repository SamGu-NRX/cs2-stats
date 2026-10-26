import { fmtPct } from "../../lib/format";
import type { RoleBlend } from "../../../stats/identity";

export function roleValueDescriptor(b: RoleBlend, role: string): string {
  const status = b.calibrationStatus[role as keyof typeof b.calibrationStatus];
  if (status === "measured") return "AWP rounds";
  if (status === "calibrated") return "calibrated probability";
  return "fit";
}

/** Render the engine's gated decision without inferring a primary from its distribution. */
export function roleDecisionLabel(b: RoleBlend): string | null {
  if (b.primary) {
    const value = `${b.primary} ${fmtPct(100 * (b.probability ?? 0), 0)}`;
    return roleValueDescriptor(b, b.primary) === "calibrated probability" ? value : `${value} ${roleValueDescriptor(b, b.primary)}`;
  }
  if (b.top2) return b.top2.join(" / ");
  return b.reason;
}
