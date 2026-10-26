// Optional local packs, kept out of the repository (it is open source): pro attribute scores with
// their photo URLs, and agent renders. They live in %APPDATA%\BotMatchStats\packs and load through
// the host at runtime; every view has a clean state when a pack is missing.
//
// packs/pros.json:
//   { "version": 1, "source": string, "pros": Pro[] }
//   Pro scores are 0–100 in ATTRIBUTE_ORDER; photo, logo and flag are image URLs.
// packs/agents/{t,ct}-{portrait,ghost}.png: agent renders for the player card.
import { useEffect, useState } from "react";
import type { Host } from "../../host/host";
import { hideText, useHidePersonal } from "./privacy";
import { useData } from "./provider";

import { parseProPack, type Pro } from "./proPack";
export { ATTRIBUTE_ORDER, HLTV_ORIGIN, parseProPack, type AttributeId, type Pro } from "./proPack";

export type ProPack = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; pros: Pro[]; source: string };

let proPack: Promise<ProPack> | null = null;
function loadPros(host: Host): Promise<ProPack> {
  proPack ??= host.readPack("pros.json").then(
    (b): ProPack => {
      if (!b) return { state: "missing" };
      try { return { state: "ready", ...parseProPack(new TextDecoder().decode(b)) }; } catch (e) { return { state: "error", message: (e as Error).message }; }
    },
    (e: Error): ProPack => ({ state: "error", message: e.message }),
  );
  return proPack;
}

export function usePros(): ProPack {
  const { host } = useData();
  const [pack, setPack] = useState<ProPack>({ state: "loading" });
  useEffect(() => {
    if (!host) return;
    let alive = true;
    void loadPros(host).then((p) => alive && setPack(p));
    return () => { alive = false; };
  }, [host]);
  // the reason a pack could not be read can name its path (privacy.ts)
  const hide = useHidePersonal();
  return hide && pack.state === "error" ? { ...pack, message: hideText(pack.message) } : pack;
}

export interface AgentArt { portrait: string; ghost: string }
export type Agents = Record<"t" | "ct", AgentArt | null>;

let agents: Promise<Agents> | null = null;
function loadAgents(host: Host): Promise<Agents> {
  const url = async (name: string) => {
    try {
      const b = await host.readPack(`agents/${name}.png`);
      return b ? URL.createObjectURL(new Blob([b], { type: "image/png" })) : null;
    } catch { return null; }
  };
  const side = async (s: "t" | "ct"): Promise<AgentArt | null> => {
    const [portrait, ghost] = await Promise.all([url(`${s}-portrait`), url(`${s}-ghost`)]);
    return portrait ? { portrait, ghost: ghost ?? portrait } : null;
  };
  agents ??= Promise.all([side("t"), side("ct")]).then(([t, ct]) => ({ t, ct }));
  return agents;
}

/** Agent renders from the packs folder; a side without them is null and the UI draws a silhouette. */
export function useAgents(): Agents | null {
  const { host } = useData();
  const [a, setA] = useState<Agents | null>(null);
  useEffect(() => {
    if (!host) return;
    let alive = true;
    void loadAgents(host).then((x) => alive && setA(x));
    return () => { alive = false; };
  }, [host]);
  return a;
}
