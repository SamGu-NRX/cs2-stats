// Maps drawn on two radars, one per floor. The boundary is the game's own: each overview file
// (data/radar_info/<map>.txt in the mirror maps.ts names, fetched 2026-10-25) has "verticalsections"
// whose "default" section starts at AltitudeMin and whose "lower" section ends at the same height.
// Both radars share the map's one transform (maps.ts), so only the image changes with the floor.
import { radarUrl } from "./maps";

export type Level = "upper" | "lower";

/** World z (feet) at which the upper radar starts: z at or above it is upper. */
const LOWER_BELOW: Record<string, number> = {
  de_nuke: -495,
  de_vertigo: 11700,
  de_train: -50,
};

/** The map's floor boundary, or null for a map drawn on one radar. */
export const levelBoundary = (map: string): number | null => LOWER_BELOW[map] ?? null;

export const hasLevels = (map: string) => levelBoundary(map) !== null;

/** Which radar a height belongs on; always "upper" on a one-radar map. */
export function levelOf(map: string, z: number): Level {
  const b = levelBoundary(map);
  return b !== null && z < b ? "lower" : "upper";
}

/** The radar image for one floor; null for a lower floor the map does not have, or an unknown map. */
export function levelRadarUrl(map: string, level: Level): string | null {
  const url = radarUrl(map);
  if (!url || level === "upper") return url;
  return hasLevels(map) ? url.replace(/_radar_psd\.png$/, "_lower_radar_psd.png") : null;
}
