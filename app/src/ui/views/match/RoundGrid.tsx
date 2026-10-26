// The Rounds grid: one row per player, one column per round, one encoding per question.
// - kills: a numeral (3 or more in cream); blank for none
// - death: a corner mark
// - opening duel: an underline, cream for the opening kill, grey for the opening death
// - swing that round: a capped background tint, so small swings stay quiet and red never dominates
// - how the round ended: the official icon in the winner's colour, in the column header
// Cells never shrink (fixed 28 px); when the drawer narrows the pane the grid scrolls sideways and an
// edge fade shows on each side that has more rounds. Arrows move between cells, Enter opens the round.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { GameIcon } from "../../components/GameIcon";
import type { RoundCell } from "../../data/rounds";
import type { RoundHow } from "../../data/match";
import { WIN_LABEL, WinIcon } from "../../icons/game";
import type { Side } from "../../../stats/tables";

export interface GridRound { ri: number; number: number; how: RoundHow | null; winSide: Side | null; viewerWon: boolean | null; halfStart: boolean }
export interface GridRow { pi: number; name: string; me: boolean }
export interface GridTeam { label: string; rows: GridRow[] }

const HOW_ICON: Record<RoundHow, string> = { elim: "elimination", bomb: "bomb_exploded", defuse: "bomb_defused", time: "time" };
/** Swing tint, capped at ±35 points: green up to 60 % alpha, the muted red only to 40 %. */
export const swingTint = (sw: number | null) => {
  if (sw === null) return undefined;
  const a = Math.min(1, Math.abs(sw) / 0.35);
  return sw >= 0 ? `rgba(17, 150, 14, ${(0.1 + 0.5 * a).toFixed(2)})` : `rgba(194, 90, 79, ${(0.06 + 0.34 * a).toFixed(2)})`;
};
const cellLabel = (number: number, c: RoundCell) =>
  `Round ${number}: ${c.kills} kill${c.kills === 1 ? "" : "s"}, ${c.died ? "died" : "survived"}${c.opening === "k" ? ", opening kill" : c.opening === "d" ? ", opening death" : ""}${c.swing === null ? "" : `, swing ${c.swing >= 0 ? "+" : "−"}${Math.abs(100 * c.swing).toFixed(1)}%`}`;

