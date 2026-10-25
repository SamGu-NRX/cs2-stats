// Round win probability. The trained model is the model agent's model/export/winprob.ts, which
// exports winProbabilityCT(state: RoundState, map): P(CT wins). The worker imports it at build
// time when it exists (see app/README.md); this file adapts it and keeps a placeholder otherwise.

import rating3Params from "../../../model/rating3/params.json";

export type BuyType = "PISTOL" | "ECO" | "HALF" | "FULL";

/** State used by the HLTV 3.02 lookup. Equipment is the freeze-end team total. */
export interface Rating3RoundState {
  ctAlive: number;
  tAlive: number;
  planted: 0 | 1;
  ctBuy: BuyType;
  tBuy: BuyType;
  /** Side benefiting from the last death; for a suicide, the opposite side. */
  lastKillSide: "t" | "ct" | "none";
  /** Set only when the end event has occurred, not from the eventual round winner. */
  terminalWinner?: "t" | "ct";
}

interface ProbabilityTable {
  columns: readonly string[];
  states: Record<string, { p_t: number; n: number } | undefined>;
}
const rating3Tables: readonly ProbabilityTable[] = rating3Params.winProbability.tables;

/**
 * HLTV probability reconstruction. The held-out error and fitting population live
 * beside the lookup in params.json. Most post-plant misses are frozen graph values
 * after the bomb becomes unpreventable; this state has no timing to detect that.
 * Unknown maps use the pooled-map fallback, not a guessed map identity.
 */
export function rating3WinProbabilityCT(state: Rating3RoundState, map: string): number | null {
  if (![state.ctAlive, state.tAlive].every((n) => Number.isInteger(n) && n >= 0 && n <= 5)) {
    throw new RangeError("Rating 3 alive counts must be integers from 0 to 5");
  }
  if (state.terminalWinner !== undefined) return state.terminalWinner === "ct" ? 1 : 0;
  const name = map.replace(/^de_/, "").toLowerCase();
  const canonicalMap = name === "dust2" ? "Dust2" : name[0]?.toUpperCase() + name.slice(1);
  const row: Record<string, string | number> = {
    map: canonicalMap, alive_t: state.tAlive, alive_ct: state.ctAlive,
    planted: state.planted, buy_t: state.tBuy, buy_ct: state.ctBuy,
    last_kill_side: state.lastKillSide,
  };
  for (const table of rating3Tables) {
    const cell = table.states[table.columns.map((col) => row[col]).join("|")];
    if (cell) return 1 - cell.p_t;
  }
  return null;
}

/** The model's input, as defined in model/export/winprob.ts. */
export interface RoundState {
  ctAlive: number;
  tAlive: number;
  /** summed HP of living players */
  ctHp: number;
  tHp: number;
  /** team equipment value at freeze end, summed over the whole team and fixed for the round */
  ctEquip: number;
  tEquip: number;
  planted: 0 | 1;
  /** null when not planted */
  secondsSincePlant: number | null;
  secondsSinceFreezeEnd: number;
}

export type WinProbability = (state: RoundState, map: string) => number;

export interface WinModel {
  kind: "stub" | "model";
  label: string;
  /** null when the model cannot value the state (it rejects invalid input) */
  winProbability: (state: RoundState, map: string) => number | null;
}

/**
 * Placeholder: P(CT wins) = ct² / (ct² + t²) by players alive, ignoring HP, equipment and the
 * bomb. There is no evidence behind these numbers; they only keep the swing pipeline working
 * until the trained model lands.
 */
export const STUB_TABLE: number[][] = Array.from({ length: 6 }, (_, ct) =>
  Array.from({ length: 6 }, (_, t) => (ct === 0 && t === 0 ? 0.5 : (ct * ct) / (ct * ct + t * t))),
);

const clamp5 = (n: number) => Math.max(0, Math.min(5, Math.round(n)));
const stubP = (s: Pick<RoundState, "ctAlive" | "tAlive">) => STUB_TABLE[clamp5(s.ctAlive)][clamp5(s.tAlive)];

export const stubModel: WinModel = {
  kind: "stub",
  label: "Placeholder model (alive counts only)",
  winProbability: stubP,
};

/** One state every model must answer: full teams, full HP, rifles, no bomb, 20 s in. */
const PROBE: RoundState = { ctAlive: 5, tAlive: 5, ctHp: 500, tHp: 500, ctEquip: 22000, tEquip: 20000, planted: 0, secondsSincePlant: null, secondsSinceFreezeEnd: 20 };

/**
 * Wraps the model agent's winProbabilityCT. Checks that it is a function and answers the probe
 * state with a probability; throws with the reason otherwise, so the app can show it and keep the
 * placeholder. A state the model rejects (RangeError on invalid input) has no answer (null).
 */
export function modelFromModule(fn: unknown): WinModel {
  if (typeof fn !== "function") throw new Error("model/export/winprob.ts does not export a function named winProbabilityCT");
  const f = fn as WinProbability;
  const p = f(PROBE, "de_dust2");
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`winProbabilityCT returned ${JSON.stringify(p)} for a 5v5 start; expected a probability between 0 and 1`);
  }
  return {
    kind: "model",
    label: "Trained model (CS2RB)",
    winProbability: (s, map) => {
      try {
        const v = f(s, map);
        return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
      } catch {
        return null;
      }
    },
  };
}
