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

/**
 * Right after the kill: the victim leaves the alive count and its side's HP drops by `victimHp`, the
 * victim's HP in the state before. Equipment is fixed for the round. The side's HP is then capped at
 * 100 per living player, so a victim HP that could not be read (deaths without a player_hurt row,
 * such as the bomb or a fall) still gives a state the model accepts.
 */
export function stateAfterKill(state: RoundState, victimSide: Side, victimHp = 0): RoundState {
  if (victimSide === 3) {
    const ctAlive = Math.max(0, state.ctAlive - 1);
    return { ...state, ctAlive, ctHp: Math.max(0, Math.min(state.ctHp - victimHp, 100 * ctAlive)) };
  }
  const tAlive = Math.max(0, state.tAlive - 1);
  return { ...state, tAlive, tHp: Math.max(0, Math.min(state.tHp - victimHp, 100 * tAlive)) };
}

/**
 * Writers whose kills.state counts the victim at 0 HP (the fatal hit already applied). Capture plugin
 * 1.0.0 instead counts the victim with its HP before the fatal hit (Recorder.FillState), so for its
 * files the victim's HP has to come off the side's total after the kill. Before this split, every
 * plugin round had an after-kill HP above 100 per living player, the model rejected it, and swing was
 * unknown for all 48 rounds of the three 2026-10-25 recordings.
 */
export const VICTIM_AT_ZERO_HP_WRITERS: ReadonlySet<string> = new Set(["legacy-convert", "synthetic-demo"]);

/**
 * HP each victim had before a hit, keyed `ri:victim:tick`: the last player_hurt row on the victim in
 * that tick, whose dmg is capped at the HP before it. Looked up at the kill's tick, that is the fatal hit.
 */
function lastHitByTick(ctx: MatchCtx): Map<string, number> {
  const d = ctx.m.damage;
  const out = new Map<string, number>();
  for (let j = 0; j < d.ri.length; j++) out.set(`${d.ri[j]}:${d.victim[j]}:${d.tick[j]}`, d.dmg[j]);
  return out;
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
  const victimInHp = !VICTIM_AT_ZERO_HP_WRITERS.has(m.env.plugin ?? "");
  const lastHit = victimInHp ? lastHitByTick(ctx) : null;
  ctx.kills.forEach((k, pos) => {
    const ks = m.kills.state[k.i];
    const vs = ctx.side(k.ri, k.victim);
    if (!ks || vs === null) return;
    available = true;
    // The trained model needs the full state; the placeholder needs alive counts only.
    const before = model.kind === "model" ? roundStateBefore(ctx, k.ri, k.tick, ks) : aliveOnly(ks);
    const victimHp = lastHit?.get(`${k.ri}:${k.victim}:${k.tick}`) ?? 0;
    const pBefore = before ? model.winProbability(before, m.map) : null;
    const pAfter = before ? model.winProbability(stateAfterKill(before, vs, victimHp), m.map) : null;
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
