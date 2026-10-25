// Rounds: the round inspector and the round drawer. The inspector is a players × rounds grid,
// grouped by team: each cell shows the player's kills as skulls (a bullet hole marks a headshot),
// a cross for a death, a drop for the round's opening kill, and is tinted green to red by the
// player's swing that round. Arrow keys move between cells (no animation), Enter opens the round.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MatchView } from "../../../stats/derive";
import { HoverCard } from "../../components/overlay";
import { matchSwingTotal, playerSide, roundMatrix, type RoundCell } from "../../data/engine";
import { DeathIcon, FirstKillIcon, SkullIcon, WinIcon, WIN_LABEL } from "../../icons/game";
import { killSlots, moveIndex, startsHalf } from "../../lib/layout";
import { fmtSwing, plural } from "../../lib/format";
import { roundSwingScore, scoreText, scoreTint, swingScore } from "../../lib/scale";
import { setQuery } from "../../router";
import { PlayerName, RoundCardBody } from "../shared";
import type { TabProps } from "./MatchView";
import { RoundDrawer } from "./RoundDrawer";

export default function Rounds({ v, file, round }: TabProps) {
  const matrix = useMemo(() => roundMatrix(v), [v]);
  const open = (ri: number | null) => setQuery("round", ri === null ? null : String(ri + 1));
  const sel = round !== null && round >= 0 && round < v.nRounds ? round : null;

  // ← → step rounds while the drawer is open (no animation); Esc closes it.
  useEffect(() => {
    if (sel === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [role=grid], [role=listbox], [role=menu]")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); open(Math.max(0, sel - 1)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); open(Math.min(v.nRounds - 1, sel + 1)); }
      else if (e.key === "Escape") { e.preventDefault(); open(null); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sel, v.nRounds]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounds">
      <RoundDrawer v={v} ri={sel} onClose={() => open(null)} onStep={(d) => sel !== null && open(Math.max(0, Math.min(v.nRounds - 1, sel + d)))}>
        <Inspector v={v} matrix={matrix} sel={sel} onOpen={open} file={file} />
        <Legend v={v} />
      </RoundDrawer>
    </div>
  );
}

function Legend({ v }: { v: MatchView }) {
  const lite = v.rounds.filter((r) => !r.captured).length;
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

function Inspector({ v, matrix, sel, onOpen, file }: { v: MatchView; matrix: RoundCell[][]; sel: number | null; onOpen: (ri: number) => void; file: string }) {
  const max = v.env.maxrounds ?? 24;
  const us = v.players.filter((p) => p.team === "us").sort((a, b) => (a.isHuman ? -1 : b.isHuman ? 1 : b.rating - a.rating));
  const them = v.players.filter((p) => p.team === "them").sort((a, b) => b.rating - a.rating);
  const order = [...us, ...them];
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: sel ?? 0 });
  const grid = useRef<HTMLDivElement>(null);
  const opening = useMemo(() => v.rounds.map((r) => r.kills.find((k) => !k.teamKill && !k.suicide)?.killer ?? null), [v]);

  useEffect(() => { if (sel !== null) setFocus((f) => ({ ...f, c: sel })); }, [sel]);

  const onKey = (e: KeyboardEvent) => {
    const n = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
    let next = focus;
    if (n) next = { r: moveIndex(focus.r, n[0], order.length), c: moveIndex(focus.c, n[1], v.nRounds) };
    else if (e.key === "Home") next = { ...focus, c: 0 };
    else if (e.key === "End") next = { ...focus, c: v.nRounds - 1 };
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(focus.c); return; }
    else return;
    e.preventDefault();
    setFocus(next);
    grid.current?.querySelector<HTMLElement>(`[data-cell="${next.r}-${next.c}"]`)?.focus();
  };

  const teamRow = (t: "us" | "them") => {
    const firstSide = t === "us" ? v.usStartSide : ((5 - v.usStartSide) as 2 | 3);
    return (
      <div className="ig__row ig__row--team" role="row">
        <div className="ig__name ig__name--team" role="rowheader">
          <b>{t === "us" ? "Your team" : "Opponents"}</b>
          <span className="num cream">{t === "us" ? v.score.us : v.score.them}</span>
        </div>
        {v.rounds.map((r) => {
          const s = t === "us" ? r.usSide : ((5 - r.usSide) as 2 | 3);
          return <div key={r.ri} className={`ig__side ${startsHalf(r.ri, max) ? "is-half" : ""}`} data-side={s === 2 ? "t" : "ct"} role="gridcell" aria-hidden />;
        })}
        <div className="ig__total ig__total--head" role="columnheader">{t === "us" ? <span className={firstSide === 2 ? "t-text" : "ct-text"}>{firstSide === 2 ? "T" : "CT"} first</span> : null}</div>
      </div>
    );
  };

  return (
    <div className="inspector card">
      <div className="ig" role="grid" aria-label="Round inspector: players by rounds" aria-rowcount={order.length + 3} aria-colcount={v.nRounds + 2} ref={grid} onKeyDown={onKey}>
        <div className="ig__row ig__row--head" role="row">
          <div className="ig__name ig__corner" role="columnheader"><span className="caps">Round</span></div>
          {v.rounds.map((r) => {
            const side = r.winSide === 2 ? "t" : r.winSide === 3 ? "ct" : "none";
            return (
              <HoverCard key={r.ri} as="div" tabbable={false} prefer="bottom" className={`ig__head ${startsHalf(r.ri, max) ? "is-half" : ""} ${sel === r.ri ? "is-on" : ""}`} card={() => <RoundCardBody v={v} r={r} />}>
                <button className="ig__headbtn" data-side={side} data-won={r.winner === "us"} onClick={() => onOpen(r.ri)} aria-label={`Open round ${r.ri + 1}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}, ${r.winner === "us" ? "won" : "lost"}`} tabIndex={-1}>
                  <WinIcon how={r.how} size={12} />
                  <span className="num">{r.ri + 1}</span>
                </button>
              </HoverCard>
            );
          })}
          <div className="ig__total ig__total--head" role="columnheader"><span className="caps">Swing</span></div>
        </div>
        {teamRow("us")}
        {us.map((p) => <PlayerRowView key={p.key} v={v} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} opening={opening} max={max} file={file} />)}
        {teamRow("them")}
        {them.map((p) => <PlayerRowView key={p.key} v={v} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} opening={opening} max={max} file={file} />)}
      </div>
    </div>
  );
}

