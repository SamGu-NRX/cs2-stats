// Rounds: the round inspector and the round drawer. The inspector is a players × rounds grid,
// grouped by team: each cell shows the player's kills as skulls (a bullet hole marks a headshot),
// a cross for a death, a drop for the round's opening kill, and is tinted green to red by the
// player's swing that round. Arrow keys move between cells (no animation), Enter opens the round.
// A round the file holds only as totals (MatchInfo.totalsOnly) is a hatched column with the game's own
// per-player kills and deaths when the file has them (MatchCore.totalsRounds).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HoverCard } from "../../components/overlay";
import { roundColumns, roundMatrix, selectedColumn, type MatchModel as MatchView, type RoundCell, type RoundColumn } from "../../data/match";
import { DeathIcon, FirstKillIcon, SkullIcon, WinIcon, WIN_LABEL } from "../../icons/game";
import { killSlots, moveIndex } from "../../lib/layout";
import { fmtSwing, plural } from "../../lib/format";
import { roundSwingScore, scoreText, scoreTint, swingScore } from "../../lib/scale";
import { setQuery, useRoute } from "../../router";
import { PlayerName, RoundCardBody, swingSumTip, TotalsCardBody } from "../shared";
import { statLine } from "../../data/engine";
import type { Line } from "../../../worker/protocol";
import type { TabProps } from "./MatchView";
import { RoundDrawer } from "./RoundDrawer";

