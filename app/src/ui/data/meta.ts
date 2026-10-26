// The engine's descriptions of its metrics, attributes and rating, as the stats worker sent them at
// start (worker/protocol.ts Meta). The UI thread does not load the engine, so labels and units come
// from here. DataProvider sets them before any view that reads them renders.
import type { Meta, MetricMeta } from "../../worker/protocol";

let current: Meta | null = null;
let byId = new Map<string, MetricMeta>();

export function setMeta(m: Meta) {
  current = m;
  byId = new Map(m.metrics.map((x) => [x.id, x]));
}

export const metaLoaded = () => current !== null;

function need(): Meta {
  if (!current) throw new Error("Engine descriptions were read before the stats worker sent them (DataProvider sets them first)");
  return current;
}

export function metric(id: string): MetricMeta {
  need();
  const m = byId.get(id);
  if (!m) throw new Error(`The engine has no metric "${id}"`);
  return m;
}

export const metrics = () => need().metrics;
export const attributeDefs = () => need().attributes;
export const ratingInfo = () => need().rating;
export const winProbInfo = () => need().winProb;
export const styleIds = () => need().style;
export const deriveVersion = () => need().deriveVersion;
export const roleSignals = () => need().signals;
export const awperKpr = () => need().awperKpr;
