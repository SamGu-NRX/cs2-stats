// Draws one moment of a round on the replay canvas: smokes and fires, grenade flights, kill lines,
// the bomb, players, then flash and HE pops on top. Pure drawing over the timeline and the player
// states the caller interpolated (stats/replay-interp.ts); it keeps no state between calls.
//
// Sizes are CSS pixels and do not scale with the map, so a dot reads the same on every radar; areas
// that exist in the world (smoke, fire) are world units turned into radar pixels.
import type { RoundTimeline, ReplayThrow, Vec3 } from "../../../../stats/replay";
import type { PlayerState } from "../../../../stats/replay-interp";
import type { Side } from "../../../../stats/tables";
import { levelOf, type Level } from "../../../data/radar-levels";
import type { Sprites } from "./sprites";

/**
 * A smoke's radius in world units: the 144-unit sphere the extractor's smoke_blocked and the plugin's
 * shot smoke flag use (extractor/SCHEMA-v1.md "Visibility"; awpy's default). Not measured in-game.
 */
export const SMOKE_RADIUS = 144;
/**
 * How far a fire reaches, world units. The demo keeps only the fire's origin and lifetime, not its
 * flames (extractor/SCHEMA-v1.md, "Not in the demo"). 150 is CS:GO's inferno_max_range default; it is
 * not verified for CS2, so the area is drawn as a soft falloff rather than a hard edge.
 */
export const FIRE_RADIUS = 150;
/** Seconds a kill line stays (the brief: flashed for 1 s), a pop lasts, and a flight's trail fades. */
export const KILL_FLASH_S = 1;
const POP_S = 0.45;
const TRAIL_FADE_S = 1.2;
/** Seconds a smoke takes to bloom and to clear at either end of its life. */
const SMOKE_EDGE_S = 0.5;
/** Seconds the explosion mark stays after the bomb goes off. */
const BOOM_S = 2;

export interface Palette { t: string; ct: string; cream: string; ink: string; ink2: string; ink3: string; bg0: string }

export interface Scene {
  map: string;
  /** world to radar pixels (0..1024), the map's overview transform or a fitted frame */
  to: (x: number, y: number) => [number, number];
  /** radar pixels per world unit */
  unit: number;
  /** canvas size in CSS pixels, and device pixels per CSS pixel */
  size: number;
  dpr: number;
  /** the floor shown, on a map with two; null on a one-radar map */
  level: Level | null;
  you: string | null;
  hover: string | null;
  names: boolean;
  /** reduced motion: pops do not grow */
  reduce: boolean;
  palette: Palette;
  sprites: Sprites;
  nameOf: Map<string, string>;
}

/** Off-floor things are drawn this faint, so the other floor's fight stays readable without competing. */
const OFF_FLOOR = 0.28;

const sideColour = (p: Palette, s: Side | null) => (s === "T" ? p.t : s === "CT" ? p.ct : p.ink3);
const easeOut = (f: number) => 1 - Math.pow(1 - f, 3);

