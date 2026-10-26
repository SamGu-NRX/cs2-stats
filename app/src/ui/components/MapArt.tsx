// Map imagery. The radar comes from the local icon pack (data/maps.ts) with the game's overview
// transform. For a map without a known transform, marks are framed in a box fitted around them. When
// the pack has no radar for the map, or the map has no known transform, the walkable shape is drawn
// instead from where the players of your matches on that map stood alive (Summary.presence cells), in
// the same radar coordinates, so marks land in the same place either way.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CELL, cellCentre, GRID, type Presence } from "../../stats/positions";
import { useRollups } from "../data/hooks";
import { useGameIcon } from "../data/icons";
import { mapInfo, radarIcon, toRadar } from "../data/maps";
import { useData } from "../data/provider";

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

/**
 * Where every player of your matches on the map stood alive, both sides; null while it loads or
 * when those matches hold no position samples there.
 */
function useMapPresence(map: string): Presence | null {
  const { matches } = useData();
  const qs = useMemo(() => {
    const on = matches.filter((m) => m.match.map === map);
    const ids = [...new Set(on.flatMap((m) => m.players.map((p) => p.id)))];
    return on.length && ids.length ? [{ files: on.map((m) => m.file), filter: { player: ids, maps: [map] } }] : null;
  }, [matches, map]);
  const p = useRollups(qs).data?.[0]?.presence[map] ?? null;
  return p && Object.keys(p.cells).length ? p : null;
}

/** Draws the sampled cells into a canvas: a soft fill, plus an outline where a cell has no sampled neighbour. */
function drawSamples(cv: HTMLCanvasElement, cells: number[], frame: Frame) {
  cv.width = frame.size;
  cv.height = frame.size;
  const g = cv.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, frame.size, frame.size);
  // one cell's side in radar pixels, from the frame itself, so fitted frames draw cells to scale too
  const cs = Math.abs(frame.to(CELL, 0)[0] - frame.to(0, 0)[0]);
  const h = cs / 2;
  const set = new Set(cells);
  const at = cells.map((c) => frame.to(...cellCentre(c)));
  g.fillStyle = "rgba(172,149,122,0.22)";
  for (const [x, y] of at) g.fillRect(x - h, y - h, cs + 0.6, cs + 0.6);
  g.strokeStyle = "rgba(255,215,173,0.5)";
  g.lineWidth = 1.5;
  g.beginPath();
  cells.forEach((c, i) => {
    const [x, y] = at[i];
    // the next cell up in world y (c + GRID) is up on the radar, whose y runs downward
    if (!set.has(c - 1)) { g.moveTo(x - h, y - h); g.lineTo(x - h, y + h); }
    if (!set.has(c + 1)) { g.moveTo(x + h, y - h); g.lineTo(x + h, y + h); }
    if (!set.has(c + GRID)) { g.moveTo(x - h, y - h); g.lineTo(x + h, y - h); }
    if (!set.has(c - GRID)) { g.moveTo(x - h, y + h); g.lineTo(x + h, y + h); }
  });
  g.stroke();
}

function SampledCanvas({ presence, frame }: { presence: Presence; frame: Frame }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawSamples(ref.current, Object.keys(presence.cells).map(Number), frame);
  }, [presence, frame]);
  return <canvas ref={ref} className="radar-img" aria-hidden />;
}

function SampledShape({ map, frame }: { map: string; frame: Frame }) {
  const presence = useMapPresence(map);
  return presence ? <SampledCanvas presence={presence} frame={frame} /> : null;
}

/**
 * The radar image for a map from the icon pack, or the sampled shape when the pack has no radar for
 * it or the image does not load. Nothing draws while the pack is being read.
 */
export function RadarImage({ map, frame }: { map: string; frame: Frame }) {
  const url = useGameIcon(radarIcon(map));
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (url === undefined) return null;
  if (url === null || failed) return <SampledShape map={map} frame={frame} />;
  return (
    <img
      src={url}
      alt=""
      className="radar-img"
      draggable={false}
      style={{ opacity: loaded ? 1 : 0, transition: "opacity var(--d-atmos) ease" }}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}

/** An unknown map's atmosphere: the sampled shape in a frame fitted around its cells. */
function SampledAtmosphere({ map }: { map: string }) {
  const presence = useMapPresence(map);
  const frame = useMemo(() => (presence ? frameFor(map, Object.keys(presence.cells).map((c) => cellCentre(Number(c)))) : null), [map, presence]);
  if (!presence || !frame) return null;
  return (
    <div className="atmos atmos--map" key={map} aria-hidden>
      <SampledCanvas presence={presence} frame={frame} />
    </div>
  );
}

/**
 * The match hero's atmosphere: the map's radar, desaturated and faint, pinned top-right and masked
 * to transparent. Crossfades when the match changes. A map with no known transform shows its
 * sampled shape instead; with no samples either, nothing.
 */
export function MapAtmosphere({ map }: { map: string }) {
  // frameFor with no points is the map's overview transform, or null for an unknown map
  const frame = useMemo(() => frameFor(map), [map]);
  if (!frame) return <SampledAtmosphere key={map} map={map} />;
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
