// Round win probability: the rating agent's lookup of HLTV's probabilities (model/rating3/params.json,
// SPEC.md "Win probability"). Tables run from most to least specific; the first one holding the
// state's key answers. Test error on held-out matches is in params.winProbability.test.
import params from "../../../model/rating3/params.json";
import type { BuyClass } from "./economy";

export interface RoundState {
  /** de_ancient or Ancient; the lookup keys use HLTV's name */
  map: string;
  aliveT: number;
  aliveCT: number;
  planted: boolean;
  buyT: BuyClass | null;
  buyCT: BuyClass | null;
  /** side of the last killer this round, or none */
  lastKillSide: "t" | "ct" | "none";
}

type Table = { columns: string[]; states: Record<string, { p_t: number; n: number }> };
const TABLES = params.winProbability.tables as unknown as Table[];

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
  throw new Error(`winprob: params.json names an unknown column "${col}"`);
}

/** P(T wins) for a state, or null when no table holds it. */
export function pTWins(s: RoundState): number | null {
  for (const t of TABLES) {
    const parts = t.columns.map((c) => field(s, c));
    if (parts.includes(null)) continue;
    const hit = t.states[parts.join("|")];
    if (hit) return hit.p_t;
  }
  return null;
}
