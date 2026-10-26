// Map identity: radar image, emblem and the radar's world-to-pixel transform. The images are Valve's
// art, so they come only from the local icon pack (data/icons.ts) that scripts/extract-icon-pack.cjs
// builds from the user's own CS2 install. Without the pack, views draw a backdrop from the recorded
// position samples (components/MapArt.tsx) and emblems show a monogram (components/bits.tsx).
// Transforms are the numbers in the game's overview files, as copied in data/radar_info/<map>.txt of
// the MurkyYT/cs2-map-icons repository on 2026-10-25.

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

/** Every map with a known transform. */
export const knownMaps = (): string[] => Object.keys(MAPS);
export const mapInfo = (map: string): MapInfo | null => MAPS[map] ?? null;
export const mapAccent = (map: string) => MAPS[map]?.accent ?? "#ac957a";
/** The icon pack id of the map's radar (its upper floor on a two-floor map); null for an unknown map. */
export const radarIcon = (map: string) => (MAPS[map] ? `radar_${map}` : null);
/** The icon pack id of the map's emblem; null for an unknown map. */
export const emblemIcon = (map: string) => (MAPS[map] ? `map_${map}` : null);

/** World position to radar pixels (0..size). */
export function toRadar(info: MapInfo, x: number, y: number): [number, number] {
  return [(x - info.posX) / info.scale, (info.posY - y) / info.scale];
}

/** The only origins remote images load from: the pro pack's photos, team logos and flags. The Tauri
 *  CSP's img-src lists the same origins (src-tauri/tauri.conf.json; packs.test.ts fails if the two
 *  drift apart). */
export const REMOTE_IMAGE_ORIGINS = ["https://img-cdn.hltv.org", "https://flagcdn.com"];

/** The URL when it is an image on an allowed origin, else null (an invalid URL included). */
export function allowedImage(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try { return REMOTE_IMAGE_ORIGINS.includes(new URL(url).origin) ? url : null; } catch { return null; }
}
