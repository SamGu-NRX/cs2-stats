// The part of a radar the map is drawn on. Radar images are 1024² with the map on a transparent
// background, and some maps fill little of it (Nuke's drawn area is about half the width), so the
// replay zooms to the drawn pixels of every floor's image. The box is read from the images
// themselves, so it needs no per-map table; when an image cannot be read it is the whole radar.
import { useEffect, useState } from "react";

/** A square in radar pixels (0..1024): left, top, side. */
export interface Box { x: number; y: number; side: number }

export const FULL: Box = { x: 0, y: 0, side: 1024 };

/** Radar pixels left around the drawn area, so a player on the edge of the map keeps its ring. */
export const BOX_PAD = 24;
/** The image is scanned at this size; one scanned pixel is 1024 / SCAN = 8 radar pixels. */
const SCAN = 128;
/**
 * Alpha above which a scanned pixel counts as drawn. The radars carry faint shading past the map
 * (Mirage's reaches 64 radar pixels further at alpha 16 than at 64), which is not worth zooming out for.
 */
const ALPHA_MIN = 64;

/**
 * The square around every pixel with alpha above ALPHA_MIN in an RGBA scan of `w` × `h` pixels that
 * stands for the whole 1024² radar, padded by `pad` radar pixels and kept inside the radar. The
 * square is centred on the drawn area. FULL when nothing is drawn.
 */
export function contentBox(rgba: Uint8ClampedArray, w: number, h: number, pad = BOX_PAD): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] <= ALPHA_MIN) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return FULL;
  const sx = 1024 / w, sy = 1024 / h;
  return square(x0 * sx, y0 * sy, (x1 + 1) * sx, (y1 + 1) * sy, pad);
}

/** The padded square around a rectangle, centred on it and moved (not shrunk) to stay inside the radar. */
export function square(x0: number, y0: number, x1: number, y1: number, pad: number): Box {
  const side = Math.min(1024, Math.max(x1 - x0, y1 - y0) + 2 * pad);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const clamp = (c: number) => Math.min(1024 - side, Math.max(0, c - side / 2));
  return { x: clamp(cx), y: clamp(cy), side };
}

/** The union of two boxes as one square. */
export function union(a: Box, b: Box): Box {
  return square(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x + a.side, b.x + b.side), Math.max(a.y + a.side, b.y + b.side), 0);
}

const boxes = new Map<string, Promise<Box | null>>();

function scan(url: string): Promise<Box | null> {
  let p = boxes.get(url);
  if (!p) {
    p = new Promise<Box | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = SCAN;
          c.height = SCAN;
          // the GPU canvas: Chrome's software canvas (willReadFrequently) resamples with a faint halo
          // that reached the whole radar on Nuke's lower floor
          const g = c.getContext("2d");
          if (!g) return resolve(null);
          g.drawImage(img, 0, 0, SCAN, SCAN);
          resolve(contentBox(g.getImageData(0, 0, SCAN, SCAN).data, SCAN, SCAN));
        } catch {
          resolve(null); // a tainted canvas: the image's origin does not allow reading it
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
    boxes.set(url, p);
  }
  return p;
}

/**
 * The drawn area of the given radar images together; FULL when none can be read. `ready` turns true
 * once every image has been read or has failed, so the replay can wait instead of jumping its zoom.
 */
export function useRadarBox(urls: (string | null)[]): { box: Box; ready: boolean } {
  const key = urls.filter(Boolean).join("|");
  const [st, setSt] = useState<{ key: string; box: Box }>({ key: "", box: FULL });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void Promise.all(key.split("|").map(scan)).then((bs) => {
      const got = bs.filter((b): b is Box => b !== null);
      if (alive) setSt({ key, box: got.length ? got.reduce(union) : FULL });
    });
    return () => { alive = false; };
  }, [key]);
  if (!key) return { box: FULL, ready: true };
  return st.key === key ? { box: st.box, ready: true } : { box: FULL, ready: false };
}
