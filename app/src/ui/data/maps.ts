// Map identity: radar image, emblem and the radar's world-to-pixel transform. Images load from the
// web at runtime (raw.githubusercontent.com, MurkyYT/cs2-map-icons, which mirrors Valve's game
// files; personal local use). Transforms are the game's overview files (data/radar_info/<map>.txt in
// that repository), fetched 2026-10-25. Offline, views fall back to a backdrop drawn from the
// recorded position samples (components/MapArt.tsx).

const BASE = "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images";

export interface MapInfo {
  id: string;
  /** world x at the radar's left edge, world y at its top edge, world units per radar pixel */
  posX: number;
  posY: number;
  scale: number;
  /** radar image size in pixels (all CS2 radars are 1024²) */
  size: number;
  /** a muted accent drawn from the map's palette, for header rules and thumbnails */
  accent: string;
}

const MAPS: Record<string, MapInfo> = {
  de_dust2: { id: "de_dust2", posX: -2476, posY: 3239, scale: 4.4, size: 1024, accent: "#c9a86a" },
  de_mirage: { id: "de_mirage", posX: -3230, posY: 1713, scale: 5.0, size: 1024, accent: "#c08f5e" },
  de_inferno: { id: "de_inferno", posX: -2087, posY: 3870, scale: 4.9, size: 1024, accent: "#c2683f" },
  de_nuke: { id: "de_nuke", posX: -3453, posY: 2887, scale: 7, size: 1024, accent: "#6a9fb8" },
  de_overpass: { id: "de_overpass", posX: -4831, posY: 1781, scale: 5.2, size: 1024, accent: "#7d9c6e" },
  de_ancient: { id: "de_ancient", posX: -2953, posY: 2164, scale: 5, size: 1024, accent: "#6b9475" },
  de_anubis: { id: "de_anubis", posX: -2796, posY: 3328, scale: 5.22, size: 1024, accent: "#c9b27a" },
  de_vertigo: { id: "de_vertigo", posX: -3168, posY: 1762, scale: 4.0, size: 1024, accent: "#8ea6ba" },
  de_train: { id: "de_train", posX: -2308, posY: 2078, scale: 4.082077, size: 1024, accent: "#9a9a8c" },
};

export const mapInfo = (map: string): MapInfo | null => MAPS[map] ?? null;
export const mapAccent = (map: string) => MAPS[map]?.accent ?? "#ac957a";
export const radarUrl = (map: string) => (MAPS[map] ? `${BASE}/radars/${map}_radar_psd.png` : null);
export const emblemUrl = (map: string) => (MAPS[map] ? `${BASE}/${map}.png` : null);

/** World position to radar pixels (0..size). */
export function toRadar(info: MapInfo, x: number, y: number): [number, number] {
  return [(x - info.posX) / info.scale, (info.posY - y) / info.scale];
}

export const REMOTE_IMAGE_ORIGINS = ["https://raw.githubusercontent.com", "https://img-cdn.hltv.org", "https://flagcdn.com"];
