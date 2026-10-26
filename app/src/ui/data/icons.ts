// Official CS2 art from the local icon pack: %APPDATA%\BotMatchStats\packs\icons, extracted from the
// user's own CS2 install by scripts/extract-icon-pack.cjs. It is Valve's art, so it never enters the
// repository. Every game object draws through components/GameIcon.tsx, which shows the object's name as
// text when the pack or the icon is missing; radars and map emblems (maps.ts) fall back to drawn shapes.
//
// packs/icons/manifest.json: { "version": 1, "source": string, "icons": { "<id>": "<folder>/<file>.svg|png" } }
// Ids are the game's weapon names (ak47, m4a1_silencer, hegrenade, …), killfeed modifiers (headshot,
// wallbang, smoke, noscope, blind, inair, …), round ends (elimination, bomb_exploded, bomb_defused, time),
// and map art: radar_<map>, radar_lower_<map> for a map's lower floor, and map_<map> for its emblem.
import { useEffect, useState } from "react";
import type { Host } from "../../host/host";
import { useData } from "./provider";

export interface IconManifest { source: string; icons: Record<string, string> }

// radars are raster textures in the game files, so the extractor writes them as .png
const SAFE_PATH = /^[a-z0-9_]+\/[a-z0-9_]+\.(svg|png)$/;

/** Checks the manifest's shape and names the first problem; a path must stay inside the icons folder. */
export function parseIconManifest(text: string): IconManifest {
  const raw = JSON.parse(text) as { version?: unknown; source?: unknown; icons?: unknown };
  if (raw.version !== 1) throw new Error(`icons/manifest.json: version is ${JSON.stringify(raw.version)}, this app reads version 1`);
  if (!raw.icons || typeof raw.icons !== "object" || Array.isArray(raw.icons)) throw new Error('icons/manifest.json: "icons" must be an object');
  const icons: Record<string, string> = {};
  for (const [id, file] of Object.entries(raw.icons as Record<string, unknown>)) {
    if (typeof file !== "string" || !SAFE_PATH.test(file)) throw new Error(`icons/manifest.json: icons.${id} must be "<folder>/<name>.svg" or ".png" inside the icons folder`);
    icons[id] = file;
  }
  return { source: typeof raw.source === "string" ? raw.source : "", icons };
}

let manifest: Promise<IconManifest | null> | null = null;
const urls = new Map<string, Promise<string | null>>();

function loadManifest(host: Host): Promise<IconManifest | null> {
  // A broken manifest is reported once and the app keeps its own glyphs.
  manifest ??= host.readPack("icons/manifest.json").then(
    (b) => (b ? parseIconManifest(new TextDecoder().decode(b)) : null),
    (e: Error) => { console.error(`Icon pack: ${e.message}`); return null; },
  ).catch((e: Error) => { console.error(`Icon pack: ${e.message}`); return null; });
  return manifest;
}

function loadIcon(host: Host, id: string): Promise<string | null> {
  let u = urls.get(id);
  if (!u) {
    u = loadManifest(host).then(async (m) => {
      const file = m?.icons[id];
      if (!file) return null;
      const b = await host.readPack(`icons/${file}`).catch(() => null);
      return b ? URL.createObjectURL(new Blob([b], { type: file.endsWith(".png") ? "image/png" : "image/svg+xml" })) : null;
    });
    urls.set(id, u);
  }
  return u;
}

/** The pack's manifest; undefined while loading, null when the pack is missing or unreadable. */
export function useIconManifest(): IconManifest | null | undefined {
  const { host } = useData();
  const [m, setM] = useState<IconManifest | null | undefined>(undefined);
  useEffect(() => {
    if (!host) return;
    let alive = true;
    void loadManifest(host).then((x) => alive && setM(x));
    return () => { alive = false; };
  }, [host]);
  return m;
}

/** The icon's URL; undefined while loading, null when the pack or the icon is missing. */
export function useGameIcon(id: string | null): string | null | undefined {
  const { host } = useData();
  const [url, setUrl] = useState<string | null | undefined>(id ? undefined : null);
  useEffect(() => {
    if (!host || !id) { setUrl(id ? undefined : null); return; }
    let alive = true;
    setUrl(undefined);
    void loadIcon(host, id).then((u) => alive && setUrl(u));
    return () => { alive = false; };
  }, [host, id]);
  return url;
}
