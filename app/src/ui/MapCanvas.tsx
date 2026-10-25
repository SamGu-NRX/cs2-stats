// Top-down map drawn from the data itself: every player's position samples form a grey backdrop
// (the walkable shape of the map, no radar images needed), your samples a heatmap on top, and
// kill/death spots as marks. World +x is right and +y is up.
import { useEffect, useRef } from "react";
import { CELL, GRID, HALF_EXTENT, type PosAgg } from "../stats/positions";

export interface Mark { x: number; y: number; kind: "kill" | "death" | "us" | "them" }

const cellXY = (c: number): [number, number] => [(c % GRID) * CELL - HALF_EXTENT + CELL / 2, Math.floor(c / GRID) * CELL - HALF_EXTENT + CELL / 2];

/** Heat ramp from cool to hot, readable on the light backdrop. */
function heat(t: number): string {
  const stops = [[0, 122, 255], [52, 199, 89], [255, 204, 0], [255, 149, 0], [255, 59, 48]];
  const x = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function MapCanvas({ pos, marks, showHeat, label }: { pos: PosAgg; marks: Mark[]; showHeat: boolean; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = () => {
      const dpr = devicePixelRatio || 1;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const g = cv.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const pts: [number, number][] = [
        ...Object.keys(pos.all).map((c) => cellXY(+c)),
        ...marks.map((m) => [m.x, m.y] as [number, number]),
      ];
      if (!pts.length) return;
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const pad = CELL * 2;
      x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      const s = Math.min(w / (x1 - x0), h / (y1 - y0));
      const ox = (w - (x1 - x0) * s) / 2;
      const oy = (h - (y1 - y0) * s) / 2;
      const X = (x: number) => ox + (x - x0) * s;
      const Y = (y: number) => oy + (y1 - y) * s;
      const cs = Math.max(1, CELL * s);

      // backdrop: where anyone has been
      const allMax = Math.max(1, ...Object.values(pos.all));
      for (const [c, n] of Object.entries(pos.all)) {
        const [x, y] = cellXY(+c);
        g.fillStyle = `rgba(60,60,67,${0.1 + 0.18 * (Math.log1p(n) / Math.log1p(allMax))})`;
        g.fillRect(X(x) - cs / 2, Y(y) - cs / 2, cs + 0.5, cs + 0.5);
      }
      // your heat
      if (showHeat) {
        const hMax = Math.max(1, ...Object.values(pos.human));
        for (const [c, n] of Object.entries(pos.human)) {
          const [x, y] = cellXY(+c);
          const t = Math.log1p(n) / Math.log1p(hMax);
          g.globalAlpha = 0.35 + 0.55 * t;
          g.fillStyle = heat(t);
          g.fillRect(X(x) - cs / 2, Y(y) - cs / 2, cs + 0.5, cs + 0.5);
        }
        g.globalAlpha = 1;
      }
      // marks
      const r = Math.max(3, Math.min(5, cs * 0.6));
      for (const m of marks) {
        const x = X(m.x);
        const y = Y(m.y);
        if (m.kind === "death") {
          g.strokeStyle = "#d70015"; g.lineWidth = 2;
          g.beginPath(); g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); g.stroke();
        } else {
          g.fillStyle = m.kind === "kill" ? "#1f8f3a" : m.kind === "us" ? "rgba(0,122,255,.75)" : "rgba(60,60,67,.45)";
          g.beginPath(); g.arc(x, y, m.kind === "kill" ? r : r * 0.7, 0, Math.PI * 2); g.fill();
          if (m.kind === "kill") { g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); }
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [pos, marks, showHeat]);
  return <canvas ref={ref} className="mapcv" role="img" aria-label={label} />;
}

export function PlaceBars({ places }: { places: Record<string, number> }) {
  const rows = Object.entries(places).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const total = Object.values(places).reduce((a, b) => a + b, 0);
  if (!rows.length) return <p className="note">No position samples.</p>;
  return (
    <div className="places">
      {rows.map(([p, s]) => (
        <div key={p} className="places__row">
          <span>{p}</span>
          <span className="bar"><i style={{ width: `${(100 * s) / rows[0][1]}%` }} /></span>
          <b className="num">{Math.round((100 * s) / total)}%</b>
        </div>
      ))}
    </div>
  );
}