export function RoundGrid({ teams, rounds, cells, selected, onOpen }: {
  teams: GridTeam[];
  rounds: GridRound[];
  /** cells[pi][ri] from data/rounds.ts roundCells */
  cells: (RoundCell | null)[][];
  selected: number | null;
  onOpen: (ri: number) => void;
}) {
  const rows = teams.flatMap((t) => t.rows);
  const [focus, setFocus] = useState<[number, number]>([0, selected ?? 0]);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  // the edge fades: shown whenever rounds are scrolled out of view on that side
  const measure = () => {
    const s = scroller.current;
    if (!s) return;
    setEdges({ left: s.scrollLeft > 2, right: s.scrollLeft + s.clientWidth < s.scrollWidth - 2 });
  };
  useLayoutEffect(() => {
    measure();
    const s = scroller.current;
    if (!s) return;
    const ro = new ResizeObserver(measure);
    ro.observe(s);
    return () => ro.disconnect();
  }, []);
  // keep the open round's column in view (no smooth scroll: the change is instant)
  useEffect(() => {
    if (selected === null) return;
    scroller.current?.querySelector<HTMLElement>(`[data-col="${selected}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    measure();
  }, [selected]);

  const move = (r: number, c: number) => {
    const nr = Math.max(0, Math.min(rows.length - 1, r)), nc = Math.max(0, Math.min(rounds.length - 1, c));
    setFocus([nr, nc]);
    scroller.current?.querySelector<HTMLElement>(`[data-cell="${nr}-${nc}"]`)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const [r, c] = focus;
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(r, c + 1), ArrowLeft: () => move(r, c - 1), ArrowDown: () => move(r + 1, c), ArrowUp: () => move(r - 1, c),
      Home: () => move(r, 0), End: () => move(r, rounds.length - 1), Enter: () => onOpen(rounds[c].ri), " ": () => onOpen(rounds[c].ri),
    };
    const run = keys[e.key];
    if (run) { e.preventDefault(); run(); }
  };

  let rowIndex = 0;
  return (
    <div className="rgrid">
      <div className="rgrid__frame" data-left={edges.left || undefined} data-right={edges.right || undefined}>
      <div className="rgrid__scroll" ref={scroller} onScroll={measure}>
        <table role="grid" aria-label="Rounds by player" aria-rowcount={rows.length + 1} aria-colcount={rounds.length + 2} onKeyDown={onKey}>
          <thead>
            <tr>
              <th className="rgrid__who caps" scope="col">Round</th>
              <th className="rgrid__tot caps" scope="col" title="Swing per round, averaged over the match">Swing</th>
              {rounds.map((r) => (
                <th key={r.ri} scope="col" data-col={r.ri} className={`rgrid__rh ${r.halfStart ? "rgrid__half" : ""}`} data-sel={selected === r.ri || undefined} data-won={r.viewerWon || undefined}
                  title={`Round ${r.number}: ${r.viewerWon === null ? "no result" : r.viewerWon ? "won" : "lost"}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}`}>
                  <button className="rgrid__headbtn" tabIndex={-1} onClick={() => onOpen(r.ri)} aria-label={`Open round ${r.number}`}>
                    <span className={r.winSide === "T" ? "t-text" : r.winSide === "CT" ? "ct-text" : "faint"}>
                      {r.how ? <GameIcon id={HOW_ICON[r.how]} width={14} fallback={<WinIcon how={r.how} size={14} />} /> : <WinIcon how={null} size={14} />}
                    </span>
                    <small className="mono">{r.number}</small>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          {teams.map((t) => (
            <tbody key={t.label}>
              <tr className="rgrid__team"><th className="rgrid__who caps" scope="rowgroup" colSpan={2}>{t.label}</th>{rounds.map((r) => <td key={r.ri} className={r.halfStart ? "rgrid__half" : undefined} />)}</tr>
              {t.rows.map((p) => {
                const ri0 = rowIndex++;
                const row = cells[p.pi] ?? [];
                const played = row.filter((c): c is RoundCell => c !== null);
                const k = played.reduce((s, c) => s + c.kills, 0), d = played.filter((c) => c.died).length;
                const valued = played.filter((c) => c.swing !== null);
                const sw = valued.length ? (100 * valued.reduce((s, c) => s + c.swing!, 0)) / valued.length : null;
                return (
                  <tr key={p.pi} className={p.me ? "rgrid__me" : undefined}>
                    <th className="rgrid__who" scope="row"><span className="rgrid__name" title={p.name}>{p.name}</span><small className="num">{k}–{d}</small></th>
                    <td className={`rgrid__tot num ${sw === null ? "faint" : sw >= 0 ? "good-text" : "poor-text"}`}>{sw === null ? "–" : `${sw >= 0 ? "+" : "−"}${Math.abs(sw).toFixed(1)}%`}</td>
                    {rounds.map((r, ci) => {
                      const c = row[r.ri];
                      const isFocus = focus[0] === ri0 && focus[1] === ci;
                      if (!c) return <td key={r.ri} className={r.halfStart ? "rgrid__half" : undefined}><span className="rgrid__c rgrid__c--none" /></td>;
                      return (
                        <td key={r.ri} className={r.halfStart ? "rgrid__half" : undefined}>
                          <span role="gridcell" tabIndex={isFocus ? 0 : -1} data-cell={`${ri0}-${ci}`} className="rgrid__c num" data-k={Math.min(c.kills, 3)} data-dead={c.died || undefined} data-open={c.opening ?? undefined}
                            data-sel={selected === r.ri || undefined} style={{ background: swingTint(c.swing) }} aria-label={cellLabel(r.number, c)} title={cellLabel(r.number, c)}
                            onClick={() => { setFocus([ri0, ci]); onOpen(r.ri); }} onFocus={() => setFocus([ri0, ci])}>
                            {c.kills || ""}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
      </div>
      <ul className="rgrid__key" aria-label="Key">
        <li><span className="rgrid__c num" data-k="2">2</span>kills that round</li>
        <li><span className="rgrid__c" data-dead="" />died</li>
        <li><span className="rgrid__c num" data-k="1" data-open="k">1</span>opening kill</li>
        <li><span className="rgrid__c" data-open="d" data-dead="" />opening death</li>
        <li><span className="rgrid__ramp">{[-0.35, -0.12, 0, 0.12, 0.35].map((s) => <i key={s} style={{ background: swingTint(s) }} />)}</span>swing that round, −35 to +35 points</li>
        <li>header icon: how the round ended, in the winner's colour</li>
      </ul>
    </div>
  );
}