export function drawScene(g: CanvasRenderingContext2D, tl: RoundTimeline, t: number, players: PlayerState[], s: Scene): void {
  const k = s.size / 1024;
  const px = (x: number, y: number): [number, number] => { const [a, b] = s.to(x, y); return [a * k, b * k]; };
  const floorAlpha = (z: number) => (s.level === null || levelOf(s.map, z) === s.level ? 1 : OFF_FLOOR);
  const pal = s.palette;
  g.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  g.clearRect(0, 0, s.size, s.size);
  g.lineCap = "round";
  g.lineJoin = "round";

  // smokes and fires, under everything
  for (const e of tl.effects) {
    if ((e.kind !== "smoke" && e.kind !== "molotov") || t < e.t || t > e.until) continue;
    const [x, y] = px(e.at[0], e.at[1]);
    const a = floorAlpha(e.at[2]);
    if (e.kind === "smoke") {
      const r = SMOKE_RADIUS * s.unit * k;
      const grow = Math.min(1, (t - e.t) / SMOKE_EDGE_S);
      const fade = Math.min(1, (e.until - t) / SMOKE_EDGE_S);
      const scale = s.reduce ? 1 : 0.7 + 0.3 * easeOut(grow);
      g.globalAlpha = a * Math.min(grow, fade);
      const grad = g.createRadialGradient(x, y, 0, x, y, r * scale);
      grad.addColorStop(0, "rgba(206,202,196,0.42)");
      grad.addColorStop(0.75, "rgba(190,186,180,0.34)");
      grad.addColorStop(1, "rgba(170,166,160,0.12)");
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r * scale, 0, Math.PI * 2); g.fill();
      g.strokeStyle = sideColour(pal, e.side);
      g.globalAlpha *= 0.55;
      g.lineWidth = 1;
      g.stroke();
    } else {
      const r = FIRE_RADIUS * s.unit * k;
      g.globalAlpha = a * Math.min(1, (t - e.t) / 0.25, (e.until - t) / 0.5);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, withAlpha(sideColour(pal, e.side), 0.5));
      grad.addColorStop(0.55, withAlpha(sideColour(pal, e.side), 0.28));
      grad.addColorStop(1, withAlpha(sideColour(pal, e.side), 0));
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      s.sprites.draw(g, "molotov", x, y, 13, pal.ink);
    }
  }
  g.globalAlpha = 1;

  // grenade flights: the trail so far and the grenade at its head; the trail fades after it lands
  for (const th of tl.throws) {
    const start = th.path[0];
    if (t < start || t > th.end + TRAIL_FADE_S) continue;
    const head = headOf(th, t);
    const fading = t > th.end ? 1 - (t - th.end) / TRAIL_FADE_S : 1;
    g.globalAlpha = fading * floorAlpha(head[2]) * 0.7;
    g.strokeStyle = sideColour(pal, th.side);
    g.lineWidth = 1.25;
    g.beginPath();
    for (let i = 0; i < th.path.length && th.path[i] <= t; i += 4) {
      const [x, y] = px(th.path[i + 1], th.path[i + 2]);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    const [hx, hy] = px(head[0], head[1]);
    g.lineTo(hx, hy);
    g.stroke();
    if (t <= th.end) {
      g.globalAlpha = floorAlpha(head[2]);
      if (!s.sprites.draw(g, NADE_SPRITE[th.kind], hx, hy, 12, sideColour(pal, th.side), pal.bg0)) {
        g.fillStyle = sideColour(pal, th.side);
        g.beginPath(); g.arc(hx, hy, 2.5, 0, Math.PI * 2); g.fill();
      }
    }
  }
  g.globalAlpha = 1;

  // kill lines, from where the killer stood to the victim, flashed for KILL_FLASH_S
  for (const kl of tl.kills) {
    if (t < kl.t || t > kl.t + KILL_FLASH_S || !kl.kpos || !kl.vpos) continue;
    const f = (t - kl.t) / KILL_FLASH_S;
    const [x1, y1] = px(kl.kpos[0], kl.kpos[1]);
    const [x2, y2] = px(kl.vpos[0], kl.vpos[1]);
    g.globalAlpha = (1 - f * f) * Math.max(floorAlpha(kl.kpos[2]), floorAlpha(kl.vpos[2]));
    g.strokeStyle = sideColour(pal, kl.killerSide);
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }
  g.globalAlpha = 1;

  drawBomb(g, tl, t, s, px, floorAlpha);

  // the dead first, so the living stay on top
  for (const p of players) {
    if (p.alive) continue;
    const [x, y] = px(p.x, p.y);
    g.globalAlpha = floorAlpha(p.z) * 0.85;
    cross(g, x, y, 4.5, sideColour(pal, p.side), pal.bg0);
  }
  for (const p of players) {
    if (!p.alive) continue;
    const [x, y] = px(p.x, p.y);
    g.globalAlpha = floorAlpha(p.z);
    drawPlayer(g, p, x, y, s);
  }
  g.globalAlpha = 1;

  // flash and HE pops on top: a ring that grows and fades (with reduced motion it only fades)
  for (const e of tl.effects) {
    if ((e.kind !== "flash" && e.kind !== "he") || t < e.t || t > e.t + POP_S) continue;
    const f = (t - e.t) / POP_S;
    const [x, y] = px(e.at[0], e.at[1]);
    const r = s.reduce ? 18 : 6 + 22 * easeOut(f);
    g.globalAlpha = floorAlpha(e.at[2]) * (1 - f);
    if (e.kind === "flash") {
      g.fillStyle = withAlpha(pal.ink, 0.35);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = e.kind === "flash" ? pal.ink : sideColour(pal, e.side);
    g.lineWidth = e.kind === "flash" ? 1.5 : 2.5;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  }
  g.globalAlpha = 1;

  // names: all of them when asked, else the hovered player's
  g.font = `600 11px ${getFontFamily()}`;
  g.textAlign = "center";
  g.textBaseline = "top";
  for (const p of players) {
    if (!(s.names || p.id === s.hover)) continue;
    const [x, y] = px(p.x, p.y);
    const name = s.nameOf.get(p.id) ?? p.id;
    g.globalAlpha = floorAlpha(p.z) * (p.alive ? 1 : 0.7);
    g.lineWidth = 3;
    g.strokeStyle = withAlpha(pal.bg0, 0.85);
    g.strokeText(name, x, y + 14);
    g.fillStyle = p.id === s.you ? pal.cream : pal.ink;
    g.fillText(name, x, y + 14);
  }
  g.globalAlpha = 1;
}

const NADE_SPRITE: Record<ReplayThrow["kind"], string> = { smoke: "smokegrenade", flash: "flashbang", he: "hegrenade", molotov: "molotov", decoy: "decoy" };

/** Where a flight is at t: between its two path points around t, or its end point. */
export function headOf(th: ReplayThrow, t: number): Vec3 {
  const p = th.path;
  const n = p.length / 4;
  if (t <= p[0]) return [p[1], p[2], p[3]];
  for (let i = 1; i < n; i++) {
    const t1 = p[i * 4];
    if (t1 >= t) {
      const t0 = p[(i - 1) * 4];
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      const a = (i - 1) * 4;
      const b = i * 4;
      return [p[a + 1] + (p[b + 1] - p[a + 1]) * f, p[a + 2] + (p[b + 2] - p[a + 2]) * f, p[a + 3] + (p[b + 3] - p[a + 3]) * f];
    }
  }
  return [p[(n - 1) * 4 + 1], p[(n - 1) * 4 + 2], p[(n - 1) * 4 + 3]];
}

function drawPlayer(g: CanvasRenderingContext2D, p: PlayerState, x: number, y: number, s: Scene) {
  const pal = s.palette;
  const c = sideColour(pal, p.side);
  // view direction: world yaw counter-clockwise from east; the radar's y runs down
  const a = (-p.yaw * Math.PI) / 180;
  const spread = (24 * Math.PI) / 180;
  const grad = g.createRadialGradient(x, y, 6, x, y, 32);
  grad.addColorStop(0, withAlpha(c, 0.6));
  grad.addColorStop(1, withAlpha(c, 0));
  g.fillStyle = grad;
  g.beginPath(); g.moveTo(x, y); g.arc(x, y, 32, a - spread, a + spread); g.closePath(); g.fill();
  // HP ring: a dark track and the remaining HP clockwise from the top
  g.lineWidth = 2;
  g.strokeStyle = withAlpha(pal.bg0, 0.75);
  g.beginPath(); g.arc(x, y, 9.5, 0, Math.PI * 2); g.stroke();
  if (p.hp !== null && p.hp > 0) {
    g.strokeStyle = pal.ink;
    g.beginPath(); g.arc(x, y, 9.5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.min(100, p.hp)) / 100); g.stroke();
  }
  g.fillStyle = c;
  g.strokeStyle = pal.bg0;
  g.lineWidth = 1.5;
  g.beginPath(); g.arc(x, y, 6.5, 0, Math.PI * 2); g.fill(); g.stroke();
  if (p.id === s.you) {
    g.strokeStyle = pal.cream;
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke();
  }
  if (p.id === s.hover) {
    g.strokeStyle = withAlpha(pal.ink, 0.7);
    g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, 16, 0, Math.PI * 2); g.stroke();
  }
}

