// The parts of a match's facts that depend on the rating model (model/rating3/params.json) and the round
// win-probability source: the eco adjustment, swing and Rating 3.0's valued rounds. derive() is
// deriveBase(), which reads the tables, then rate(). The stats worker keeps a match's facts with the
// RatingInputs rate() needs from the tables, so a refitted model or another win-probability source rates
// the kept facts again instead of reading and deriving every match (worker/stats.worker.ts cached).
//
// rate() owns these fields and sets every one of them: each kill's ecoPoints and credits, each round's
// winProb, the RATING_MEASURES of each player-round, and match.winProb and match.model. It clears them
// first, so facts rated with one model and rated again with another equal facts rated with the second.
import { blindWindows } from "./blinds";
import { enemyHit, hitDamage, type Ctx, type WorkRound } from "./derive";
import { emptyMeasures, sparse, type KillFact, type MatchFacts, type MatchInfo, type Measure, type RoundFact } from "./facts";
import { modelFingerprint, type WinProbSource } from "./model-params";
import { ecoAdjust, valuedRounds, type EcoGroup } from "./rating3";
import { swing } from "./swing";
import type { Side } from "./tables";

/** The measures rate() fills (rating3.ts ecoAdjust and valuedRounds, swing.ts swing); every other measure is the tables'. */
export const RATING_MEASURES = [
  "ecoKills", "ecoDeaths", "ecoDmg", "ecoKast", "ecoRounds",
  "swing", "swingRounds", "rws", "rwsRounds", "openingSwing", "clutchSwing", "awpSwing", "flashSwing",
  "swingKills", "swingTrades", "swingDamage", "swingDeaths", "swingEnd",
  "ratedRounds", "vEcoKills", "vEcoDeaths", "vEcoDmg", "vEcoKast", "vMultiKillRounds", "vK3Rounds", "vK4Rounds", "vK5Rounds", "vSwing",
] as const satisfies readonly Measure[];

/** A match's facts before rate(): every field rate() owns at its cleared value, and no model named. */
export type BaseFacts = Omit<MatchFacts, "match"> & { match: Omit<MatchInfo, "winProb" | "model"> };

/**
 * What rate() reads from the match's tables, which facts do not keep. None of it depends on the model.
 * Player indexes are the facts' (players); a steamid that is no player's is null.
 */
export interface RatingInputs {
  /** the rounds table's start tick by round row: where swing's path starts when the round has no freeze end */
  startTick: (number | null)[];
  /** side[ri][pi], derive.ts Ctx.side: null when the player did not play the round */
  side: (Side | null)[][];
  /** freeze[ri][pi], each player's freeze-end economy group (rating3.ts ecoGroups); null when unknown */
  freeze: (EcoGroup | null)[][];
  /**
   * the damages table's rows in its order, for the rounds the tables cover: the round row, the tick, the
   * attacker and victim, the hit's damage (derive.ts hitDamage), whether it is enemy damage (enemyHit),
   * and the health columns swing follows each player's health with
   */
  damages: { ri: number[]; tick: number[]; attacker: (number | null)[]; victim: (number | null)[]; dmg: number[]; enemy: boolean[]; healthAfter: (number | null)[]; healthCapped: number[] };
  /** the blinds swing can credit a flash for (blinds.ts blindWindows, less team, self and ambiguous ones), round by round */
  blinds: { ri: number[]; tick: number[]; secs: number[]; victim: (number | null)[]; attacker: (number | null)[] };
}

/** What the rating passes read: the facts by round, the inputs and the win-probability source. */
export interface RateCtx {
  wp: WinProbSource;
  tickRate: number;
  nRounds: number;
  map: string;
  rounds: RoundFact[];
  /** kills[ri], in the facts' order (tick order) */
  kills: KillFact[][];
  /** pr[ri][pi], null when the player did not play the round; every measure present */
  pr: (WorkRound | null)[][];
  inputs: RatingInputs;
  /** row indexes of inputs.damages and inputs.blinds by round row, in table order */
  damagesBy: number[][];
  blindsBy: number[][];
}

