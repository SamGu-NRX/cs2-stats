// Which matches can be replayed. A replay needs every player's position, view direction and HP four
// times a second: the extractor's positions table has them for pro and Valve demos (extracted folders).
// The capture plugin's files (.json.gz) sample bots once a second with no view or HP, so they get none.
// It also needs the map's radar transform (data/maps.ts): without it positions cannot be placed on a
// radar, and a frame fitted around the samples would draw players over nothing.
import { mapInfo } from "../../../data/maps";

export const NO_RECORDED_REPLAY = "Recorded matches don't keep the positions a replay needs.";
export const NO_MAP_REPLAY = "This map has no radar calibration, so it has no replay.";

/** Why a match has no replay, in one line; null when it has one. */
export function replayUnavailable(file: string, map: string): string | null {
  if (file.endsWith(".json.gz")) return NO_RECORDED_REPLAY;
  if (!mapInfo(map)) return NO_MAP_REPLAY;
  return null;
}