export default function Rounds({ v, round }: TabProps) {
  const matrix = useMemo(() => roundMatrix(v), [v]);
  const cols = useMemo(() => roundColumns(v), [v]);
  const q = useRoute().query.get("round");
  // columns, not round rows: stepping and the drawer also reach the totals-only rounds
  const sel = selectedColumn(cols, round !== null && round >= 0 && round < v.nRounds ? round : null, q ? Number(q) : null);
  const open = (c: number | null) => setQuery("round", c === null ? null : String(cols[c].number));

  // ← → step rounds while the drawer is open (no animation); Esc closes it.
  useEffect(() => {
    if (sel === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [role=grid], [role=listbox], [role=menu]")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); open(Math.max(0, sel - 1)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); open(Math.min(cols.length - 1, sel + 1)); }
      else if (e.key === "Escape") { e.preventDefault(); open(null); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sel, cols]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounds">
      <RoundDrawer v={v} cols={cols} sel={sel} onClose={() => open(null)} onStep={(d) => sel !== null && open(Math.max(0, Math.min(cols.length - 1, sel + d)))}>
        <Inspector v={v} matrix={matrix} cols={cols} sel={sel} onOpen={open} />
        <Legend lite={cols.length - v.nRounds} />
      </RoundDrawer>
    </div>
  );
}

function Legend({ lite }: { lite: number }) {
  return (
    <div className="legend inspector__legend">
      <span><SkullIcon size={11} className="skull" /> Kill</span>
      <span><SkullIcon hs size={11} className="skull skull--hs" /> Headshot</span>
      <span><DeathIcon size={11} className="poor-text" /> Died</span>
      <span><FirstKillIcon size={11} className="cream" /> Opening kill</span>
      <span className="legend__scale"><i style={{ background: scoreTint(-1) }} /><i style={{ background: scoreTint(-0.4) }} /><i style={{ background: "var(--bg1)" }} /><i style={{ background: scoreTint(0.4) }} /><i style={{ background: scoreTint(1) }} /> Swing that round</span>
      {lite > 0 && <span><i className="swatch hatch-swatch" /> {plural(lite, "round")} with totals only</span>}
    </div>
  );
}

function Inspector({ v, matrix, cols, sel, onOpen }: { v: MatchView; matrix: RoundCell[][]; cols: RoundColumn[]; sel: number | null; onOpen: (c: number) => void }) {
  const lines = v.b.lines.both;
  const rating = (pi: number) => lines[pi].rating ?? 0;
  const us = v.players.filter((p) => p.team === "us").sort((a, b) => (a.isHuman ? -1 : b.isHuman ? 1 : rating(b.pi) - rating(a.pi)));
  const them = v.players.filter((p) => p.team === "them").sort((a, b) => rating(b.pi) - rating(a.pi));
  const order = [...us, ...them];
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: sel ?? 0 });
  const grid = useRef<HTMLDivElement>(null);
  const opening = useMemo(() => v.rounds.map((r) => r.kills.find((k) => k.opening)?.killer ?? null), [v]);

  useEffect(() => { if (sel !== null) setFocus((f) => ({ ...f, c: sel })); }, [sel]);

  const onKey = (e: KeyboardEvent) => {
    const n = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    let next = focus;
    if (n) next = { r: moveIndex(focus.r, n[0], order.length), c: moveIndex(focus.c, n[1], cols.length) };
    else if (e.key === "Home") next = { ...focus, c: 0 };
    else if (e.key === "End") next = { ...focus, c: cols.length - 1 };
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(focus.c); return; }
    else return;
    e.preventDefault();
    setFocus(next);
    grid.current?.querySelector<HTMLElement>(`[data-cell="${next.r}-${next.c}"]`)?.focus();
  };

  const teamRow = (t: "us" | "them") => {
    const firstSide = t === "us" ? v.usStartSide : v.usStartSide === "T" ? "CT" : "T";
    return (
      <div className="ig__row ig__row--team" role="row">
        <div className="ig__name ig__name--team" role="rowheader">
          <b>{t === "us" ? "Your team" : "Opponents"}</b>
          <span className="num cream">{t === "us" ? v.entry.score.us : v.entry.score.them}</span>
        </div>
        {cols.map((c) => {
          if (c.kind === "totals") return <div key={`t${c.number}`} className={`ig__side ${c.halfStart ? "is-half" : ""}`} role="gridcell" aria-hidden />;
          const s = t === "us" ? c.r.usSide : c.r.usSide === "T" ? "CT" : "T";
          return <div key={c.r.ri} className={`ig__side ${c.halfStart ? "is-half" : ""}`} data-side={s === "T" ? "t" : "ct"} role="gridcell" aria-hidden />;
        })}
        <div className="ig__total ig__total--head" role="columnheader">{t === "us" ? <span className={firstSide === "T" ? "t-text" : "ct-text"}>{firstSide} first</span> : null}</div>
      </div>
    );
  };

  return (
    <div className="inspector card">
      <div className="ig" role="grid" aria-label="Round inspector: players by rounds" aria-rowcount={order.length + 3} aria-colcount={cols.length + 2} ref={grid} onKeyDown={onKey}>
        <div className="ig__row ig__row--head" role="row">
          <div className="ig__name ig__corner" role="columnheader"><span className="caps">Round</span></div>
          {cols.map((c, ci) => {
            if (c.kind === "totals") {
              return (
                <HoverCard key={`t${c.number}`} as="div" tabbable={false} prefer="bottom" className={`ig__head ${c.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""}`} card={() => <TotalsCardBody number={c.number} />}>
                  <button className="ig__headbtn" data-side="none" onClick={() => onOpen(ci)} aria-label={`Open round ${c.number}, totals only`} tabIndex={-1}>
                    <WinIcon how={null} size={12} />
                    <span className="num">{c.number}</span>
                  </button>
                </HoverCard>
              );
            }
            const r = c.r;
            const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
            return (
              <HoverCard key={r.ri} as="div" tabbable={false} prefer="bottom" className={`ig__head ${c.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""}`} card={() => <RoundCardBody v={v} r={r} />}>
                <button className="ig__headbtn" data-side={side} data-won={r.winner === "us"} onClick={() => onOpen(ci)} aria-label={`Open round ${r.number}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}, ${r.winner === "us" ? "won" : "lost"}`} tabIndex={-1}>
                  <WinIcon how={r.how} size={12} />
                  <span className="num">{r.number}</span>
                </button>
              </HoverCard>
            );
          })}
          <div className="ig__total ig__total--head" role="columnheader" data-tip="Swing per round over the match"><span className="caps">Swing</span></div>
        </div>
        {teamRow("us")}
        {us.map((p) => <PlayerRowView key={p.key} v={v} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} cols={cols} line={lines[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} opening={opening} />)}
        {teamRow("them")}
        {them.map((p) => <PlayerRowView key={p.key} v={v} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} cols={cols} line={lines[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} opening={opening} />)}
      </div>
    </div>
  );
}

