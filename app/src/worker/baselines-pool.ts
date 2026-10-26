// Which pro pool the comparisons rank against. The app ships public/baselines.json, built on the
// public CS2RB model. A user with the private HLTV win-probability pack derives his matches with it,
// and against the shipped pool the model-dependent rows (Rating 3.0, swing, RWS) would say "Not
// compared". So `pnpm baselines` with the pack writes baselines.local.json into the packs folder
// (%APPDATA%\BotMatchStats\packs, never the repository), and the worker ranks against that file when it
// is present and valid, else against the shipped one.
import type { Baselines } from "../stats/compare";

export type PoolKind = "local" | "shipped";
export const LOCAL_BASELINES = "baselines.local.json";

export interface ChosenPool {
  b: Baselines;
  /** the file's text, whose content hash keys the match entries shown against it */
  text: string;
  pool: PoolKind;
  /** why a local file that exists was not used; null when it was used or there was none */
  localError: string | null;
}

/** Parses a baselines file, or throws naming the file and the field that is wrong. */
export function parseBaselines(text: string, what: string): Baselines {
  let b: Partial<Baselines>;
  try {
    b = JSON.parse(text) as Partial<Baselines>;
  } catch (e) {
    throw new Error(`${what}: not JSON (${(e as Error).message})`);
  }
  if (b === null || typeof b !== "object") throw new Error(`${what}: not an object`);
  if (b.version !== 1) throw new Error(`${what}: version is ${JSON.stringify(b.version)}, this app reads version 1`);
  if (typeof b.model !== "string" || !b.model) throw new Error(`${what}: no model fingerprint`);
  if (!b.pools || typeof b.pools !== "object" || !b.n || typeof b.n !== "object") throw new Error(`${what}: no pools`);
  return b as Baselines;
}

/**
 * The local pool when its file exists and parses, else the shipped one. `local` is the local file's
 * text, null when there is none; `shipped` fetches the shipped file, only when it is needed.
 */
export async function choosePool(local: string | null, shipped: () => Promise<string>): Promise<ChosenPool> {
  let localError: string | null = null;
  if (local !== null) {
    try {
      return { b: parseBaselines(local, LOCAL_BASELINES), text: local, pool: "local", localError: null };
    } catch (e) {
      localError = (e as Error).message;
    }
  }
  const text = await shipped();
  return { b: parseBaselines(text, "baselines.json"), text, pool: "shipped", localError };
}

/** "Pro pool: local (HLTV model)": the pool in use and the win-probability model it was built with. */
export function poolLabel(pool: PoolKind, model: string): string {
  const kind = model.startsWith("hltv-") ? "HLTV model" : model.startsWith("cs2rb-") ? "CS2RB" : `model ${model}`;
  return `Pro pool: ${pool} (${kind})`;
}
