// The round rail: one column per round, the win-type glyph in the winning team's row in that team's
// side colour, a gap at each side swap, and a cream playhead on the selected round. Its columns line
// up with the round inspector's (same cell width and label column, data/match.ts roundColumns), so
// both read as one cursor. A round the file holds only as totals is a hatched column with its number.
import { useMemo } from "react";
import { roundColumns, type MatchModel } from "../../data/match";
import { HoverCard } from "../../components/overlay";
import { WinIcon, WIN_LABEL } from "../../icons/game";
import { go, matchHref, openMatch, useRoute } from "../../router";
import { RoundCardBody, TotalsCardBody } from "../shared";

export function RoundRail({ v, selected, onPick, compact }: { v: MatchModel; selected: number | null; onPick: (ri: number) => void; compact?: boolean }) {
  const cols = useMemo(() => roundColumns(v), [v]);
  const route = useRoute();
  // the match view finds no round row for a totals-only round number, so its selection is read here
  const urlRound = route.page === "match" && route.file === v.file && route.query.get("round") ? Number(route.query.get("round")) : null;
  // callers open rounds with facts by row; a totals-only round has none, so it opens by number
  const openTotals = (n: number) => (compact ? openMatch : go)(matchHref(v.file, "rounds", { round: n }));
  if (compact) {
    return (
      <div className="rail rail--compact" role="list" aria-label="Rounds">
        {cols.map((c) => {
          if (c.kind === "totals") {
            return (
              <button
                key={`t${c.number}`}
                role="listitem"
                className={`rail__mini is-lite ${c.halfStart ? "is-half" : ""}`}
                aria-label={`Round ${c.number}: totals only`}
                data-tip={`Round ${c.number}: totals only`}
                onClick={() => openTotals(c.number)}
              />
            );
          }
          const r = c.r;
          const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
          return (
            <button
              key={r.ri}
              role="listitem"
              className={`rail__mini ${c.halfStart ? "is-half" : ""}`}
              data-side={side}
              data-won={r.winner === "us"}
              aria-label={`Round ${r.number}: ${r.winner === "us" ? "won" : r.winner === "them" ? "lost" : "unknown"}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}`}
              data-tip={`Round ${r.number}: ${r.winner === "us" ? "won" : "lost"}${r.how ? `, ${WIN_LABEL[r.how].toLowerCase()}` : ""}`}
              onClick={() => onPick(r.ri)}
            >
              <WinIcon how={r.how} size={10} />
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="rail" role="group" aria-label="Round history">
      <div className="rail__labels" aria-hidden>
        <span>You</span>
        <span>Them</span>
        <span className="faint">Round</span>
      </div>
      <div className="rail__cols">
        {cols.map((c) => {
          if (c.kind === "totals") {
            const on = selected === null && urlRound === c.number;
            return (
              <HoverCard
                key={`t${c.number}`}
                as="div"
                tabbable={false}
                prefer="bottom"
                className={`rail__col is-lite ${c.halfStart ? "is-half" : ""} ${on ? "is-on" : ""}`}
                card={() => <TotalsCardBody number={c.number} />}
              >
                <button className="rail__btn" onClick={() => openTotals(c.number)} aria-label={`Round ${c.number}, totals only`} aria-pressed={on}>
                  <span className="rail__cell" data-side="none" />
                  <span className="rail__cell" data-side="none" />
                  <span className="rail__n num">{c.number}</span>
                </button>
              </HoverCard>
            );
          }
          const r = c.r;
          const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
          const on = selected === r.ri;
          return (
            <HoverCard
              key={r.ri}
              as="div"
              tabbable={false}
              prefer="bottom"
              className={`rail__col ${c.halfStart ? "is-half" : ""} ${on ? "is-on" : ""}`}
              card={() => <RoundCardBody v={v} r={r} />}
            >
              <button className="rail__btn" onClick={() => onPick(r.ri)} aria-label={`Round ${r.number}, ${r.winner === "us" ? "won" : r.winner === "them" ? "lost" : "result unknown"}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}`} aria-pressed={on}>
                <span className="rail__cell" data-side={r.winner === "us" ? side : "none"}>{r.winner === "us" && <WinIcon how={r.how} size={12} />}</span>
                <span className="rail__cell" data-side={r.winner === "them" ? side : "none"}>{r.winner === "them" && <WinIcon how={r.how} size={12} />}</span>
                <span className="rail__n num">{r.number}</span>
              </button>
            </HoverCard>
          );
        })}
      </div>
    </div>
  );
}
