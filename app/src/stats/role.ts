// A player's role ("personality") in HLTV's taxonomy, from data: AWPer when enough kills come from
// the sniper, otherwise Rifler with the flavour whose evidence clears its threshold by the most.
// The thresholds are explicit constants chosen by hand from typical values (no fit behind them);
// role.test.ts pins each edge.
import type { MatchCtx } from "./context";
import type { Counters } from "./counters";
import { CT, T } from "./schema";

/** AWPer: at least this share of kills with a sniper rifle. */
export const AWPER_MIN_SNIPER_SHARE = 0.35;
/** Entry: in an opening duel (first kill or first death) in at least this share of rounds; 10 players share 2 slots, so the average is 0.20. */
export const ENTRY_MIN_OPENING_ATTEMPTS = 0.25;
/** Support: trade kills and assists (flash assists included) as a share of kills plus assists. */
export const SUPPORT_MIN_TRADE_ASSIST_SHARE = 0.45;
/** Lurker: mean distance (world units, 2D) to the nearest living teammate on T before the plant. */
export const LURKER_MIN_TEAM_DISTANCE = 1100;
/** Anchor: share of CT rounds holding a bombsite area with at most one teammate there, 15 s after freeze end. */
export const ANCHOR_MIN_SITE_SHARE = 0.5;
/** Fewer rounds than this and the role is marked provisional. */
export const ROLE_MIN_ROUNDS = 20;

export const FLAVOURS = ["Entry", "Support", "Lurker", "Anchor"] as const;
export type Flavour = (typeof FLAVOURS)[number];

/** Position-based role evidence, additive across matches. */
export interface RoleCounts {
  /** T-side position samples before the plant with a living teammate sampled in the same second, and the summed nearest-teammate distance */
  tDistN: number;
  tDistSum: number;
  /** CT rounds with the player's area known 15 s after freeze end, and those alone (or with one teammate) on A or B */
  ctSetupRounds: number;
  ctAnchorRounds: number;
}
export const emptyRoleCounts = (): RoleCounts => ({ tDistN: 0, tDistSum: 0, ctSetupRounds: 0, ctAnchorRounds: 0 });

export interface FlavourScore {
  flavour: Flavour;
  /** the evidence value compared with the threshold; null when the data is missing (positions are plugin-only) */
  value: number | null;
  threshold: number;
  /** value / threshold; 1 or more qualifies */
  score: number | null;
}

export interface Role {
  primary: "AWPer" | "Rifler";
  /** the qualifying flavour with the highest score; null when none qualifies or for AWPers */
  flavour: Flavour | null;
  /** label in HLTV's style: "AWPer", "Rifler (Entry)", "Rifler" */
  label: string;
  provisional: boolean;
  evidence: {
    rounds: number;
    sniperShare: number | null;
    openingAttempts: number | null;
    tradeAssistShare: number | null;
    teamDistance: number | null;
    anchorShare: number | null;
  };
  flavours: FlavourScore[];
}

// de_dust2 place → area, the same table as the plugin's MapAreas (plugin/Core/Names.cs).
const DUST2_AREA: Record<string, "A" | "B" | "Mid" | "CT"> = {};
for (const p of ["ARamp", "BombsiteA", "Catwalk", "ExtendedA", "LongA", "LongDoors", "Pit", "ShortStairs", "UnderA"]) DUST2_AREA[p] = "A";
for (const p of ["BDoors", "BombsiteB", "LowerTunnel", "TunnelStairs", "UpperTunnel"]) DUST2_AREA[p] = "B";
for (const p of ["Hole", "MidDoors", "Middle", "TopMid"]) DUST2_AREA[p] = "Mid";
for (const p of ["CTSpawn", "Side"]) DUST2_AREA[p] = "CT";

/** Macro area of a place on a map with an area table (de_dust2 only, as in the plugin); null otherwise. */
export function placeArea(map: string, place: string | null): "A" | "B" | "Mid" | "CT" | "Other" | null {
  if (map !== "de_dust2") return null;
  return place === null ? "Other" : DUST2_AREA[place] ?? "Other";
}

