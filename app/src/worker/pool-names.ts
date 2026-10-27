// The pro pool's file name and label, for the UI thread. They live apart from baselines-pool.ts,
// whose parser imports the engine (stats/compare), so that importing them does not put the engine in
// the UI bundle.
export type PoolKind = "local" | "shipped";
export const LOCAL_BASELINES = "baselines.local.json";

/** "Pro pool: local (HLTV model)": the pool in use and the win-probability model it was built with. */
export function poolLabel(pool: PoolKind, model: string): string {
  const kind = model.startsWith("hltv-") ? "HLTV model" : model.startsWith("cs2rb-") ? "CS2RB" : `model ${model}`;
  return `Pro pool: ${pool} (${kind})`;
}
