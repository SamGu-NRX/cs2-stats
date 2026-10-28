// Home's headline tiles: which metric each tile shows, its format and its benchmark. Values are the
// worker's metric values over a match or over the filter.
import type { Values } from "../../worker/protocol";
import { fmtAdr, fmtDec, fmtMs, fmtPct, fmtRating, fmtSwing } from "../lib/format";
import type { BenchId } from "../lib/verdict";
import type { OwnEntry } from "./engine";

export interface TileDef {
  /** metric id */
  id: string;
  label: string;
  fmt: (v: number) => string;
  bench: BenchId;
  /** a delta's format (its absolute value; the sign is drawn as an arrow) */
  fmtDelta: (v: number) => string;
  /** the difference that reads as fully good or bad in a delta (main's spans; no data run picked them) */
  deltaSpan: number;
  lowerIsBetter?: boolean;
  /** needs shots, which only recorded matches carry */
  aim?: boolean;
  /** needs mesh visibility (MatchInfo.visibility "ok") */
  visibility?: boolean;
}

const pctDelta = (v: number) => `${v.toFixed(1)}%`;
const msDelta = (v: number) => `${Math.round(v)} ms`;

export const TILES: TileDef[] = [
  { id: "rating3", label: "Rating 3.0", fmt: fmtRating, bench: "rating", fmtDelta: (v) => v.toFixed(2), deltaSpan: 0.3 },
  { id: "kpr", label: "KPR", fmt: (v) => fmtDec(v), bench: "kpr", fmtDelta: (v) => v.toFixed(2), deltaSpan: 0.2 },
  { id: "adr", label: "ADR", fmt: fmtAdr, bench: "adr", fmtDelta: (v) => v.toFixed(1), deltaSpan: 20 },
  { id: "kast", label: "KAST", fmt: (v) => fmtPct(v), bench: "kast", fmtDelta: pctDelta, deltaSpan: 10 },
  // the swing metric is in percent; fmtSwing takes a fraction
  { id: "swing", label: "Swing", fmt: (v) => fmtSwing(v / 100), bench: "swing", fmtDelta: (v) => `${v.toFixed(2)}%`, deltaSpan: 3 },
  { id: "hs", label: "HS%", fmt: (v) => fmtPct(v), bench: "hs", fmtDelta: pctDelta, deltaSpan: 15 },
  { id: "accuracy", label: "Accuracy", fmt: (v) => fmtPct(v), bench: "acc", fmtDelta: pctDelta, deltaSpan: 8, aim: true },
  { id: "reactionTime", label: "Reaction", fmt: fmtMs, bench: "reaction", fmtDelta: msDelta, deltaSpan: 120, lowerIsBetter: true, aim: true, visibility: true },
  { id: "timeToDamage", label: "Time to damage", fmt: fmtMs, bench: "ttd", fmtDelta: msDelta, deltaSpan: 200, lowerIsBetter: true, aim: true, visibility: true },
];

/** A tile's value over a filter; its rating is the pooled one the caller passes (under the coverage rule). */
export const tileValue = (t: TileDef, v: Values | null, rating: number | null) => (!v ? null : t.id === "rating3" ? rating : v[t.id]);

/** One match's value; a match under the rating coverage rule has no rating. */
export const entryTile = (t: TileDef, e: OwnEntry) => tileValue(t, e.line.v, e.line.rating);

/** The last match's value minus the value over the filter; null when either is missing. */
export const tileDelta = (t: TileDef, last: OwnEntry | null, pooled: number | null) => {
  const x = last ? entryTile(t, last) : null;
  return x === null || pooled === null ? null : x - pooled;
};

/** Per-match values, oldest first. */
export const seriesOf = (t: TileDef, list: OwnEntry[]) => [...list].reverse().map((e) => ({ e, v: entryTile(t, e) }));
