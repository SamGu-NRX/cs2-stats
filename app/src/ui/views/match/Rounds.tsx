// Rounds: the round inspector and the round drawer. The inspector is a players × rounds grid,
// grouped by team, one question per mark: kills as a number, a death as one cross, and how the round
// ended as the official icon in the winning side's colour in the header. Halves are split by a gap.
// The grid scrolls sideways (an edge fade and a chevron show more rounds) and keeps the open round's
// column in view when the drawer narrows it. Arrow keys move between cells, Enter opens the round.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HoverCard } from "../../components/overlay";
import { roundMatrix, type MatchModel as MatchView, type RoundCell } from "../../data/match";
import { statLine } from "../../data/engine";
import { DeathIcon, WIN_LABEL } from "../../icons/game";
import { ChevronLeftIcon, ChevronRightIcon } from "../../icons/ui";
import { moveIndex } from "../../lib/layout";
import { fmtSwing } from "../../lib/format";
import { scoreText, swingScore } from "../../lib/scale";
import { setQuery } from "../../router";
import { PlayerName, RoundCardBody, swingSumTip } from "../shared";
import type { Line } from "../../../worker/protocol";
import { RoundEndIcon } from "./glyphs";
import type { TabProps } from "./MatchView";
import { RoundDrawer } from "./RoundDrawer";

export default function Rounds({ v, round }: TabProps) {
  const matrix = useMemo(() => roundMatrix(v), [v]);
  const open = (ri: number | null) => setQuery("round", ri === null ? null : String(v.rounds[ri].number));
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
        <Inspector v={v} matrix={matrix} sel={sel} onOpen={open} />
        <Legend />
      </RoundDrawer>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend inspector__legend">
      <span><b className="num">2</b> Kills</span>
      <span><DeathIcon size={11} className="ig__death" /> Died</span>
      {(["elim", "bomb", "defuse", "time"] as const).map((h) => <span key={h}><RoundEndIcon how={h} size={13} /> {WIN_LABEL[h]}</span>)}
    </div>
  );
}

/** Space kept clear of the edge fades when a column is brought into view. */
const EDGE = 44;

