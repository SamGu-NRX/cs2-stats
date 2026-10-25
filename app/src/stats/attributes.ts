// The seven HLTV-style attribute groups, each scored 0-100.
// Scores are percentiles against bot "careers" (one bot key summed across matches, at least 150
// rounds) once 15 such careers exist. Before that, each sub-stat maps a fixed reference range onto
// 0-100 and the card is marked provisional. The ranges are rough pro-level spans chosen by hand;
// there is no evidence behind them.
import type { Counters } from "./counters";
import { METRICS } from "./metrics";

export const CAREER_MIN_ROUNDS = 150;
export const CAREERS_FOR_PERCENTILES = 15;

/** [low, high]: low maps to 0 and high to 100. For lower-is-better metrics low > high. */
const REF: Record<string, [number, number]> = {
  kpr: [0.4, 1.0], killsPerWin: [0.6, 1.4], adr: [55, 100], dmgPerWin: [80, 140], killRounds: [35, 60],
  multiRounds: [8, 25], rating: [0.8, 1.3], pistolRating: [0.7, 1.4],
  savedByMatePR: [0.02, 0.12], tradedDeathsPR: [0.05, 0.2], tradedDeathsPct: [10, 35], openingTradedPct: [10, 40],
  apr: [0.08, 0.2], supportRounds: [8, 25],
  savedMatePR: [0.02, 0.12], tradeKillsPR: [0.05, 0.2], tradeKillsPct: [10, 30], assistedKillsPct: [15, 40], dmgPerKill: [140, 100],
  openKPR: [0.05, 0.18], openDPR: [0.16, 0.05], openAttempts: [15, 35], openSuccess: [35, 65], winAfterOpen: [60, 85],
  clutchPointsPR: [0, 0.06], lastAlive: [5, 15], oneVsOne: [30, 70], timeAlive: [40, 70], savesPerLoss: [0.03, 0.2],
  sniperKPR: [0, 0.4], sniperPct: [0, 40], sniperRounds: [0, 30], sniperMulti: [0, 0.08], sniperOpenPR: [0, 0.08],
  utilDmgPR: [3, 10], utilKills100: [0, 2], flashesPR: [0.2, 1], flashAssistsPR: [0, 0.08], blindPR: [0.5, 3],
};

export const GROUPS: { id: string; label: string; metrics: string[] }[] = [
  { id: "firepower", label: "Firepower", metrics: ["kpr", "killsPerWin", "adr", "dmgPerWin", "killRounds", "multiRounds", "rating", "pistolRating"] },
  { id: "entrying", label: "Entrying", metrics: ["savedByMatePR", "tradedDeathsPR", "tradedDeathsPct", "openingTradedPct", "apr", "supportRounds"] },
  { id: "trading", label: "Trading", metrics: ["savedMatePR", "tradeKillsPR", "tradeKillsPct", "assistedKillsPct", "dmgPerKill"] },
  { id: "opening", label: "Opening", metrics: ["openKPR", "openDPR", "openAttempts", "openSuccess", "winAfterOpen"] },
  { id: "clutching", label: "Clutching", metrics: ["clutchPointsPR", "lastAlive", "oneVsOne", "timeAlive", "savesPerLoss"] },
  { id: "sniping", label: "Sniping", metrics: ["sniperKPR", "sniperPct", "sniperRounds", "sniperMulti", "sniperOpenPR"] },
  { id: "utility", label: "Utility", metrics: ["utilDmgPR", "utilKills100", "flashesPR", "flashAssistsPR", "blindPR"] },
];

export interface SubScore { id: string; value: number | null; score: number | null }
export interface GroupScore { id: string; label: string; score: number | null; subs: SubScore[] }
export interface Attributes { provisional: boolean; careers: number; groups: GroupScore[] }

const clamp = (x: number) => Math.max(0, Math.min(100, x));

export function rangeScore(id: string, v: number): number {
  const [lo, hi] = REF[id];
  return clamp((100 * (v - lo)) / (hi - lo));
}

/** Share of career values below v, ties counting half, 0-100. Lower-is-better flips the order. */
export function percentile(values: number[], v: number, lowerIsBetter = false): number {
  if (!values.length) return 50;
  let below = 0;
  let ties = 0;
  for (const x of values) {
    if (x === v) ties++;
    else if (lowerIsBetter ? x > v : x < v) below++;
  }
  return (100 * (below + ties / 2)) / values.length;
}

export function scoreAttributes(human: Counters, careers: Counters[]): Attributes {
  const eligible = careers.filter((c) => c.rounds >= CAREER_MIN_ROUNDS);
  const provisional = eligible.length < CAREERS_FOR_PERCENTILES;
  const groups = GROUPS.map((g) => {
    const subs = g.metrics.map((id) => {
      const m = METRICS[id];
      const value = m.value(human);
      let score: number | null = null;
      if (value !== null) {
        if (provisional) score = rangeScore(id, value);
        else {
          const vals = eligible.map((c) => m.value(c)).filter((x): x is number => x !== null);
          score = vals.length ? percentile(vals, value, m.lowerIsBetter) : null;
        }
      }
      return { id, value, score };
    });
    const scored = subs.filter((s) => s.score !== null);
    const score = scored.length ? scored.reduce((a, s) => a + s.score!, 0) / scored.length : null;
    return { id: g.id, label: g.label, score, subs };
  });
  return { provisional, careers: eligible.length, groups };
}
