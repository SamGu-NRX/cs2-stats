// Packer's six role features, the role model's inputs (identity.ts). They live apart from identity.ts,
// which imports the metrics and the comparisons, so the UI thread can read them without loading the
// engine.
import type { Measures } from "./facts";

export const FEATURES = ["tapd", "oap", "podt", "pokt", "adnt", "adat"] as const;
export type Feature = (typeof FEATURES)[number];

/** Packer's features from summed measures; null when a denominator is zero. */
export function packerFeatures(m: Measures): Record<Feature, number> | null {
  if (!m.deaths || !m.rounds || !m.kills || !m.spacingSamples) return null;
  return {
    tapd: m.deathTimeSum / m.deaths, oap: (100 * (m.openingKills + m.openingDeaths)) / m.rounds,
    podt: (100 * m.tradedDeaths) / m.deaths, pokt: (100 * m.tradeKills) / m.kills,
    adnt: m.adntRank / m.spacingSamples, adat: m.adatRank / m.spacingSamples,
  };
}
