// The round rail: one column per round, the official round-end icon in the winning team's row in that team's
// side colour, a gap at each side swap, and a cream playhead on the selected round. Its columns line
// up with the round inspector's (same cell width and label column), so both read as one cursor. A
// round the file holds only as totals (MatchInfo.totalsOnly) is a hatched column with no round end.
import { columnOf, roundColumns, totalsWinner, type MatchModel } from "../../data/match";
import { HoverCard } from "../../components/overlay";
import { WIN_LABEL, WinIcon } from "../../icons/game";
import { RoundCardBody, TotalsCardBody } from "../shared";

/** selected and onPick are round numbers, so totals-only rounds can be picked too. */
export function RoundRail({ v, selected, onPick, compact }: { v: MatchModel; selected: number | null; onPick: (number: number) => void; compact?: boolean }) {
  const cols = roundColumns(v);
  const on = columnOf(cols, selected);
  const result = (w: "us" | "them" | null) => (w === "us" ? "won" : w === "them" ? "lost" : "result unknown");
  if (compact) {
    return (
      <div className="rail rail--compact" role="list" aria-label="Rounds">
        {cols.map((c) => {
          if (c.kind === "totals") {
            const w = totalsWinner(v, c);
            return (
              <button key={`t${c.number}`} role="listitem" className={`rail__mini is-lite ${c.halfStart ? "is-half" : ""}`} data-side="none" data-won={w === "us"}
                aria-label={`Round ${c.number}: ${result(w)}, totals only`} data-tip={`Round ${c.number}: ${result(w)}, totals only`} onClick={() => onPick(c.number)} />
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
              onClick={() => onPick(r.number)}
            >
              <WinIcon how={r.how} size={10} compact />
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="rail" role="group" aria-label="Round history">
      <div className="rail__labels" aria-hidden>
        {/* a pro demo names its teams; the user's own match is "you" against "them" */}
        <span className={v.pro ? "rail__team" : undefined}>{v.pro ? v.teamName.us : "You"}</span>
        <span className={v.pro ? "rail__team" : undefined}>{v.pro ? v.teamName.them : "Them"}</span>
        <span className="faint">Round</span>
      </div>
      <div className="rail__cols">
        {cols.map((c, ci) => {
          const pressed = on === ci;
          if (c.kind === "totals") {
            const w = totalsWinner(v, c);
            return (
              <HoverCard key={`t${c.number}`} as="div" tabbable={false} prefer="bottom" className={`rail__col is-lite ${c.halfStart ? "is-half" : ""} ${pressed ? "is-on" : ""}`} card={() => <TotalsCardBody v={v} col={c} />}>
                <button className="rail__btn" onClick={() => onPick(c.number)} aria-label={`Round ${c.number}, ${result(w)}, totals only`} aria-pressed={pressed}>
                  <span className="rail__cell" data-side="none" />
                  <span className="rail__cell" data-side="none" />
                  <span className="rail__n num">{c.number}</span>
                </button>
              </HoverCard>
            );
          }
          const r = c.r;
          const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
          return (
            <HoverCard
              key={r.ri}
              as="div"
              tabbable={false}
              prefer="bottom"
              className={`rail__col ${c.halfStart ? "is-half" : ""} ${pressed ? "is-on" : ""}`}
              card={() => <RoundCardBody v={v} r={r} />}
            >
              <button className="rail__btn" onClick={() => onPick(r.number)} aria-label={`Round ${r.number}, ${r.winner === "us" ? "won" : r.winner === "them" ? "lost" : "result unknown"}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}`} aria-pressed={pressed}>
                <span className="rail__cell" data-side={r.winner === "us" ? side : "none"}>{r.winner === "us" && <WinIcon how={r.how} size={12} compact />}</span>
                <span className="rail__cell" data-side={r.winner === "them" ? side : "none"}>{r.winner === "them" && <WinIcon how={r.how} size={12} compact />}</span>
                <span className="rail__n num">{r.number}</span>
              </button>
            </HoverCard>
          );
        })}
      </div>
    </div>
  );
}
