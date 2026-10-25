// Map imagery. The radar comes from the web (data/maps.ts); when it cannot load, the walkable shape
// of the map is drawn from every recorded position sample on it, in the same radar coordinates, so
// marks land in the same place either way.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CELL, GRID, HALF_EXTENT, type PosAgg } from "../../stats/positions";
import { useMapPositions } from "../data/hooks";
import { mapInfo, radarUrl, toRadar, type MapInfo } from "../data/maps";

const cellWorld = (c: number): [number, number] => [(c % GRID) * CELL - HALF_EXTENT + CELL / 2, Math.floor(c / GRID) * CELL - HALF_EXTENT + CELL / 2];

/** Radar-space frame: either the map's overview transform or a box fitted around the samples. */
export interface Frame { size: number; to: (x: number, y: number) => [number, number] }

export function frameFor(map: string, pos: PosAgg | null, extra: [number, number][] = []): Frame | null {
  const info = mapInfo(map);
  if (info) return { size: info.size, to: (x, y) => toRadar(info, x, y) };
  const pts = [...Object.keys(pos?.all ?? {}).map((c) => cellWorld(+c)), ...extra];
  if (!pts.length) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const span = Math.max(x1 - x0, y1 - y0) + CELL * 4;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const s = 1024 / span;
  return { size: 1024, to: (x, y) => [(x - cx) * s + 512, (cy - y) * s + 512] };
}

/** Draws the sampled walkable shape into a canvas: soft fill plus a crisp outline. */
function drawSamples(cv: HTMLCanvasElement, pos: PosAgg, frame: Frame, info: MapInfo | null) {
  const size = frame.size;
  cv.width = size;
  cv.height = size;
  const g = cv.getContext("2d")!;
  g.clearRect(0, 0, size, size);
  const cs = info ? CELL / info.scale : 8;
  const cells = Object.keys(pos.all).map(Number);
  const set = new Set(cells);
  g.fillStyle = "rgba(172,149,122,0.22)";
  for (const c of cells) {
    const [x, y] = frame.to(...cellWorld(c));
    g.fillRect(x - cs / 2, y - cs / 2, cs + 0.6, cs + 0.6);
  }
  g.strokeStyle = "rgba(255,215,173,0.5)";
  g.lineWidth = 1.5;
  g.beginPath();
  for (const c of cells) {
    const [x, y] = frame.to(...cellWorld(c));
    const h = cs / 2;
    if (!set.has(c - 1)) { g.moveTo(x - h, y - h); g.lineTo(x - h, y + h); }
    if (!set.has(c + 1)) { g.moveTo(x + h, y - h); g.lineTo(x + h, y + h); }
    if (!set.has(c + GRID)) { g.moveTo(x - h, y - h); g.lineTo(x + h, y - h); }
    if (!set.has(c - GRID)) { g.moveTo(x - h, y + h); g.lineTo(x + h, y + h); }
  }
  g.stroke();
}

function SampledShape({ map, frame }: { map: string; frame: Frame }) {
  const pos = useMapPositions(map).data;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (pos && ref.current) drawSamples(ref.current, pos, frame, mapInfo(map));
  }, [pos, frame, map]);
  return <canvas ref={ref} className="radar-img" aria-hidden />;
}

/** The radar image for a map, or the sampled shape when the image does not load. */
export function RadarImage({ map, frame }: { map: string; frame: Frame }) {
  const url = radarUrl(map);
  const [failed, setFailed] = useState(!url);
  const [loaded, setLoaded] = useState(false);
  if (failed) return <SampledShape map={map} frame={frame} />;
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
  const pos = useMapPositions(map).data;
  const frame = useMemo(() => frameFor(map, pos), [map, pos]);
  if (!frame) return null;
  return (
    <div className="atmos atmos--map" key={map} aria-hidden>
      <RadarImage map={map} frame={frame} />
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
      <RadarImage map={map} frame={frame} />
      <svg viewBox={`0 0 ${frame.size} ${frame.size}`} className="radar-marks" role="img" aria-label={label}>
        {children}
      </svg>
    </div>
  );
}
