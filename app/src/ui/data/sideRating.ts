// Interim: Rating 3.0 per side. The engine stores one set of Rating 3.0 inputs per player (c.r3),
// summed over every round with the kill log. Those inputs are additive per round, so the T and CT
// shares come from running the engine's own r3Inputs over the rounds your team spent on each side.
// T and CT then sum to the overall inputs, and the pooled rating for both sides always lies between
// them. When the engine stores per-side inputs in its counters, this file is deleted.
import { winProbabilityCT } from "@model/winprob";
import { buildCtx } from "../../stats/context";
import { emptyR3, r3Inputs, type R3Inputs } from "../../stats/rating3";
import { computeTrades } from "../../stats/rules";
import { CT, T, type MatchFile, type Side } from "../../stats/schema";
import { computeSwing } from "../../stats/swing";
import { modelFromModule, stubModel, type WinModel } from "../../stats/winprob";

// The same model the worker uses: the trained one when bundled, else the placeholder.
let model: WinModel = stubModel;
try { if (winProbabilityCT !== undefined) model = modelFromModule(winProbabilityCT); } catch { /* the placeholder stays, as in the worker */ }

export interface SideInputs { t: R3Inputs; ct: R3Inputs }

/** Rating 3.0 inputs for every player of a match, split by the side they played. */
export function sideInputs(m: MatchFile): SideInputs[] {
  const ctx = buildCtx(m);
  const trades = computeTrades(ctx);
  const swing = computeSwing(ctx, model);
  const humanSide = (ri: number) => ctx.side(ri, m.human);
  const onSide = (s: Side) => r3Inputs({ ...ctx, rounds: ctx.rounds.filter((ri) => humanSide(ri) === s) }, trades, swing);
  const humanT = onSide(T);
  const humanCT = onSide(CT);
  // On rounds where your team was T the opponents were CT, and the other way round.
  return ctx.onHumanTeam.map((mate, pi) => (mate ? { t: humanT[pi], ct: humanCT[pi] } : { t: humanCT[pi], ct: humanT[pi] }));
}

export function addR3(a: R3Inputs, b: R3Inputs): R3Inputs {
  const out = { ...a };
  for (const k of Object.keys(b) as (keyof R3Inputs)[]) out[k] = a[k] + b[k];
  return out;
}

export const sumR3 = (xs: R3Inputs[]) => xs.reduce(addR3, emptyR3());
