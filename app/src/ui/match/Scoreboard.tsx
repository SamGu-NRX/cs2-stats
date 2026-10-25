// HLTV-style scoreboard, one table per team, sorted by rating.
import type { MatchView, PlayerRow, TeamId } from "../../stats/derive";
import { METRICS, tooltip } from "../../stats/metrics";
import { ratingClass, signed, swingPct } from "../format";
import { ModelBadge } from "../ModelBadge";

const tipOf = (id: string) => tooltip(METRICS[id]);

export function Scoreboard({ v, team }: { v: MatchView; team: TeamId }) {
  const rows = v.players.filter((p) => p.team === team).sort((a, b) => b.rating - a.rating);
  const won = team === "us" ? v.score.us : v.score.them;
  const sideNow = v.rounds[v.rounds.length - 1]?.usSide;
  const side = team === "us" ? sideNow : sideNow === 3 ? 2 : 3;
  const swingTip = `${tipOf("swing")} ${v.model.kind === "stub"
    ? "Placeholder model: alive counts only. The trained model accounts for both teams' equipment, HP, the bomb and the clock."
    : "Win probability comes from a model fitted to CS2RB data (Bishop 2026, CS2RB v1.0, CC BY 4.0), using both teams' alive players, HP, freeze-end equipment, the bomb and the clock."} Rounds with unknown equipment have no swing.`;
  return (
    <section className="glass card" aria-label={team === "us" ? "Your team" : "Opponents"}>
      <div className="card__head">
        <h2 className="card__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {team === "us" ? "Your team" : "Opponents"}
          {side && <span className={`side side--${side === 3 ? "ct" : "t"}`}>{side === 3 ? "CT" : "T"}</span>}
        </h2>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {team === "us" && <ModelBadge />}
          <span className="note num">{won} rounds won</span>
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Player</th>
              <th tabIndex={0} data-tip="Kills – deaths. Kills exclude team kills; deaths include world deaths. As in CS Demo Manager.">K–D</th>
              <th tabIndex={0} data-tip="Kills minus deaths.">+/−</th>
              <th tabIndex={0} data-tip={tipOf("adr")}>ADR</th>
              <th tabIndex={0} data-tip={tipOf("kast")}>KAST</th>
              <th tabIndex={0} data-tip={swingTip}>{v.model.kind === "stub" ? "Swing*" : "Swing"}</th>
              <th tabIndex={0} data-tip={tipOf("hs")}>HS%</th>
              <th tabIndex={0} data-tip={tipOf("rating")}>Rating</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => <Line key={p.pi} p={p} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Line({ p }: { p: PlayerRow }) {
  const diff = p.c.kills - p.c.deaths;
  return (
    <tr className={p.isHuman ? "is-you" : undefined}>
      <td className="name">
        <span className="selectable">{p.name}</span>
        {p.isHuman && <span className="pill pill--you" style={{ marginLeft: 8 }}>You</span>}
      </td>
      <td>{p.c.kills}–{p.c.deaths}</td>
      <td className={diff > 0 ? "pos" : diff < 0 ? "neg" : ""}>{signed(diff)}</td>
      <td>{p.adr.toFixed(1)}</td>
      <td>{p.kast.toFixed(1)}%</td>
      <td className={p.swingPerRound === null ? "muted" : p.swingPerRound > 0 ? "pos" : p.swingPerRound < 0 ? "neg" : ""}>{swingPct(p.swingPerRound)}</td>
      <td>{p.hs}%</td>
      <td className={`rt ${ratingClass(p.rating)}`}>{p.rating.toFixed(2)}</td>
    </tr>
  );
}
