// Round swing: each kill's change in win probability, credited as in Win Probability Added
// (Xenopoulos, Doraiswamy, Silva, "Valuing Player Actions in Counter-Strike: Global Offensive",
// IEEE Big Data 2020). The victim's side loses ΔWP; the victim is charged all of it; the other side
// gains the same amount, split among its players by their share of the damage dealt to the victim
// this round (the killer included).
import type { MatchCtx } from "./context";
import type { KillState, Side } from "./schema";
import { stubModel, type RoundState, type WinModel } from "./winprob";

export interface KillSwing {
  /** ctx.kills position */
  k: number;
  /** P(CT wins) before and after the kill */
  before: number;
  after: number;
  /** [player, credit] pairs; credits are win-probability fractions (0.12 = 12 points) */
  credits: [number, number][];
}

/** Whole-team equipment at freeze end for each side, or null when any player's value is unknown. */
function teamEquip(ctx: MatchCtx, ri: number): Record<Side, number | null> {
  const out: Record<Side, number | null> = { 2: 0, 3: 0 };
  for (let pi = 0; pi < ctx.nPlayers; pi++) {
    const s = ctx.side(ri, pi);
    if (s === null) continue;
    const e = ctx.m.rounds.equip[ri][pi];
    out[s] = e === null || out[s] === null ? null : out[s]! + e;
  }
  return out;
}

/**
 * The model's state just before a kill: alive counts and HP from the kill's recorded state,
 * whole-team freeze-end equipment, and times in seconds. null when a field is unknown.
 */
export function roundStateBefore(ctx: MatchCtx, ri: number, tick: number, s: KillState): RoundState | null {
  const freeze = ctx.m.rounds.freezeTick[ri];
  const eq = teamEquip(ctx, ri);
  if (freeze === null || eq[3] === null || eq[2] === null) return null;
  return {
    ctAlive: s[0], tAlive: s[1], ctHp: s[2], tHp: s[3], ctEquip: eq[3], tEquip: eq[2], planted: s[6],
    secondsSincePlant: s[6] === 1 && s[7] !== null ? s[7] / ctx.tickrate : null,
    secondsSinceFreezeEnd: Math.max(0, (tick - freeze) / ctx.tickrate),
  };
}

/** Right after the kill: the victim leaves the alive count. HP is unchanged (the lethal hit came first), and equipment is fixed for the round. */
export function stateAfterKill(state: RoundState, victimSide: Side): RoundState {
  return victimSide === 3 ? { ...state, ctAlive: Math.max(0, state.ctAlive - 1) } : { ...state, tAlive: Math.max(0, state.tAlive - 1) };
}

export function computeSwing(ctx: MatchCtx, model: WinModel): KillSwing[] {
  const m = ctx.m;
  const d = m.damage;
  // damage per round, per victim: [attacker, dmg, tick]
  const byVictim = new Map<string, [number, number, number][]>();
  for (let j = 0; j < d.ri.length; j++) {
    const a = d.attacker[j];
    if (a === null) continue;
    const key = `${d.ri[j]}:${d.victim[j]}`;
    let list = byVictim.get(key);
    if (!list) byVictim.set(key, (list = []));
    list.push([a, d.dmg[j], d.tick[j]]);
  }
  const out: KillSwing[] = [];
  ctx.kills.forEach((k, pos) => {
    const ks = m.kills.state[k.i];
    const vs = ctx.side(k.ri, k.victim);
    if (!ks || vs === null) return;
    // Without a full state the trained model cannot answer; the placeholder covers that kill.
    const full = roundStateBefore(ctx, k.ri, k.tick, ks);
    const use = full ? model : stubModel;
    const before: RoundState = full ?? { ctAlive: ks[0], tAlive: ks[1], ctHp: ks[2], tHp: ks[3], ctEquip: 0, tEquip: 0, planted: ks[6], secondsSincePlant: null, secondsSinceFreezeEnd: 0 };
    const pBefore = use.winProbability(before, m.map);
    const pAfter = use.winProbability(stateAfterKill(before, vs), m.map);
    // change for the victim's side (≤ 0 for any sensible model)
    const dVictim = vs === 3 ? pAfter - pBefore : pBefore - pAfter;
    const credits: [number, number][] = [[k.victim, dVictim]];
    const share = new Map<number, number>();
    let total = 0;
    for (const [a, dmg, tick] of byVictim.get(`${k.ri}:${k.victim}`) ?? []) {
      if (tick > k.tick || ctx.side(k.ri, a) === vs) continue;
      share.set(a, (share.get(a) ?? 0) + dmg);
      total += dmg;
    }
    if (total > 0) for (const [a, dmg] of share) credits.push([a, (-dVictim * dmg) / total]);
    else if (k.killer !== null && !k.teamKill) credits.push([k.killer, -dVictim]);
    out.push({ k: pos, before: pBefore, after: pAfter, credits });
  });
  return out;
}