function Inspector({ v, matrix, sel, onOpen }: { v: MatchView; matrix: RoundCell[][]; sel: number | null; onOpen: (ri: number) => void }) {
  const lines = v.b.lines.both;
  const rating = (pi: number) => lines[pi].rating ?? 0;
  const us = v.players.filter((p) => p.team === "us").sort((a, b) => (a.isHuman ? -1 : b.isHuman ? 1 : rating(b.pi) - rating(a.pi)));
  const them = v.players.filter((p) => p.team === "them").sort((a, b) => rating(b.pi) - rating(a.pi));
  const order = [...us, ...them];
  const [focus, setFocus] = useState<{ r: number; c: number }>({ r: 0, c: sel ?? 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const selRef = useRef(sel);
  selRef.current = sel;

  // The edge fades follow two observers on the first and last round columns, so scrolling never reads
  // layout; state changes only when an edge's visibility flips.
  useEffect(() => {
    const s = scroller.current;
    const first = s?.querySelector<HTMLElement>('[data-col="0"]'), last = s?.querySelector<HTMLElement>(`[data-col="${v.nRounds - 1}"]`);
    const frozen = s?.querySelector<HTMLElement>(".ig__corner");
    if (!s || !first || !last || !frozen) return;
    const io = new IntersectionObserver((entries) => {
      setEdges((e) => {
        let next = e;
        for (const en of entries) {
          const hidden = en.intersectionRatio < 0.99;
          if (en.target === first && hidden !== e.left) next = { ...next, left: hidden };
          if (en.target === last && hidden !== e.right) next = { ...next, right: hidden };
        }
        return next;
      });
    }, { root: s, rootMargin: `0px 0px 0px -${frozen.offsetWidth}px`, threshold: [0.99] });
    io.observe(first);
    io.observe(last);
    return () => io.disconnect();
  }, [v.nRounds]);
  // Brings a round's column between the frozen name column and the right edge, instantly; at the
  // ends it scrolls all the way, so no fade covers the first or last round.
  const reveal = (ri: number | null) => {
    const s = scroller.current;
    const col = ri === null ? null : s?.querySelector<HTMLElement>(`[data-col="${ri}"]`);
    const frozen = s?.querySelector<HTMLElement>(".ig__corner");
    if (!s || !col || !frozen) return;
    const box = s.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    const left = frozen.getBoundingClientRect().right - box.left;
    const x = c.left - box.left;
    if (x < left + EDGE) s.scrollLeft -= left + EDGE - x;
    else if (x + c.width > s.clientWidth - EDGE) s.scrollLeft += x + c.width - (s.clientWidth - EDGE);
    if (ri === 0) s.scrollLeft = 0;
    if (ri === v.nRounds - 1) s.scrollLeft = s.scrollWidth;
  };
  useLayoutEffect(() => {
    const s = scroller.current;
    if (!s) return;
    // the drawer's arrival narrows the grid after its open animation: keep the open round in view
    const ro = new ResizeObserver(() => reveal(selRef.current));
    ro.observe(s);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sel === null) return;
    setFocus((f) => ({ ...f, c: sel }));
    reveal(sel);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const page = (dir: 1 | -1) => scroller.current?.scrollBy({ left: dir * 8 * 34, behavior: "instant" as ScrollBehavior });

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
    const cell = scroller.current?.querySelector<HTMLElement>(`[data-cell="${next.r}-${next.c}"]`);
    cell?.focus({ preventScroll: true });
    // the row into view vertically (the page scrolls, instantly), the column horizontally
    cell?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" as ScrollBehavior });
    reveal(next.c);
  };

  const teamRow = (t: "us" | "them") => {
    const firstSide = t === "us" ? v.usStartSide : v.usStartSide === "T" ? "CT" : "T";
    return (
      <div className="ig__row ig__row--team" role="row">
        <div className="ig__name ig__name--team" role="rowheader">
          <b>{t === "us" ? "Your team" : "Opponents"}</b>
          <span className={`ig__first ${firstSide === "T" ? "t-text" : "ct-text"}`}>{firstSide} first</span>
          <span className="num cream">{t === "us" ? v.entry.score.us : v.entry.score.them}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="inspector card" data-left={edges.left || undefined} data-right={edges.right || undefined}>
      <div className="inspector__scroll" ref={scroller}>
        <div className="ig" role="grid" aria-label="Round inspector: players by rounds" aria-rowcount={order.length + 3} aria-colcount={v.nRounds + 2} onKeyDown={onKey}>
          <div className="ig__row ig__row--head" role="row">
            <div className="ig__name ig__corner" role="columnheader"><span className="caps">Round</span></div>
            {v.rounds.map((r) => {
              const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
              return (
                <HoverCard key={r.ri} as="div" tabbable={false} prefer="bottom" className={`ig__head ${r.halfStart ? "is-half" : ""} ${sel === r.ri ? "is-on" : ""}`} card={() => <RoundCardBody v={v} r={r} />}>
                  <button className="ig__headbtn" data-col={r.ri} data-side={side} data-won={r.winner === "us"} onClick={() => onOpen(r.ri)} aria-label={`Open round ${r.number}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}, ${r.winner === "us" ? "won" : "lost"}`} tabIndex={-1}>
                    <RoundEndIcon how={r.how} size={14} />
                    <span className="num">{r.number}</span>
                  </button>
                </HoverCard>
              );
            })}
            <div className="ig__total ig__total--head" role="columnheader" data-tip="Swing per round over the match"><span className="caps">Swing</span></div>
          </div>
          {teamRow("us")}
          {us.map((p) => <PlayerRowView key={p.key} v={v} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} line={lines[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} />)}
          {teamRow("them")}
          {them.map((p) => <PlayerRowView key={p.key} v={v} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} line={lines[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} />)}
        </div>
      </div>
      <button className="inspector__more inspector__more--l" tabIndex={-1} aria-label="Previous rounds" onClick={() => page(-1)}><ChevronLeftIcon size={16} /></button>
      <button className="inspector__more inspector__more--r" tabIndex={-1} aria-label="Next rounds" onClick={() => page(1)}><ChevronRightIcon size={16} /></button>
    </div>
  );
}

function PlayerRowView({ v, pi, r, cells, line, sel, focus, setFocus, onOpen }: {
  v: MatchView; pi: number; r: number; cells: RoundCell[]; line: Line; sel: number | null; focus: { r: number; c: number };
  setFocus: (f: { r: number; c: number }) => void; onOpen: (ri: number) => void;
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
      {cells.map((c) => {
        const r0 = v.rounds[c.ri];
        const hs = c.kills.filter((k) => k.headshot).length;
        const opened = r0.kills.find((k) => k.opening)?.killer === pi;
        const what = c.empty ? "no stats" : [
          `${c.kills.length} ${c.kills.length === 1 ? "kill" : "kills"}${hs ? ` (${hs} HS)` : ""}`,
          opened ? "opening kill" : null, c.died ? "died" : "survived", c.swing !== null ? `swing ${fmtSwing(c.swing)}` : null,
        ].filter(Boolean).join(", ");
        const label = `Round ${r0.number} on ${c.side}: ${what}`;
        return (
          <div
            key={c.ri}
            role="gridcell"
            data-cell={`${r}-${c.ri}`}
            tabIndex={focus.r === r && focus.c === c.ri ? 0 : -1}
            aria-label={`${p.name}, ${label}`}
            aria-selected={sel === c.ri}
            className={`ig__cell ${r0.halfStart ? "is-half" : ""} ${sel === c.ri ? "is-on" : ""} ${c.empty ? "is-empty" : ""}`}
            onClick={() => { setFocus({ r, c: c.ri }); onOpen(c.ri); }}
            onFocus={() => setFocus({ r, c: c.ri })}
            data-tip={c.empty ? undefined : label}
          >
            {c.kills.length > 0 && <b className="ig__k num">{c.kills.length}</b>}
            {c.died && <DeathIcon size={10} className="ig__death" />}
          </div>
        );
      })}
      <div className="ig__total num" style={{ color: swing === null ? "var(--ink3)" : scoreText(swingScore(swing)) }} data-tip={swingSumTip(line.m)}>{fmtSwing(swing)}</div>
    </div>
  );
}
