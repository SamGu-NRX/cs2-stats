// Home's headline tiles: which metric each tile shows, its format and its benchmark. Values come
// from METRIC over a match's or a filter's Summary.
import { METRIC } from "../../stats/metrics";
import { ratedMatch } from "./engine";
import type { Summary } from "../../stats/rollup";
import { fmtAdr, fmtDec, fmtMs, fmtPct, fmtRating, fmtSwing } from "../lib/format";
import type { BenchId } from "../lib/verdict";
import type { MatchEntry } from "./match";

export interface TileDef {
  /** METRIC id */
  id: string;
  label: string;
  fmt: (v: number) => string;
  /** format for a delta (absolute value; the sign is drawn as ▲ / ▼) */
  fmtDelta: (v: number) => string;
  bench: BenchId;
  /** the difference that reads as fully good or bad in a delta */
  deltaSpan: number;
  /** needs shots, which only recorded matches carry */
  aim?: boolean;
  /** needs mesh visibility (MatchInfo.visibility "ok") */
  visibility?: boolean;
}

export const TILES: TileDef[] = [
  { id: "rating3", label: "Rating 3.0", fmt: fmtRating, fmtDelta: (v) => v.toFixed(2), bench: "rating", deltaSpan: 0.3 },
  { id: "kpr", label: "KPR", fmt: (v) => fmtDec(v), fmtDelta: (v) => v.toFixed(2), bench: "kpr", deltaSpan: 0.2 },
  { id: "adr", label: "ADR", fmt: fmtAdr, fmtDelta: (v) => v.toFixed(1), bench: "adr", deltaSpan: 20 },
  { id: "kast", label: "KAST", fmt: (v) => fmtPct(v), fmtDelta: (v) => `${v.toFixed(1)}%`, bench: "kast", deltaSpan: 10 },
  // METRIC.swing is in percent; fmtSwing takes a fraction
  { id: "swing", label: "Swing", fmt: (v) => fmtSwing(v / 100), fmtDelta: (v) => `${v.toFixed(2)}%`, bench: "swing", deltaSpan: 3 },
  { id: "hs", label: "HS%", fmt: (v) => fmtPct(v), fmtDelta: (v) => `${v.toFixed(1)}%`, bench: "hs", deltaSpan: 15 },
  { id: "accuracy", label: "Accuracy", fmt: (v) => fmtPct(v), fmtDelta: (v) => `${v.toFixed(1)}%`, bench: "acc", deltaSpan: 8, aim: true },
  { id: "reactionTime", label: "Reaction", fmt: fmtMs, fmtDelta: (v) => `${Math.round(v)} ms`, bench: "reaction", deltaSpan: 120, aim: true, visibility: true },
  { id: "timeToDamage", label: "Time to damage", fmt: fmtMs, fmtDelta: (v) => `${Math.round(v)} ms`, bench: "ttd", deltaSpan: 200, aim: true, visibility: true },
];

export const tileValue = (t: TileDef, s: Summary | null) => (s ? METRIC[t.id].value(s) : null);

/** One match's value; a match under the rating coverage rule (data/engine.ts) has no rating. */
export const entryTile = (t: TileDef, e: MatchEntry) => (t.id === "rating3" && !ratedMatch(e.match) ? null : tileValue(t, e.summary));

/** Per-match values, oldest first. */
export const seriesOf = (t: TileDef, list: MatchEntry[]) => [...list].reverse().map((e) => ({ e, v: entryTile(t, e) }));
