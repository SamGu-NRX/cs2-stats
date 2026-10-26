// Official icons from the local pack (data/icons.ts) for the canvas: each loads as an image once, then
// is tinted and rasterised per colour and size and kept, so drawing one in the play loop is a single
// drawImage. A missing pack or icon leaves draw() returning false, and the scene draws its own mark.
import { useEffect } from "react";
import { useGameIcon } from "../../../data/icons";

/** Every icon the scene draws. */
export const SPRITE_IDS = ["planted_c4", "defuser", "bomb_exploded", "smokegrenade", "flashbang", "hegrenade", "molotov", "decoy"] as const;

export class Sprites {
  private images = new Map<string, HTMLImageElement>();
  private tinted = new Map<string, HTMLCanvasElement>();
  /** called when an icon arrives, so a paused scene can redraw with it */
  onLoad: () => void = () => {};
  constructor(private dpr: number) {}

  setDpr(dpr: number) {
    if (dpr !== this.dpr) { this.dpr = dpr; this.tinted.clear(); }
  }

  add(id: string, img: HTMLImageElement) {
    this.images.set(id, img);
    for (const k of [...this.tinted.keys()]) if (k.startsWith(`${id}|`)) this.tinted.delete(k);
    this.onLoad();
  }

  /**
   * Draws the icon centred at x, y, fitted in a size × size box, in one colour; `halo` puts a dark disc
   * behind it so it reads over the radar. False when the icon is not loaded.
   */
  draw(g: CanvasRenderingContext2D, id: string, x: number, y: number, size: number, colour: string, halo?: string): boolean {
    const img = this.images.get(id);
    if (!img) return false;
    const key = `${id}|${colour}|${size}`;
    let c = this.tinted.get(key);
    if (!c) {
      const nw = img.naturalWidth || 1;
      const nh = img.naturalHeight || 1;
      const s = size / Math.max(nw, nh);
      c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(nw * s * this.dpr));
      c.height = Math.max(1, Math.round(nh * s * this.dpr));
      const o = c.getContext("2d");
      if (!o) return false;
      o.drawImage(img, 0, 0, c.width, c.height);
      o.globalCompositeOperation = "source-in";
      o.fillStyle = colour;
      o.fillRect(0, 0, c.width, c.height);
      this.tinted.set(key, c);
    }
    const w = c.width / this.dpr;
    const h = c.height / this.dpr;
    if (halo) {
      const a = g.globalAlpha;
      g.globalAlpha = a * 0.8;
      g.fillStyle = halo;
      g.beginPath(); g.arc(x, y, size * 0.62, 0, Math.PI * 2); g.fill();
      g.globalAlpha = a;
    }
    g.drawImage(c, x - w / 2, y - h / 2, w, h);
    return true;
  }
}

/** Loads one pack icon into the sheet. Renders nothing. */
function SpriteLoader({ sheet, id }: { sheet: Sprites; id: string }) {
  const url = useGameIcon(id);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => sheet.add(id, img);
    img.src = url;
    return () => { img.onload = null; };
  }, [sheet, id, url]);
  return null;
}

export function SpriteLoaders({ sheet }: { sheet: Sprites }) {
  return <>{SPRITE_IDS.map((id) => <SpriteLoader key={id} sheet={sheet} id={id} />)}</>;
}
