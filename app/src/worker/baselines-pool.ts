// Which pro pool the comparisons rank against. The app ships public/baselines.json, built on the
// public CS2RB model. A user with the private HLTV win-probability pack derives his matches with it,
// and against the shipped pool the model-dependent rows (Rating 3.0, swing, RWS) would say "Not
// compared". So `pnpm baselines` with the pack writes baselines.local.json into the packs folder
// (%APPDATA%\BotMatchStats\packs, never the repository), and the worker ranks against that file when it
// is present and valid, else against the shipped one.
import { QUANTILES, type Baselines } from "../stats/compare";

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

const SIDES = ["both", "CT", "T"];

/**
 * Checks a pool's contents, not only its shape: a percentile read from a quantile list that is not
 * finite, out of order or the wrong length would be NaN or wrong without any error. Every pool and
 * side's metrics are null (too few pros had a value) or QUANTILES.length finite, non-decreasing
 * numbers; every pool has its counts in `n` as positive integers; and the "all" pool exists.
 */
function checkPools(b: Baselines, what: string): void {
  if (!b.pools.all?.both) throw new Error(`${what}: no "all" pool`);
  for (const [pool, sides] of Object.entries(b.pools)) {
    if (!sides || typeof sides !== "object") throw new Error(`${what}: pool ${pool} is not an object`);
    const counts = b.n[pool];
    if (!counts || typeof counts !== "object") throw new Error(`${what}: pool ${pool} has no counts in n`);
    for (const [side, metrics] of Object.entries(sides)) {
      if (!SIDES.includes(side)) throw new Error(`${what}: pool ${pool} has an unknown side ${side}`);
      const c = (counts as Record<string, unknown>)[side];
      if (typeof c !== "number" || !Number.isInteger(c) || c <= 0) throw new Error(`${what}: n.${pool}.${side} is ${JSON.stringify(c)}, not a positive integer`);
      if (!metrics || typeof metrics !== "object") throw new Error(`${what}: pool ${pool}.${side} is not an object`);
      for (const [id, q] of Object.entries(metrics)) {
        if (q === null) continue;
        const at = `${what}: ${pool}.${side}.${id}`;
        if (!Array.isArray(q) || q.length !== QUANTILES.length) throw new Error(`${at} is not ${QUANTILES.length} quantiles`);
        for (let i = 0; i < q.length; i++) {
          if (typeof q[i] !== "number" || !Number.isFinite(q[i])) throw new Error(`${at}[${i}] is ${typeof q[i] === "number" ? String(q[i]) : JSON.stringify(q[i])}, not a finite number`);
          if (i && q[i] < q[i - 1]) throw new Error(`${at} decreases at quantile ${i}`);
        }
      }
    }
  }
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
  checkPools(b as Baselines, what);
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
