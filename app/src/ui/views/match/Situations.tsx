// Two cards for the Advanced tab on #36's worker calls:
// - Man advantage (worker situations): every "you v them" state your side passed through, as a grid of
//   players alive, your side down the rows and theirs across, each cell the rounds that reached it and
//   the share your side won. One tab stop; the arrow keys walk the cells.
// - Bombsites (worker bombsites): take and post-plant on T, hold and retake on CT, per site.
import { useState, type KeyboardEvent } from "react";
import { Card } from "../../components/Card";
import { useCall } from "../../data/hooks";
import type { ViewedMatch } from "../../data/match";
import { fmtPct } from "../../lib/format";
import { scoreTint, toScore } from "../../lib/scale";
import { Hint } from "./glyphs";
import { LoadFailed } from "./LoadFailed";
import { situationGrid, SITE_ROWS, sitesOf, takeHoldGap } from "./parity";

const pct = (won: number, n: number) => (n ? (100 * won) / n : null);

export function SituationsCard({ v, file }: { v: ViewedMatch; file: string }) {
  const call = useCall("situations", [{ files: [file], filter: { player: v.players[v.human].key } }]);
  const s = call.data;
  const [at, setAt] = useState<[number, number]>([0, 0]);
  const title = <>Man advantage <Hint tip="Rounds your side reached each count of players alive, and the share it won. A round counts once in every state it passed through." /></>;
  if (call.error) return <Card title={title}><LoadFailed what="Man advantage" error={call.error} /></Card>;
  if (!s) return <Card title={title}><div className="skel" style={{ height: 260 }} /></Card>;
  const { size, cells } = situationGrid(s);
  if (!size) return <Card title={title}><p className="meta">No round in this match has a result.</p></Card>;
  const [r0, c0] = [Math.min(at[0], size - 1), Math.min(at[1], size - 1)];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, [number, number]>)[e.key];
    let next: [number, number] | null = d ? [Math.max(0, Math.min(size - 1, r0 + d[0])), Math.max(0, Math.min(size - 1, c0 + d[1]))] : null;
    if (e.key === "Home") next = [r0, 0];
    if (e.key === "End") next = [r0, size - 1];
    if (!next) return;
    e.preventDefault();
    setAt(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-cell="${next[0]}-${next[1]}"]`)?.focus();
  };
  return (
    <Card title={title} aside={<span className="meta">You down, them across</span>}>
      <div className="sit" role="grid" aria-label="Rounds won from each count of players alive, yours against theirs" onKeyDown={onKey} style={{ ["--n" as string]: size }}>
        <div className="sit__row" role="row">
          <span className="sit__corner caps" role="columnheader">You v them</span>
          {cells[0].map((_, c) => <span key={c} className="sit__colh num" role="columnheader">{size - c}</span>)}
        </div>
        {cells.map((row, r) => (
          <div key={r} className="sit__row" role="row">
            <span className="sit__rowh num" role="rowheader">{size - r}</span>
            {row.map((cell, c) => {
              const us = size - r, them = size - c;
              const p = cell ? pct(cell.won, cell.rounds) : null;
              const label = cell ? `${us}v${them}: reached in ${cell.rounds} ${cell.rounds === 1 ? "round" : "rounds"}, won ${cell.won} (${fmtPct(p, 0)})` : `${us}v${them}: never reached`;
              return (
                <div
                  key={c}
                  role="gridcell"
                  data-cell={`${r}-${c}`}
                  tabIndex={r === r0 && c === c0 ? 0 : -1}
                  onFocus={() => setAt([r, c])}
                  aria-label={label}
                  data-tip={label}
                  className={`sit__cell ${us === them ? "is-even" : us > them ? "is-up" : "is-down"} ${cell ? "" : "is-none"}`}
                  style={{ background: p === null ? undefined : scoreTint(toScore(p, 50, 50), 0.4) }}
                >
                  {cell ? <><b className="num">{fmtPct(p, 0)}</b><small className="num">{cell.won}/{cell.rounds}</small></> : <span aria-hidden>·</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function BombsitesCard({ v, file }: { v: ViewedMatch; file: string }) {
  const call = useCall("bombsites", [file, v.players[v.human].key]);
  const b = call.data;
  const title = <>Bombsites <Hint tip="Your side's rounds at each site: taking and planting it on T, holding and retaking it on CT." /></>;
  if (call.error) return <Card title={title}><LoadFailed what="Bombsites" error={call.error} /></Card>;
  if (!b) return <Card title={title}><div className="skel" style={{ height: 260 }} /></Card>;
  const sites = sitesOf(b);
  const gap = takeHoldGap(b.takeHold);
  if (!sites.length) return <Card title={title}><p className="meta">{gap ?? "No round of yours reached a bombsite."}</p></Card>;
  return (
    <Card title={title} aside={<span className="meta">Over your {b.takeHold.rounds} rounds</span>} foot={gap ? <p className="meta">{gap}</p> : undefined}>
      <div className="bs" role="table" aria-label="Your side's outcomes at each bombsite" style={{ ["--n" as string]: sites.length }}>
        <div className="bs__row bs__row--head" role="row">
          <span role="columnheader" className="bs__span"><span className="sr-only">Outcome</span></span>
          {sites.map(({ letter }) => <b key={letter} role="columnheader" className="disp disp--s bs__letter">{letter}</b>)}
        </div>
        {SITE_ROWS.map((row) => (
          <div key={row.key} className={`bs__row ${row.key === "hold" ? "is-ct-first" : ""}`} role="row">
            <span role="rowheader" className="bs__span" data-tip={row.tip} tabIndex={0}>
              <span className={`pip ${row.side === "T" ? "pip--t" : "pip--ct"}`}>{row.side}</span>
              <span className="bs__l">{row.label}</span>
            </span>
            {sites.map(({ letter, o }) => {
              const x = o[row.key];
              const p = x ? pct(x.success, x.attempts) : null;
              const said = x ? `${x.success} of ${x.attempts}` : "not read";
              return (
                <span key={letter} role="cell" className="bs__cell" data-tip={`${row.label} at ${letter}: ${said}`} tabIndex={0} aria-label={`${row.label} at ${letter} on ${row.side}: ${said}`}>
                  <span className="hbar" aria-hidden>{p !== null && <i style={{ width: `${p}%`, background: "var(--cream)", opacity: 0.8 }} />}</span>
                  <b className="num bs__p">{fmtPct(p, 0)}</b>
                  <span className="num faint bs__n">{x ? `${x.success}/${x.attempts}` : "–"}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </Card>
  );
}
