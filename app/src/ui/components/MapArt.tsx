// Map imagery. The radar comes from the web (data/maps.ts) with the game's overview transform. For a
// map without a known transform, marks are framed in a box fitted around them; when the image does
// not load, the marks draw on the plain card.
import { useState, type ReactNode } from "react";
import { mapInfo, radarUrl, toRadar } from "../data/maps";

/** Margin around fitted marks, world units. */
const FIT_PAD = 256;

/** Radar-space frame: either the map's overview transform or a box fitted around the points. */
export interface Frame { size: number; to: (x: number, y: number) => [number, number] }

export function frameFor(map: string, points: [number, number][] = []): Frame | null {
  const info = mapInfo(map);
  if (info) return { size: info.size, to: (x, y) => toRadar(info, x, y) };
  if (!points.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const span = Math.max(x1 - x0, y1 - y0) + FIT_PAD;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const s = 1024 / span;
  return { size: 1024, to: (x, y) => [(x - cx) * s + 512, (cy - y) * s + 512] };
}

/** The radar image for a map; nothing when it does not load. */
export function RadarImage({ map }: { map: string }) {
  const url = radarUrl(map);
  const [failed, setFailed] = useState(!url);
  const [loaded, setLoaded] = useState(false);
  if (failed) return null;
  return (
    <img
      src={url!}
      alt=""
      className="radar-img"
      draggable={false}
      style={{ opacity: loaded ? 1 : 0, transition: "opacity var(--d-atmos) ease" }}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * The match hero's atmosphere: the map's radar, desaturated and faint, pinned top-right and masked
 * to transparent. Crossfades when the match changes.
 */
export function MapAtmosphere({ map }: { map: string }) {
  if (!mapInfo(map)) return null;
  return (
    <div className="atmos atmos--map" key={map} aria-hidden>
      <RadarImage map={map} />
    </div>
  );
}

export interface RadarMark { key: string; x: number; y: number; node: ReactNode }

/**
 * A square radar with marks placed in radar pixels. Marks are SVG (crisp at any size, focusable for
 * hover cards); the image sits underneath.
 */
export function RadarView({ map, frame, children, label }: { map: string; frame: Frame; children: ReactNode; label: string }) {
  return (
    <div className="radar-view">
      <RadarImage map={map} />
      <svg viewBox={`0 0 ${frame.size} ${frame.size}`} className="radar-marks" role="img" aria-label={label}>
        {children}
      </svg>
    </div>
  );
}
