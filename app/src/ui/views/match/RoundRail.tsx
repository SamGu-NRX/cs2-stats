// The round rail: one column per round, the win-type glyph in the winning team's row in that team's
// side colour, a gap at each side swap, and a cream playhead on the selected round. Its columns line
// up with the round inspector's (same cell width and label column), so both read as one cursor.
import type { MatchModel } from "../../data/match";
import { HoverCard } from "../../components/overlay";
import { WinIcon, WIN_LABEL } from "../../icons/game";
import { startsHalf } from "../../lib/layout";
import { RoundCardBody } from "../shared";

export function RoundRail({ v, selected, onPick, compact }: { v: MatchModel; selected: number | null; onPick: (ri: number) => void; compact?: boolean }) {
  const max = v.maxRounds;
  if (compact) {
    return (
      <div className="rail rail--compact" role="list" aria-label="Rounds">
        {v.rounds.map((r) => {
          const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
          return (
            <button
              key={r.ri}
              role="listitem"
              className={`rail__mini ${startsHalf(r.number - 1, max) ? "is-half" : ""}`}
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
        {v.rounds.map((r) => {
          const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
          const on = selected === r.ri;
          return (
            <HoverCard
              key={r.ri}
              as="div"
              tabbable={false}
              prefer="bottom"
              className={`rail__col ${startsHalf(r.number - 1, max) ? "is-half" : ""} ${on ? "is-on" : ""}`}
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