/** Position evidence for every player of a match (full rounds; empty without position samples). */
export function roleCounts(ctx: MatchCtx): RoleCounts[] {
  const m = ctx.m;
  const out = Array.from({ length: ctx.nPlayers }, emptyRoleCounts);
  const p = m.pos;
  if (!p.ri.length) return out;
  const tr = ctx.tickrate;
  // samples by round and second: [pi, x, y]
  const bySecond = new Map<string, [number, number, number][]>();
  const near15 = new Map<string, { d: number; place: number | null }>(); // `${ri}:${pi}` -> sample closest to freeze + 15 s
  for (let i = 0; i < p.ri.length; i++) {
    const ri = p.ri[i];
    if (!ctx.isFull(ri) || !p.alive[i]) continue;
    const plant = m.rounds.plantTick[ri];
    if (plant === null || p.tick[i] < plant) {
      const key = `${ri}:${Math.round(p.tick[i] / tr)}`;
      let l = bySecond.get(key);
      if (!l) bySecond.set(key, (l = []));
      l.push([p.pi[i], p.x[i], p.y[i]]);
    }
    const freeze = m.rounds.freezeTick[ri];
    if (freeze !== null) {
      const d = Math.abs(p.tick[i] - (freeze + 15 * tr));
      const k = `${ri}:${p.pi[i]}`;
      if (d <= tr && (!near15.has(k) || d < near15.get(k)!.d)) near15.set(k, { d, place: p.place[i] });
    }
  }
  for (const [key, list] of bySecond) {
    const ri = +key.split(":")[0];
    for (const [pi, x, y] of list) {
      if (ctx.side(ri, pi) !== T) continue;
      let best = Infinity;
      for (const [q, qx, qy] of list) if (q !== pi && ctx.side(ri, q) === T) best = Math.min(best, Math.hypot(qx - x, qy - y));
      if (best < Infinity) { out[pi].tDistN++; out[pi].tDistSum += best; }
    }
  }
  for (const ri of ctx.rounds) {
    const setup = m.rounds.ctSetup[ri];
    if (!setup) continue;
    for (let pi = 0; pi < ctx.nPlayers; pi++) {
      if (ctx.side(ri, pi) !== CT) continue;
      const s = near15.get(`${ri}:${pi}`);
      if (!s) continue;
      const area = placeArea(m.map, s.place === null ? null : m.places[s.place] ?? null);
      if (area === null) continue;
      out[pi].ctSetupRounds++;
      if ((area === "A" && setup[0] <= 2) || (area === "B" && setup[1] <= 2)) out[pi].ctAnchorRounds++;
    }
  }
  return out;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/** Role from a player's counters (one match or a whole profile). */
export function deriveRole(c: Counters): Role {
  const sniperShare = ratio(c.sniperKills, c.fullKills);
  const openingAttempts = ratio(c.openingKills + c.openingDeaths, c.fullRounds);
  const tradeAssistShare = ratio(c.tradeKills + c.assists, c.fullKills + c.assists);
  const teamDistance = ratio(c.role.tDistSum, c.role.tDistN);
  const anchorShare = ratio(c.role.ctAnchorRounds, c.role.ctSetupRounds);
  const score = (flavour: Flavour, value: number | null, threshold: number): FlavourScore => ({ flavour, value, threshold, score: value === null ? null : value / threshold });
  const flavours = [
    score("Entry", openingAttempts, ENTRY_MIN_OPENING_ATTEMPTS),
    score("Support", tradeAssistShare, SUPPORT_MIN_TRADE_ASSIST_SHARE),
    score("Lurker", teamDistance, LURKER_MIN_TEAM_DISTANCE),
    score("Anchor", anchorShare, ANCHOR_MIN_SITE_SHARE),
  ];
  const awper = sniperShare !== null && sniperShare >= AWPER_MIN_SNIPER_SHARE;
  const best = flavours.filter((f) => f.score !== null && f.score >= 1).sort((a, b) => b.score! - a.score!)[0];
  const flavour = awper ? null : best?.flavour ?? null;
  return {
    primary: awper ? "AWPer" : "Rifler", flavour,
    label: awper ? "AWPer" : flavour ? `Rifler (${flavour})` : "Rifler",
    provisional: c.fullRounds < ROLE_MIN_ROUNDS,
    evidence: { rounds: c.fullRounds, sniperShare, openingAttempts, tradeAssistShare, teamDistance, anchorShare },
    flavours,
  };
}
