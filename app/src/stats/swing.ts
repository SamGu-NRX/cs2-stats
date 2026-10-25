// Round swing: each kill's change in win probability, credited as in Win Probability Added
// (Xenopoulos, Doraiswamy, Silva, "Valuing Player Actions in Counter-Strike: Global Offensive",
// IEEE Big Data 2020). The victim's side loses ΔWP; the victim is charged all of it; the other side
// gains the same amount, split among its players by their share of the damage dealt to the victim
// this round (the killer included).
import type { MatchCtx } from "./context";
import type { KillState, Side } from "./schema";
import type { RoundState, WinModel } from "./winprob";

export interface KillSwing {
  /** ctx.kills position */
  k: number;
  /** P(CT wins) before and after the kill */
  before: number;
  after: number;
  /** [player, credit] pairs; credits are win-probability fractions (0.12 = 12 points) */
  credits: [number, number][];
}

export interface SwingResult {
  swings: KillSwing[];
  /** rounds whose swing cannot be computed (unknown equipment, or a state the model rejects) */
  unknownRounds: Set<number>;
  /** the match has round states at all */
  available: boolean;
}

/**
 * Whole-team equipment at freeze end per side: the sum of rounds.equip, as CS2RB's ct_equip /
 * t_equip (post-buy, constant for the round). null when any player's value is unknown.
 */
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
 * whole-team freeze-end equipment, seconds since freeze end, and seconds since the plant from
 * rounds.plantTick. null when any of them is unknown.
 */
export function roundStateBefore(ctx: MatchCtx, ri: number, tick: number, s: KillState): RoundState | null {
  const r = ctx.m.rounds;
  const freeze = r.freezeTick[ri];
  const eq = teamEquip(ctx, ri);
  if (freeze === null || eq[3] === null || eq[2] === null) return null;
  let sincePlant: number | null = null;
  if (s[6] === 1) {
    const plant = r.plantTick[ri];
    sincePlant = plant !== null ? Math.max(0, (tick - plant) / ctx.tickrate) : s[7] !== null ? s[7] / ctx.tickrate : null;
    if (sincePlant === null) return null;
  }
  return {
    ctAlive: s[0], tAlive: s[1], ctHp: s[2], tHp: s[3], ctEquip: eq[3], tEquip: eq[2], planted: s[6],
    secondsSincePlant: sincePlant, secondsSinceFreezeEnd: Math.max(0, (tick - freeze) / ctx.tickrate),
  };
}

/** Right after the kill: the victim leaves the alive count. HP is unchanged (the lethal hit came first), and equipment is fixed for the round. */
export function stateAfterKill(state: RoundState, victimSide: Side): RoundState {
  return victimSide === 3 ? { ...state, ctAlive: Math.max(0, state.ctAlive - 1) } : { ...state, tAlive: Math.max(0, state.tAlive - 1) };
}

/** Alive counts and HP only, for the placeholder model, which needs nothing else. */
const aliveOnly = (s: KillState): RoundState => ({ ctAlive: s[0], tAlive: s[1], ctHp: s[2], tHp: s[3], ctEquip: 0, tEquip: 0, planted: s[6], secondsSincePlant: null, secondsSinceFreezeEnd: 0 });

export function computeSwing(ctx: MatchCtx, model: WinModel): SwingResult {
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
  const all: KillSwing[] = [];
  const unknownRounds = new Set<number>();
  let available = false;
  ctx.kills.forEach((k, pos) => {
    const ks = m.kills.state[k.i];
    const vs = ctx.side(k.ri, k.victim);
    if (!ks || vs === null) return;
    available = true;
    // The trained model needs the full state; the placeholder needs alive counts only.
    const before = model.kind === "model" ? roundStateBefore(ctx, k.ri, k.tick, ks) : aliveOnly(ks);
    const pBefore = before ? model.winProbability(before, m.map) : null;
    const pAfter = before ? model.winProbability(stateAfterKill(before, vs), m.map) : null;
    if (pBefore === null || pAfter === null) { unknownRounds.add(k.ri); return; }
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
    all.push({ k: pos, before: pBefore, after: pAfter, credits });
  });
  // A round's swing is all or nothing: one kill the model cannot value makes the round unknown.
  const swings = all.filter((s) => !unknownRounds.has(ctx.kills[s.k].ri));
  return { swings, unknownRounds, available };
}
