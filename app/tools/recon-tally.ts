// The plugin's recon tally, rebuilt from a match file's rows, and how many players each recon round read
// (pnpm takeover-check).
import { bodyEntry, bodyLookup } from "../src/stats/plugin/bodies";
import type { MatchFile } from "../src/stats/plugin/schema";

export type Field = "k" | "d" | "a" | "dmg";
export type Tally = Record<Field | "hits", number>;

/** Whether the file's recon tally credits bodies (plugin 1.3.0 on) rather than controllers. */
export function bodyBasis(m: MatchFile): boolean {
  const v = /^(\d+)\.(\d+)/.exec(m.env.plugin ?? "");
  return !!v && (Number(v[1]) > 1 || (Number(v[1]) === 1 && Number(v[2]) >= 3));
}

/**
 * The plugin's recon tally per (round index, player index). Before plugin 1.3.0 it credits the
 * controlling player (plugin/Core/Recorder.cs Kill and Hurt); from 1.3.0 kills, deaths and damage go to
 * the body (SCHEMA.md, "Reconciliation basis"). Assists go to the controller the event names in both.
 */
export function tallies(m: MatchFile): (ri: number, pi: number) => Tally {
  const basis = bodyBasis(m);
  const lookup = bodyLookup(m);
  const body = (pi: number, ri: number, tick: number) => (basis ? lookup(pi, ri, tick) ?? pi : pi);
  const t = new Map<string, Tally>();
  const at = (ri: number, pi: number) => {
    const key = `${ri}:${pi}`;
    let v = t.get(key);
    if (!v) t.set(key, (v = { k: 0, d: 0, a: 0, dmg: 0, hits: 0 }));
    return v;
  };
  const enemy = (ri: number, a: number, b: number) => {
    const sa = m.rounds.side[ri]?.[a], sb = m.rounds.side[ri]?.[b];
    return sa != null && sb != null && sa !== sb;
  };
  const K = m.kills;
  for (let i = 0; i < K.ri.length; i++) {
    const ri = K.ri[i];
    // an entry missing from the column says nothing, so the body lookup names it, as in bodies.ts
    const named = (col: (number | null)[] | undefined, pi: number) => {
      const e = bodyEntry(col, i);
      return e === undefined ? lookup(pi, ri, K.tick[i]) ?? pi : e ?? pi;
    };
    const v = basis ? named(K.vBody, K.victim[i]) : K.victim[i];
    const killer = K.killer[i] === null ? null : basis ? named(K.kBody, K.killer[i]!) : K.killer[i];
    at(ri, v).d++;
    if (killer !== null && killer !== v && enemy(ri, killer, v)) at(ri, killer).k++;
    const as = K.assister[i] ?? K.flashAssister[i];
    if (as !== null) at(ri, as).a++;
  }
  const D = m.damage;
  for (let i = 0; i < D.ri.length; i++) {
    if (D.attacker[i] === null) continue;
    const a = body(D.attacker[i]!, D.ri[i], D.tick[i]);
    const v = body(D.victim[i], D.ri[i], D.tick[i]);
    if (a === v || !enemy(D.ri[i], a, v)) continue;
    const x = at(D.ri[i], a);
    x.dmg += D.dmg[i];
    x.hits++;
  }
  return (ri, pi) => t.get(`${ri}:${pi}`) ?? { k: 0, d: 0, a: 0, dmg: 0, hits: 0 };
}

type ReconRounds = NonNullable<NonNullable<MatchFile["recon"]>["rounds"]>;

/** How much of a recon round the plugin compared: every player, some, none, or a form this tool cannot read. */
export type Coverage = "all" | "partial" | "none" | "unknown";

/**
 * The coverage of recon round j: from checkedPlayers and expectedPlayers, or in early plugin builds
 * from `checked` (a count, or a flag) and `missing` (a count, or the players not read). A count or flag
 * without the other half says nothing about the players left out, so it is unknown, as is a round
 * with neither form.
 */
export function coverage(rr: ReconRounds, j: number): Coverage {
  const missingOf = (x: unknown) => (Array.isArray(x) ? x.length : typeof x === "number" ? x : null);
  if (rr.checkedPlayers) {
    const checked = rr.checkedPlayers[j];
    const expected = rr.expectedPlayers?.[j];
    if (typeof checked !== "number" || typeof expected !== "number") return "unknown";
    return checked === 0 ? "none" : checked < expected ? "partial" : "all";
  }
  const c = rr.checked?.[j];
  if (c === false || c === 0) return "none";
  const missing = missingOf(rr.missing?.[j]);
  if ((typeof c !== "number" && c !== true) || missing === null) return "unknown";
  return missing === 0 ? "all" : "partial";
}