function drawBomb(g: CanvasRenderingContext2D, tl: RoundTimeline, t: number, s: Scene, px: (x: number, y: number) => [number, number], floorAlpha: (z: number) => number) {
  const pal = s.palette;
  let shown: { id: string; at: Vec3; colour: string } | null = null;
  for (const b of tl.bomb) {
    if (b.t > t || !b.at) continue;
    if (b.kind === "plant") shown = { id: "planted_c4", at: b.at, colour: pal.t };
    else if (b.kind === "defuse") shown = { id: "defuser", at: b.at, colour: pal.ct };
    else shown = t <= b.t + BOOM_S ? { id: "bomb_exploded", at: b.at, colour: pal.t } : null;
  }
  if (!shown) return;
  const [x, y] = px(shown.at[0], shown.at[1]);
  g.globalAlpha = floorAlpha(shown.at[2]);
  g.fillStyle = withAlpha(pal.bg0, 0.85);
  g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill();
  g.strokeStyle = shown.colour;
  g.lineWidth = 1.5;
  g.stroke();
  if (!s.sprites.draw(g, shown.id, x, y, 14, shown.colour)) {
    g.fillStyle = shown.colour;
    g.fillRect(x - 4, y - 4, 8, 8);
  }
  g.globalAlpha = 1;
}

function cross(g: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string, under: string) {
  g.beginPath();
  g.moveTo(x - r, y - r); g.lineTo(x + r, y + r);
  g.moveTo(x + r, y - r); g.lineTo(x - r, y + r);
  g.strokeStyle = under;
  g.lineWidth = 4.5;
  g.stroke();
  g.strokeStyle = colour;
  g.lineWidth = 2;
  g.stroke();
}

/** A #rrggbb colour with alpha; other colour strings pass through unchanged. */
export function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

let family: string | null = null;
function getFontFamily(): string {
  family ??= getComputedStyle(document.documentElement).getPropertyValue("--f").trim() || "sans-serif";
  return family;
}
