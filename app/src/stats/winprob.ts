// Round win probability from the source model-params.ts chose: HLTV's lookup (tables run from most to
// least specific; the first one holding the state's key answers, SPEC.md "Win probability"), or the
// CS2RB round model (model/export/winprob.ts), which needs health, equipment and time.
import { winProbabilityCT } from "../../../model/export/winprob";
import type { BuyClass } from "./economy";
import type { LookupTable, WinProbSource } from "./model-params";

export interface RoundState {
  /** de_ancient; the lookup keys use HLTV's name (Ancient) */
  map: string;
  aliveT: number;
  aliveCT: number;
  /** summed health of the living players on each side */
  hpT: number;
  hpCT: number;
  /** team equipment at freeze end; null when unknown */
  equipT: number | null;
  equipCT: number | null;
  planted: boolean;
  /** null when not planted */
  secondsSincePlant: number | null;
  /** null when the round has no freeze end */
  secondsSinceFreezeEnd: number | null;
  buyT: BuyClass | null;
  buyCT: BuyClass | null;
  /** side of the last killer this round, or none */
  lastKillSide: "t" | "ct" | "none";
}

const hltvMap = (map: string) => {
  const s = map.replace(/^de_/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function field(s: RoundState, col: string): string | null {
  switch (col) {
    case "map": return hltvMap(s.map);
    case "alive_t": return String(s.aliveT);
    case "alive_ct": return String(s.aliveCT);
    case "planted": return s.planted ? "1" : "0";
    case "buy_t": return s.buyT ? s.buyT.toUpperCase() : null;
    case "buy_ct": return s.buyCT ? s.buyCT.toUpperCase() : null;
    case "last_kill_side": return s.lastKillSide;
  }
  throw new Error(`winprob: the HLTV pack names an unknown column "${col}"`);
}

function lookup(tables: LookupTable[], s: RoundState): number | null {
  for (const t of tables) {
    const parts = t.columns.map((c) => field(s, c));
    if (parts.includes(null)) continue;
    const hit = t.states[parts.join("|")];
    if (hit) return hit.p_t;
  }
  return null;
}

/**
 * P(T wins) for a state, or null when the source cannot value it: no lookup entry, or for CS2RB unknown
 * equipment or time, or more than five players on a side (a sixth player joining), outside its model.
 */
export function pTWins(src: WinProbSource, s: RoundState): number | null {
  if (src.kind === "hltv") return lookup(src.tables, s);
  if (s.aliveT > 5 || s.aliveCT > 5 || s.equipT === null || s.equipCT === null || s.secondsSinceFreezeEnd === null || (s.planted && s.secondsSincePlant === null)) return null;
  return 1 - winProbabilityCT({
    ctAlive: s.aliveCT, tAlive: s.aliveT, ctHp: s.hpCT, tHp: s.hpT, ctEquip: s.equipCT, tEquip: s.equipT,
    planted: s.planted ? 1 : 0, secondsSincePlant: s.planted ? s.secondsSincePlant : null, secondsSinceFreezeEnd: s.secondsSinceFreezeEnd,
  }, s.map);
}