function PlayerRowView({ v, pi, r, cells, cols, line, sel, focus, setFocus, onOpen, opening }: {
  v: MatchView; pi: number; r: number; cells: RoundCell[]; cols: RoundColumn[]; line: Line; sel: number | null; focus: { r: number; c: number };
  setFocus: (f: { r: number; c: number }) => void; onOpen: (c: number) => void; opening: (number | null)[];
}) {
  const p = v.players[pi];
  // the match's swing per valued round, as the hero and the scoreboard show it; the sum is in the tooltip
  const swing = statLine(line).swing;
  return (
    <div className={`ig__row ${p.isHuman ? "is-you" : ""}`} role="row">
      <div className="ig__name" role="rowheader">
        <span className={`ig__dot ${p.team}`} />
        <PlayerName v={v} pi={pi} />
        {p.isHuman && <small className="faint">You</small>}
      </div>
      {cols.map((col, ci) => {
        const at = focus.r === r && focus.c === ci;
        if (col.kind === "totals") {
          // the game's own totals for the round, when the file has them: kills (headshots marked) and a death
          const t = col.totals?.players.find((x) => x.pi === pi) ?? null;
          const counts = t ? `: ${t.kills} ${t.kills === 1 ? "kill" : "kills"}${t.hsKills ? `, ${t.hsKills} headshot` : ""}${t.deaths ? ", died" : ", survived"}` : "";
          const label = `${p.name}, round ${col.number}, totals only${counts}`;
          const skulls = t ? Array.from({ length: t.kills }, (_, i) => i < t.hsKills) : [];
          const shown = skulls.slice(0, 3);
          return (
            <div
              key={`t${col.number}`}
              role="gridcell"
              data-cell={`${r}-${ci}`}
              tabIndex={at ? 0 : -1}
              aria-label={label}
              aria-selected={sel === ci}
              className={`ig__cell is-lite ${col.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""}`}
              onClick={() => { setFocus({ r, c: ci }); onOpen(ci); }}
              onFocus={() => setFocus({ r, c: ci })}
              data-tip={label.replace(`${p.name}, `, "")}
            >
              {t && t.deaths > 0 && <DeathIcon size={10} className="ig__death" />}
              {shown.length > 0 && (
                <span className="ig__skulls">
                  {shown.map((hs, i) => <SkullIcon key={i} hs={hs} size={10} className={hs ? "skull skull--hs" : "skull"} />)}
                  {skulls.length > 3 && <span className="ig__more">+{skulls.length - 3}</span>}
                </span>
              )}
            </div>
          );
        }
        const c = cells[col.r.ri];
        const { items, overflow } = killSlots(c.kills, 3, 2);
        const tint = c.swing === null ? undefined : scoreTint(roundSwingScore(c.swing), 0.62);
        const side = c.side;
        const label = `${p.name}, round ${col.number} on ${side}: ${c.empty ? "no stats" : `${c.kills.length} ${c.kills.length === 1 ? "kill" : "kills"}${c.kills.some((k) => k.headshot) ? `, ${c.kills.filter((k) => k.headshot).length} headshot` : ""}${c.died ? ", died" : ", survived"}${c.swing !== null ? `, swing ${fmtSwing(c.swing)}` : ""}`}`;
        return (
          <div
            key={c.ri}
            role="gridcell"
            data-cell={`${r}-${ci}`}
            tabIndex={at ? 0 : -1}
            aria-label={label}
            aria-selected={sel === ci}
            className={`ig__cell ${col.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""} ${c.empty ? "is-empty" : ""} ${c.died ? "is-dead" : ""}`}
            style={tint ? { background: tint } : undefined}
            onClick={() => { setFocus({ r, c: ci }); onOpen(ci); }}
            onFocus={() => setFocus({ r, c: ci })}
            data-tip={c.empty ? undefined : label.replace(`${p.name}, `, "")}
          >
            {opening[c.ri] === pi && <FirstKillIcon size={9} className="ig__fk" />}
            {c.died && <DeathIcon size={10} className="ig__death" />}
            <span className="ig__skulls">
              {items.map((k, i) => <SkullIcon key={i} hs={k.headshot} size={10} className={k.headshot ? "skull skull--hs" : "skull"} />)}
              {overflow > 0 && <span className="ig__more">+{overflow}</span>}
            </span>
          </div>
        );
      })}
      <div className="ig__total num" style={{ color: swing === null ? "var(--ink3)" : scoreText(swingScore(swing)) }} data-tip={swingSumTip(line.m)}>{fmtSwing(swing)}</div>
    </div>
  );
}

