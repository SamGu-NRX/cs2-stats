// Kill matrix: your team down the side, opponents across the top. Each cell reads
// "row player's kills on the column player : the column player's kills on the row player".
import { useMemo, useState } from "react";
import type { MatchView } from "../../stats/derive";
import { Segmented } from "../Segmented";
import type { TabProps } from "./MatchPage";

type Mode = "all" | "opening";

function openingMatrix(v: MatchView): number[][] {
  const n = v.players.length;
  const m = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const r of v.rounds) {
    const first = r.kills.find((k) => !k.teamKill);
    if (first && first.killer !== null) m[first.killer][first.victim]++;
  }
  return m;
}

export default function KillMatrix({ v }: TabProps) {
  const [mode, setMode] = useState<Mode>("all");
  const matrix = useMemo(() => (mode === "all" ? v.killMatrix : openingMatrix(v)), [v, mode]);
  const us = v.players.filter((p) => p.team === "us").sort((a, b) => b.rating - a.rating);
  const them = v.players.filter((p) => p.team === "them").sort((a, b) => b.rating - a.rating);
  return (
    <section className="glass card" aria-label="Kill matrix">
      <div className="card__head">
        <div>
          <h2 className="card__title">Kill matrix</h2>
          <p className="note">Row player's kills on the column player : the column player's kills on the row player.</p>
        </div>
        <Segmented size="sm" label="Kills shown" value={mode} onChange={setMode}
          options={[{ value: "all", label: "All kills" }, { value: "opening", label: "Opening kills", tip: "First kill of each round only (team kills skipped). As in CS Demo Manager." }]} />
      </div>
      <div className="tbl-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th />
              {them.map((p) => <th key={p.pi} scope="col"><span className="matrix__name">{p.name}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {us.map((a) => (
              <tr key={a.pi} className={a.isHuman ? "is-you" : undefined}>
                <th scope="row" className="matrix__row">{a.name}{a.isHuman && <span className="pill pill--you" style={{ marginLeft: 6 }}>You</span>}</th>
                {them.map((b) => {
                  const k = matrix[a.pi][b.pi];
                  const d = matrix[b.pi][a.pi];
                  const tone = k > d ? "is-up" : k < d ? "is-down" : k === 0 ? "is-none" : "";
                  return (
                    <td key={b.pi}>
                      <span className={`matrix__cell ${tone}`} data-tip={`${a.name} killed ${b.name} ${k} time${k === 1 ? "" : "s"}; ${b.name} killed ${a.name} ${d} time${d === 1 ? "" : "s"}`}>
                        <b>{k}</b><i>:</i>{d}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