function PlayerRowView({ v, pi, r, cells, sel, focus, setFocus, onOpen, opening, max }: {
  v: MatchView; pi: number; r: number; cells: RoundCell[]; sel: number | null; focus: { r: number; c: number };
  setFocus: (f: { r: number; c: number }) => void; onOpen: (ri: number) => void; opening: (number | null)[]; max: number; file: string;
}) {
  const p = v.players[pi];
  const total = matchSwingTotal(v, pi);
  return (
    <div className={`ig__row ${p.isHuman ? "is-you" : ""}`} role="row">
      <div className="ig__name" role="rowheader">
        <span className={`ig__dot ${p.team}`} />
        <PlayerName v={v} pi={pi} />
        {p.isHuman && <small className="faint">You</small>}
      </div>
      {cells.map((c) => {
        const { items, overflow } = killSlots(c.kills, 3, 2);
        const tint = c.swing === null ? undefined : scoreTint(roundSwingScore(c.swing), 0.62);
        const side = playerSide(v, v.rounds[c.ri], pi) === 2 ? "T" : "CT";
        const label = `${p.name}, round ${c.ri + 1} on ${side}: ${c.empty ? "no stats" : `${c.kills.length} ${c.kills.length === 1 ? "kill" : "kills"}${c.kills.some((k) => k.hs) ? `, ${c.kills.filter((k) => k.hs).length} headshot` : ""}${c.died ? ", died" : ", survived"}${c.swing !== null ? `, swing ${fmtSwing(c.swing)}` : ""}`}`;
        return (
          <div
            key={c.ri}
            role="gridcell"
            data-cell={`${r}-${c.ri}`}
            tabIndex={focus.r === r && focus.c === c.ri ? 0 : -1}
            aria-label={label}
            aria-selected={sel === c.ri}
            className={`ig__cell ${startsHalf(c.ri, max) ? "is-half" : ""} ${sel === c.ri ? "is-on" : ""} ${c.lite ? "is-lite" : ""} ${c.empty ? "is-empty" : ""} ${c.died ? "is-dead" : ""}`}
            style={tint ? { background: tint } : undefined}
            onClick={() => { setFocus({ r, c: c.ri }); onOpen(c.ri); }}
            onFocus={() => setFocus({ r, c: c.ri })}
            data-tip={c.empty ? undefined : label.replace(`${p.name}, `, "")}
          >
            {opening[c.ri] === pi && <FirstKillIcon size={9} className="ig__fk" />}
            {c.died && <DeathIcon size={10} className="ig__death" />}
            <span className="ig__skulls">
              {items.map((k, i) => <SkullIcon key={i} hs={k.hs} size={10} className={k.hs ? "skull skull--hs" : "skull"} />)}
              {overflow > 0 && <span className="ig__more">+{overflow}</span>}
            </span>
          </div>
        );
      })}
      <div className="ig__total num" style={{ color: total === null ? "var(--ink3)" : scoreText(swingScore(total / Math.max(1, v.nRounds))) }}>{total === null ? "–" : fmtSwing(total)}</div>
    </div>
  );
}

