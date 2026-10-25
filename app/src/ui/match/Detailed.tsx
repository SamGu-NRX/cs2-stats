// Detailed stats per player, both teams, after HLTV's "detailed stats" table.
import type { PlayerRow } from "../../stats/derive";
import { formatMetric, METRICS, tooltip, UTIL_METRICS } from "../../stats/metrics";
import { sideSlices } from "../../stats/utility";
import { UtilityTable } from "../UtilityTable";
import type { TabProps } from "./MatchPage";

const T = (id: string) => tooltip(METRICS[id]);

const COLS: { head: string; tip: string; cell: (p: PlayerRow) => string; wrap?: boolean }[] = [
  { head: "Opening K:D", tip: `${T("openKPR")} Shown as opening kills : opening deaths.`, cell: (p) => `${p.c.openingKills}:${p.c.openingDeaths}` },
  {
    head: "Multi-kills", tip: "Rounds with exactly 2, 3, 4 or 5 kills. As in CS Demo Manager.",
    cell: (p) => [2, 3, 4, 5].filter((k) => p.c.kc[k]).map((k) => `${p.c.kc[k]}×${k}K`).join(" ") || "–",
  },
  {
    head: "Clutches", tip: "1vX situations won / played, as CS Demo Manager detects them: the first time your side is down to you alone, against the enemies still alive.",
    cell: (p) => p.c.clutchN.map((n, i) => (n ? `1v${i + 1} ${p.c.clutchW[i]}/${n}` : "")).filter(Boolean).join(", ") || "–",
    wrap: true,
  },
  { head: "Sniper K", tip: METRICS.sniperKPR.def.replace(", per round", ""), cell: (p) => (p.c.sniperKills ? `${p.c.sniperKills} (${Math.round((100 * p.c.sniperKills) / Math.max(1, p.c.kills))}%)` : "–") },
  { head: "Trade K", tip: "Kills on an enemy who had made a kill less than 5 s earlier. As in CS Demo Manager.", cell: (p) => String(p.c.tradeKills) },
  { head: "Traded D", tip: "Deaths whose killer was killed less than 5 s later, out of all deaths. As in CS Demo Manager.", cell: (p) => (p.c.deaths ? `${p.c.tradedDeaths}/${p.c.deaths}` : "–") },
  { head: "Util dmg", tip: "Enemy damage from grenades and fire. As in CS Demo Manager.", cell: (p) => String(p.c.utilDmg) },
  { head: "Flashed", tip: "Opponents flashed: enemies your flashes blinded for any time.", cell: (p) => String(p.c.enemiesFlashed) },
  { head: "Flash assists", tip: METRICS.flashAssistsPR.def.replace(", per round", ""), cell: (p) => String(p.c.flashAssists) },
  { head: "Saves", tip: METRICS.savesPerLoss.def.replace(", per lost round", ""), cell: (p) => String(p.c.saves) },
];

function TeamTable({ rows, title }: { rows: PlayerRow[]; title: string }) {
  return (
    <section className="glass card" aria-label={title}>
      <div className="card__head"><h2 className="card__title">{title}</h2></div>
      <div className="tbl-wrap">
        <table className="tbl tbl--auto">
          <thead>
            <tr>
              <th>Player</th>
              {COLS.map((c) => <th key={c.head} tabIndex={0} data-tip={c.tip}>{c.head}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pi} className={p.isHuman ? "is-you" : undefined}>
                <td className="name"><span className="selectable">{p.name}</span>{p.isHuman && <span className="pill pill--you" style={{ marginLeft: 8 }}>You</span>}</td>
                {COLS.map((c) => <td key={c.head} className={c.wrap ? "wrap" : undefined}>{c.cell(p)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** HLTV's match-page utility columns for every player. */
const UTIL_COLS = ["u_flashesPR", "u_oppFlashed", "u_flashAssists", "u_blindPR", "u_dmgPR", "u_grenadeDmgPR", "u_killsPer100"];

function UtilityPlayers({ v }: { v: TabProps["v"] }) {
  const rows = [...v.players].sort((a, b) => (a.team === b.team ? b.rating - a.rating : a.team === "us" ? -1 : 1));
  const defs = UTIL_COLS.map((id) => UTIL_METRICS.find((m) => m.id === id)!);
  return (
    <section className="glass card" aria-label="Utility">
      <div className="card__head"><h2 className="card__title">Utility</h2><span className="note">Both teams</span></div>
      <div className="tbl-wrap">
        <table className="tbl tbl--auto">
          <thead><tr><th>Player</th>{defs.map((m) => <th key={m.id} tabIndex={0} data-tip={tooltip({ ...m, value: () => null })}>{m.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((p) => {
              const u = sideSlices(p.c.util, "both");
              return (
                <tr key={p.pi} className={p.isHuman ? "is-you" : undefined}>
                  <td className="name"><span className={p.team === "us" ? "feed__name is-us" : "feed__name"}>{p.name}</span></td>
                  {defs.map((m) => <td key={m.id}>{formatMetric({ ...m, value: () => null }, m.u(u))}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Detailed({ v }: TabProps) {
  const by = (team: "us" | "them") => v.players.filter((p) => p.team === team).sort((a, b) => b.rating - a.rating);
  return (
    <>
      {v.captured < v.nRounds && (
        <p className="note" style={{ padding: "0 6px" }}>
          <span className="pill pill--warn" style={{ marginRight: 8 }}>Partial</span>
          Opening K:D, clutches, sniper kills, trades, utility, flashes and saves need the kill-by-kill log, so they cover {v.captured} of {v.nRounds} rounds (without round{v.nRounds - v.captured === 1 ? "" : "s"} {v.rounds.filter((r) => !r.captured).map((r) => r.ri + 1).join(", ")}). Multi-kills cover all rounds with stats.
        </p>
      )}
      <TeamTable rows={by("us")} title="Your team" />
      <TeamTable rows={by("them")} title="Opponents" />
      <UtilityPlayers v={v} />
      <UtilityTable util={v.players[v.human].c.util} title="Your utility by side" />
    </>
  );
}
