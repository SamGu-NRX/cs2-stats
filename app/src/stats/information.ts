// Information: what a player puts on their team's radar. The source is the `spotted` table (radar
// spotted-state changes per spotter and target). It lags real visibility, which is acceptable for
// information but not for aim (SCHEMA-v1.md, Visibility). Bots are never spotters in the table.
//
// The radar state in GOTV demos is sparse next to mesh line of sight (VALIDATION.md), so these
// metrics measure radar spotting, not sight.
import type { Ctx } from "./derive";
import type { Metric } from "./metrics";

/** A teammate's kill counts as set up by your spot when you had the victim spotted at some moment in the SPOT_ASSIST_S seconds before it. Ours, no fit. */
export const SPOT_ASSIST_S = 3;

export interface InfoFact {
  ri: number;
  pi: number;
  /** the match has a spotted table */
  spotted: boolean;
  /** first of the team to spot an enemy this round; null when a teammate is a bot (bots cannot be spotters) */
  firstSpot: boolean | null;
  /** seconds you had enemies spotted, summed over enemies, while you and they were alive */
  spotSecs: number;
  /** teammates' kills on enemies you had spotted within SPOT_ASSIST_S before the kill */
  spotAssists: number;
}

export interface InfoAgg { rounds: number; firstSpotRounds: number; firstSpots: number; spotSecs: number; spotAssists: number }

export const emptyInfo = (): InfoAgg => ({ rounds: 0, firstSpotRounds: 0, firstSpots: 0, spotSecs: 0, spotAssists: 0 });

export function foldInfo(a: InfoAgg, f: InfoFact): void {
  if (!f.spotted) return;
  a.rounds++;
  if (f.firstSpot !== null) { a.firstSpotRounds++; if (f.firstSpot) a.firstSpots++; }
  a.spotSecs += f.spotSecs;
  a.spotAssists += f.spotAssists;
}

/**
 * One round's spotted intervals [from, to) per spotter, clipped to freeze end, round end and both
 * players' deaths. A dead player's radar state stays set until the next round resets it.
 */
function spotIntervals(c: Ctx, ri: number, rows: number[]): Map<number, { target: number; from: number; to: number }[]> {
  const S = c.t.spotted!;
  const rf = c.rounds[ri];
  const death = new Map<number, number>();
  for (const k of c.kills[ri]) if (!death.has(k.victim)) death.set(k.victim, k.tick);
  const out = new Map<number, { target: number; from: number; to: number }[]>();
  const open = new Map<number, number>(); // spotter * 1024 + target -> tick spotted
  const close = (spotter: number, target: number, from: number, to: number) => {
    const lo = Math.max(from, rf.freezeEndTick!);
    const hi = Math.min(to, rf.endTick, death.get(spotter) ?? Infinity, death.get(target) ?? Infinity);
    if (hi <= lo) return;
    let l = out.get(spotter);
    if (!l) out.set(spotter, (l = []));
    l.push({ target, from: lo, to: hi });
  };
  for (const i of rows) {
    const a = c.pi.get(S.spotter_steamid[i]), b = c.pi.get(S.target_steamid[i]);
    if (a === undefined || b === undefined) continue;
    const sa = c.side[ri][a], sb = c.side[ri][b];
    if (!sa || !sb || sa === sb) continue;
    const key = a * 1024 + b;
    if (S.spotted[i]) { if (!open.has(key)) open.set(key, S.tick[i]); }
    else if (open.has(key)) { close(a, b, open.get(key)!, S.tick[i]); open.delete(key); }
  }
  for (const [key, from] of open) close(Math.floor(key / 1024), key % 1024, from, rf.endTick);
  return out;
}

export function deriveInfo(c: Ctx): InfoFact[] {
  const S = c.t.spotted;
  const byRound: number[][] = Array.from({ length: c.nRounds }, () => []);
  if (S) for (let i = 0; i < S.n; i++) { const ri = c.riOf(S.round[i]); if (ri !== undefined) byRound[ri].push(i); }
  if (S) for (const l of byRound) l.sort((a, b) => S.tick[a] - S.tick[b]);
  const out: InfoFact[] = [];
  for (let ri = 0; ri < c.nRounds; ri++) {
    const rows = c.pr[ri];
    const ok = S !== null && c.rounds[ri].freezeEndTick !== null;
    const iv = ok ? spotIntervals(c, ri, byRound[ri]) : new Map<number, { target: number; from: number; to: number }[]>();
    const first = (pi: number) => Math.min(...(iv.get(pi) ?? []).map((x) => x.from));
    for (const p of rows) {
      if (!p) continue;
      const mine = iv.get(p.pi) ?? [];
      const mates = rows.filter((q) => q && q.side === p.side && q.pi !== p.pi);
      const hasBot = mates.some((q) => c.players[q!.pi].bot);
      const firstSpot = !ok || hasBot ? null : mine.length > 0 && mates.every((q) => first(q!.pi) >= first(p.pi));
      let spotAssists = 0;
      for (const k of c.kills[ri]) {
        if (!k.enemy || k.killer === p.pi || k.killerSide !== p.side) continue;
        const from = k.tick - SPOT_ASSIST_S * c.tickRate;
        if (mine.some((x) => x.target === k.victim && x.to >= from && x.from <= k.tick)) spotAssists++;
      }
      out.push({ ri, pi: p.pi, spotted: ok, firstSpot, spotSecs: mine.reduce((s, x) => s + (x.to - x.from), 0) / c.tickRate, spotAssists });
    }
  }
  return out;
}

const per = (a: number, b: number) => (b > 0 ? a / b : null);
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const RADAR = "From the radar's spotted state, which lags real sight.";

export const INFORMATION_METRICS: Metric[] = [
  { id: "firstSpotPct", label: "First spots", kind: "identity", group: "information", unit: "pct", status: "approx",
    tip: "Rounds where you spotted an enemy first on your team.", def: `Rounds where you were the first of your team (ties count) to spot an enemy after freeze end. Rounds with a bot teammate are left out, because bots are never recorded as spotters. ${RADAR}`,
    value: (s) => pct(s.information.firstSpots, s.information.firstSpotRounds) },
  { id: "spotSecsPR", label: "Enemy time spotted per round", kind: "identity", group: "information", unit: "secs", status: "approx",
    tip: "Seconds of enemies you had spotted per round.", def: `Seconds you had enemies spotted, summed over enemies, while you and they were alive, per round. ${RADAR}`,
    value: (s) => per(s.information.spotSecs, s.information.rounds) },
  { id: "spotAssistsPR", label: "Spots before a teammate's kill per round", kind: "identity", group: "information", unit: "perRound", status: "approx",
    tip: "Teammate kills on enemies you spotted, per round.", def: `Teammates' kills on an enemy you had spotted at some moment in the ${SPOT_ASSIST_S} s before the kill, per round. ${RADAR}`,
    value: (s) => per(s.information.spotAssists, s.information.rounds) },
];
