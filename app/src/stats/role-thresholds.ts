/** Shared units, measured reference ranges and hand-chosen rule ticks. */
export type RoleMetricUnit = "pct" | "secs" | "units" | "perRound" | "count";
export interface RoleThreshold {
  unit: RoleMetricUnit;
  proRange: [number, number] | null;
  n: number;
  threshold: number | null;
  thresholdSource: "hand-chosen" | "unavailable";
}

// pnpm fit-roles, 2026-10-25: q10/q90 of player-map-side summaries with >=16 side rounds.
// This restricts the sample to long halves, not all careers. Keep that population visible.
// Thresholds below are inherited design choices, not fitted class boundaries. Quantiles describe
// spread only; the runtime rule is 0.5 at its tick and saturates over one q90-q10 width.
export const ROLE_RANGE_SOURCE = {
  population: "Pro player-map-side summaries with at least 16 side rounds",
  quantiles: [0.1, 0.9],
  command: "pnpm fit-roles <Packer CSV>",
  measured: "2026-10-25",
} as const;
export const ROLE_THRESHOLDS: Record<"openingAttempts" | "tradeKills" | "tradeAssistShare" | "utilityPR" | "teamDistance" | "firstContactTime" | "pushDepth" | "sitePresence" | "areaChanges" | "awpShare", RoleThreshold> = {
  openingAttempts: { unit: "pct", proRange: [5.555555555555555, 33.33333333333333], n: 312, threshold: 25, thresholdSource: "hand-chosen" },
  tradeKills: { unit: "pct", proRange: [5.526315789473685, 37.5], n: 310, threshold: 25, thresholdSource: "hand-chosen" },
  tradeAssistShare: { unit: "pct", proRange: [20, 60], n: 310, threshold: 45, thresholdSource: "hand-chosen" },
  utilityPR: { unit: "perRound", proRange: [1.6111111111111112, 3.23781512605042], n: 312, threshold: 1.2, thresholdSource: "hand-chosen" },
  // positioning.ts uses Math.hypot(dx,dy,dz). 1,100 is above the observed 3D q90 of 881.27;
  // retain it as a conservative hand-chosen signal, not a validated Lurker boundary.
  teamDistance: { unit: "units", proRange: [374.7772678897112, 881.2666073212856], n: 300, threshold: 1100, thresholdSource: "hand-chosen" },
  firstContactTime: { unit: "secs", proRange: [26.51489490327381, 54.45465494791667], n: 290, threshold: 40, thresholdSource: "hand-chosen" },
  pushDepth: { unit: "pct", proRange: [26.533264880507858, 57.69352077131741], n: 310, threshold: 50, thresholdSource: "hand-chosen" },
  sitePresence: { unit: "pct", proRange: [3.5105651419487907, 26.597872736486604], n: 312, threshold: 50, thresholdSource: "hand-chosen" },
  areaChanges: { unit: "count", proRange: null, n: 0, threshold: null, thresholdSource: "unavailable" },
  // AWP share is measured directly. This legacy signal tick does not classify AWP usage.
  awpShare: { unit: "pct", proRange: [0, 62.5], n: 310, threshold: 20, thresholdSource: "hand-chosen" },
};
export type RoleMetricId = keyof typeof ROLE_THRESHOLDS;

/** A high-value rule signal, centred on the same hand-chosen tick shown to the player. */
export function roleHigh(id: RoleMetricId, value: number | null): number {
  if (value === null) return 0.5;
  const { proRange, threshold } = ROLE_THRESHOLDS[id];
  if (!proRange || threshold === null || proRange[1] <= proRange[0]) throw new Error(`No score range for role metric ${id}`);
  return Math.max(0, Math.min(1, 0.5 + (value - threshold) / (proRange[1] - proRange[0])));
}
