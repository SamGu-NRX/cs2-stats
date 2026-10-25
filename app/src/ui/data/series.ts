// Home's headline tiles: which metric each tile shows, its format and its benchmark. Values are the
// worker's metric values over a match or over the filter.
import type { Values } from "../../worker/protocol";
import { fmtAdr, fmtDec, fmtMs, fmtPct, fmtRating, fmtSwing } from "../lib/format";
import type { BenchId } from "../lib/verdict";
import type { MatchEntry } from "./match";

export interface TileDef {
  /** metric id */
  id: string;
  label: string;
  fmt: (v: number) => string;
  bench: BenchId;
  /** needs shots, which only recorded matches carry */
  aim?: boolean;
  /** needs mesh visibility (MatchInfo.visibility "ok") */
  visibility?: boolean;
}

export const TILES: TileDef[] = [
  { id: "rating3", label: "Rating 3.0", fmt: fmtRating, bench: "rating" },
  { id: "kpr", label: "KPR", fmt: (v) => fmtDec(v), bench: "kpr" },
  { id: "adr", label: "ADR", fmt: fmtAdr, bench: "adr" },
  { id: "kast", label: "KAST", fmt: (v) => fmtPct(v), bench: "kast" },
  // the swing metric is in percent; fmtSwing takes a fraction
  { id: "swing", label: "Swing", fmt: (v) => fmtSwing(v / 100), bench: "swing" },
  { id: "hs", label: "HS%", fmt: (v) => fmtPct(v), bench: "hs" },
  { id: "accuracy", label: "Accuracy", fmt: (v) => fmtPct(v), bench: "acc", aim: true },
  { id: "reactionTime", label: "Reaction", fmt: fmtMs, bench: "reaction", aim: true, visibility: true },
  { id: "timeToDamage", label: "Time to damage", fmt: fmtMs, bench: "ttd", aim: true, visibility: true },
];

/** A tile's value over a filter; its rating is the pooled one the caller passes (under the coverage rule). */
export const tileValue = (t: TileDef, v: Values | null, rating: number | null) => (!v ? null : t.id === "rating3" ? rating : v[t.id]);

/** One match's value; a match under the rating coverage rule has no rating. */
export const entryTile = (t: TileDef, e: MatchEntry) => tileValue(t, e.line.v, e.line.rating);

/** Per-match values, oldest first. */
export const seriesOf = (t: TileDef, list: MatchEntry[]) => [...list].reverse().map((e) => ({ e, v: entryTile(t, e) }));
