// Official CS2 icons from the local icon pack: %APPDATA%\BotMatchStats\packs\icons, extracted from the
// user's own CS2 install by cs2-stats-data/tools/icon-pack/extract-icons.js. They are Valve's art, so
// they never enter the repository; every place that draws one falls back to the app's own glyph when
// the pack or the icon is missing (components/GameIcon.tsx).
//
// packs/icons/manifest.json: { "version": 1, "source": string, "icons": { "<id>": "<folder>/<file>.svg" } }
// Ids are the game's weapon names (ak47, m4a1_silencer, hegrenade, …), killfeed modifiers (headshot,
// wallbang, smoke, noscope, blind, inair, …) and round ends (elimination, bomb_exploded, bomb_defused, time).
import { useEffect, useState } from "react";
import type { Host } from "../../host/host";
import { useData } from "./provider";

export interface IconManifest { source: string; icons: Record<string, string> }

const SAFE_PATH = /^[a-z0-9_]+\/[a-z0-9_]+\.svg$/;

/** Checks the manifest's shape and names the first problem; a path must stay inside the icons folder. */
export function parseIconManifest(text: string): IconManifest {
  const raw = JSON.parse(text) as { version?: unknown; source?: unknown; icons?: unknown };
  if (raw.version !== 1) throw new Error(`icons/manifest.json: version is ${JSON.stringify(raw.version)}, this app reads version 1`);
  if (!raw.icons || typeof raw.icons !== "object" || Array.isArray(raw.icons)) throw new Error('icons/manifest.json: "icons" must be an object');
  const icons: Record<string, string> = {};
  for (const [id, file] of Object.entries(raw.icons as Record<string, unknown>)) {
    if (typeof file !== "string" || !SAFE_PATH.test(file)) throw new Error(`icons/manifest.json: icons.${id} must be "<folder>/<name>.svg" inside the icons folder`);
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
      return b ? URL.createObjectURL(new Blob([b], { type: "image/svg+xml" })) : null;
    });
    urls.set(id, u);
  }
  return u;
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