/** The rating inputs of a match being derived; `freeze` is what rating3.ts ecoGroups returned. */
export function ratingInputs(c: Ctx, freeze: (EcoGroup | null)[][]): RatingInputs {
  const d = c.t.damages;
  const damages: RatingInputs["damages"] = { ri: [], tick: [], attacker: [], victim: [], dmg: [], enemy: [], healthAfter: [], healthCapped: [] };
  for (let ri = 0; ri < c.nRounds; ri++) {
    for (const i of c.byRound("damages")[ri]) {
      damages.ri.push(ri);
      damages.tick.push(d.tick[i]);
      damages.attacker.push(c.idOf(d.attacker_steamid[i]));
      damages.victim.push(c.idOf(d.victim_steamid[i]));
      damages.dmg.push(hitDamage(c.t, i));
      damages.enemy.push(enemyHit(c.t, i));
      damages.healthAfter.push(d.health_after[i]);
      damages.healthCapped.push(d.dmg_health_capped[i]);
    }
  }
  const blinds: RatingInputs["blinds"] = { ri: [], tick: [], secs: [], victim: [], attacker: [] };
  const windows = blindWindows(c.t);
  for (const rf of c.rounds) {
    for (const b of windows.get(rf.number) ?? []) {
      if (b.team || b.self || b.ambiguous) continue;
      blinds.ri.push(rf.ri);
      blinds.tick.push(b.tick);
      blinds.secs.push(b.secs);
      blinds.victim.push(c.idOf(b.victim));
      blinds.attacker.push(c.idOf(b.attacker));
    }
  }
  return { startTick: Array.from({ length: c.nRounds }, (_, ri) => c.t.rounds.start_tick[ri]), side: c.side, freeze, damages, blinds };
}

/** Row indexes by round row, in row order. */
function byRound(ri: number[], nRounds: number): number[][] {
  const out: number[][] = Array.from({ length: nRounds }, () => []);
  ri.forEach((r, i) => out[r].push(i));
  return out;
}

/**
 * The facts rated with `wp` and the rating parameters this build carries. `f` is deriveBase()'s facts,
 * or facts rated before with any model; neither is changed.
 */
export function rate(f: BaseFacts, inputs: RatingInputs, wp: WinProbSource): MatchFacts {
  const nRounds = f.rounds.length;
  const rounds = f.rounds.map((r): RoundFact => ({ ...r, winProb: null }));
  const kills: KillFact[][] = rounds.map(() => []);
  for (const k of f.kills) kills[k.ri].push({ ...k, ecoPoints: null, credits: [] });
  const pr: (WorkRound | null)[][] = rounds.map(() => new Array<WorkRound | null>(f.players.length).fill(null));
  for (const r of f.pr) {
    const m = { ...emptyMeasures(), ...r.m };
    for (const x of RATING_MEASURES) m[x] = 0;
    pr[r.ri][r.pi] = { ...r, m };
  }
  const c: RateCtx = {
    wp, tickRate: f.match.tickRate, nRounds, map: f.match.map, rounds, kills, pr, inputs,
    damagesBy: byRound(inputs.damages.ri, nRounds), blindsBy: byRound(inputs.blinds.ri, nRounds),
  };
  ecoAdjust(c);
  swing(c);
  valuedRounds(c);
  // in MatchInfo's order, whether or not `f` was rated before
  const { winProb: _w, model: _m, inputs: sourceInputs, ...info } = f.match as MatchInfo;
  return {
    ...f,
    match: { ...info, winProb: wp.kind, model: modelFingerprint(wp), inputs: sourceInputs },
    rounds,
    pr: pr.flat().filter((x): x is WorkRound => x !== null).map((r) => ({ ...r, m: sparse(r.m) })),
    kills: kills.flat(),
  };
}
