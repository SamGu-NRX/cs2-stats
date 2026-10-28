// Rounds: the round inspector and the round drawer. The inspector is a players × rounds grid,
// grouped by team, one question per mark: kills as a number, a death as one cross, and how the round
// ended as the official icon in the winning side's colour in the header. Halves are split by a gap.
// The grid scrolls sideways (an edge fade and a chevron show more rounds) and keeps the open round's
// column in view when the drawer narrows it. Arrow keys move between cells, Enter opens the round.
// Columns come from roundColumns(): a round the file holds only as totals (MatchInfo.totalsOnly) is a
// hatched column with the game's recorded kills and death per player, and dashes where it holds none.
// Under the grid, your rating round by round (RatingByRound); the drawer reads the same breakdown.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useCall } from "../../data/hooks";
import { HoverCard } from "../../components/overlay";
import { roundColumns, roundMatrix, selectedColumn, teamLabel, type MatchModel as MatchView, type RoundCell, type RoundColumn } from "../../data/match";
import { statLine } from "../../data/engine";
import { WIN_LABEL, WinIcon } from "../../icons/game";
import { DeathMark } from "../../components/bits";
import { ChevronLeftIcon, ChevronRightIcon } from "../../icons/ui";
import { moveIndex } from "../../lib/layout";
import { fmtSwing } from "../../lib/format";
import { scoreText, swingScore } from "../../lib/scale";
import { setQuery, useRoute } from "../../router";
import { PlayerName, RoundCardBody, swingSumTip, TotalsCardBody, YouTag } from "../shared";
import type { Line } from "../../../worker/protocol";
import type { TabProps } from "./MatchView";
import { RatingByRound } from "./RatingByRound";
import { RoundDrawer } from "./RoundDrawer";
import { Viewed } from "./Viewer";

export default function Rounds({ v, file, round }: TabProps) {
  const rating = useCall("ratingBreakdown", v.human === null ? null : [file, v.players[v.human].key, null]);
  const rb = rating.data;
  const matrix = useMemo(() => roundMatrix(v), [v]);
  const cols = useMemo(() => roundColumns(v), [v]);
  const n = cols.length;
  // the match view finds no row for a totals-only round number, so its column comes from the URL
  const q = useRoute().query.get("round");
  const sel = selectedColumn(cols, round !== null && round >= 0 && round < v.nRounds ? round : null, q ? Number(q) : null);
  const open = (c: number | null) => setQuery("round", c === null ? null : String(cols[c].number));

  // ← → step rounds while the drawer is open (no animation); Esc closes it.
  useEffect(() => {
    if (sel === null) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, [role=grid], [role=listbox], [role=menu]")) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); open(Math.max(0, sel - 1)); }
      else if (e.key === "ArrowRight") { e.preventDefault(); open(Math.min(n - 1, sel + 1)); }
      else if (e.key === "Escape") { e.preventDefault(); open(null); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sel, n]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="rounds">
      <RoundDrawer v={v} cols={cols} col={sel} rb={rb} rbError={rating.error} onClose={() => open(null)} onStep={(d) => sel !== null && open(Math.max(0, Math.min(n - 1, sel + d)))}>
        <Inspector v={v} cols={cols} matrix={matrix} sel={sel} onOpen={open} />
        <Legend />
        <Viewed v={v} what="their rating round by round" pad={false}>{(w) => <RatingByRound v={w} file={file} rb={rb} error={rating.error} selected={sel === null ? null : cols[sel].number} />}</Viewed>
      </RoundDrawer>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend inspector__legend">
      <span><b className="num">2</b> Kills</span>
      <span><DeathMark className="ig__death" /> Died</span>
      {(["elim", "bomb", "defuse", "time"] as const).map((h) => <span key={h}><WinIcon how={h} size={13} beside /> {WIN_LABEL[h]}</span>)}
    </div>
  );
}

/** Space kept clear of the edge fades when a column is brought into view. */
const EDGE = 44;

function Inspector({ v, cols, matrix, sel, onOpen }: { v: MatchView; cols: RoundColumn[]; matrix: RoundCell[][]; sel: number | null; onOpen: (c: number) => void }) {
  const nCols = cols.length;
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
    const first = s?.querySelector<HTMLElement>('[data-col="0"]'), last = s?.querySelector<HTMLElement>(`[data-col="${nCols - 1}"]`);
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
  }, [nCols]);
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
    if (ri === nCols - 1) s.scrollLeft = s.scrollWidth;
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
    if (n) next = { r: moveIndex(focus.r, n[0], order.length), c: moveIndex(focus.c, n[1], nCols) };
    else if (e.key === "Home") next = { ...focus, c: 0 };
    else if (e.key === "End") next = { ...focus, c: nCols - 1 };
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
          <b>{teamLabel(v, t)}</b>
          <span className={`ig__first ${firstSide === "T" ? "t-text" : "ct-text"}`}>{firstSide} first</span>
          <span className="num cream">{t === "us" ? v.entry.score.us : v.entry.score.them}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="inspector card" data-left={edges.left || undefined} data-right={edges.right || undefined}>
      <div className="inspector__scroll" ref={scroller}>
        <div className="ig" role="grid" aria-label="Round inspector: players by rounds" aria-rowcount={order.length + 3} aria-colcount={nCols + 2} onKeyDown={onKey}>
          <div className="ig__row ig__row--head" role="row">
            <div className="ig__name ig__corner" role="columnheader"><span className="caps">Round</span></div>
            {cols.map((c, ci) => {
              if (c.kind === "totals") {
                return (
                  <HoverCard key={`t${c.number}`} as="div" tabbable={false} prefer="bottom" className={`ig__head is-lite ${c.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""}`} card={() => <TotalsCardBody v={v} col={c} />}>
                    <span className="ig__headbtn" role="columnheader" data-col={ci} data-side="none" onClick={() => onOpen(ci)} aria-label={`Round ${c.number}, totals only`}>
                      <span className="num">{c.number}</span>
                    </span>
                  </HoverCard>
                );
              }
              const r = c.r;
              const side = r.winSide === "T" ? "t" : r.winSide === "CT" ? "ct" : "none";
              return (
                <HoverCard key={r.ri} as="div" tabbable={false} prefer="bottom" className={`ig__head ${c.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""}`} card={() => <RoundCardBody v={v} r={r} />}>
                  <span className="ig__headbtn" role="columnheader" data-col={ci} data-side={side} data-won={r.winner === "us"} onClick={() => onOpen(ci)} aria-label={`Round ${r.number}${r.how ? `, ${WIN_LABEL[r.how]}` : ""}, ${r.winner === "us" ? "won" : "lost"}`}>
                    <WinIcon how={r.how} size={14} compact />
                    <span className="num">{r.number}</span>
                  </span>
                </HoverCard>
              );
            })}
            <div className="ig__total ig__total--head" role="columnheader" data-tip="Swing per round over the match" tabIndex={0}><span className="caps">Swing</span></div>
          </div>
          {teamRow("us")}
          {us.map((p) => <PlayerRowView key={p.key} v={v} cols={cols} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} line={lines[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} />)}
          {teamRow("them")}
          {them.map((p) => <PlayerRowView key={p.key} v={v} cols={cols} pi={p.pi} r={order.indexOf(p)} cells={matrix[p.pi]} line={lines[p.pi]} sel={sel} focus={focus} setFocus={setFocus} onOpen={onOpen} />)}
        </div>
      </div>
      {/* pointer shortcuts only: from the keyboard, the grid's arrow keys bring every round into view */}
      <button className="inspector__more inspector__more--l" tabIndex={-1} aria-hidden onClick={() => page(-1)}><ChevronLeftIcon size={16} /></button>
      <button className="inspector__more inspector__more--r" tabIndex={-1} aria-hidden onClick={() => page(1)}><ChevronRightIcon size={16} /></button>
    </div>
  );
}

function PlayerRowView({ v, cols, pi, r, cells, line, sel, focus, setFocus, onOpen }: {
  v: MatchView; cols: RoundColumn[]; pi: number; r: number; cells: RoundCell[]; line: Line; sel: number | null; focus: { r: number; c: number };
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
        <YouTag v={v} pi={pi} className="faint" />
      </div>
      {cols.map((col, ci) => {
        const at = focus.r === r && focus.c === ci;
        if (col.kind === "totals") {
          // the game's own totals for the round; a dash where the file holds none for this player
          const t = col.totals?.players.find((x) => x.pi === pi) ?? null;
          const what = t ? `${t.kills} ${t.kills === 1 ? "kill" : "kills"}${t.hsKills ? ` (${t.hsKills} HS)` : ""}, ${t.deaths ? "died" : "survived"}, swing –` : "no totals recorded";
          const label = `Round ${col.number}, totals only: ${what}`;
          return (
            <div
              key={`t${col.number}`}
              role="gridcell"
              data-cell={`${r}-${ci}`}
              tabIndex={at ? 0 : -1}
              aria-label={`${p.name}, ${label}`}
              aria-selected={sel === ci}
              className={`ig__cell is-lite ${col.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""}`}
              onClick={() => { setFocus({ r, c: ci }); onOpen(ci); }}
              onFocus={() => setFocus({ r, c: ci })}
              data-tip={label}
            >
              {t ? (
                <>
                  {t.kills > 0 && <b className="ig__k num">{t.kills}</b>}
                  {t.deaths > 0 && <DeathMark className="ig__death" />}
                </>
              ) : <span className="faint">–</span>}
            </div>
          );
        }
        const c = cells[col.r.ri];
        const r0 = col.r;
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
            data-cell={`${r}-${ci}`}
            tabIndex={at ? 0 : -1}
            aria-label={`${p.name}, ${label}`}
            aria-selected={sel === ci}
            className={`ig__cell ${col.halfStart ? "is-half" : ""} ${sel === ci ? "is-on" : ""} ${c.empty ? "is-empty" : ""}`}
            onClick={() => { setFocus({ r, c: ci }); onOpen(ci); }}
            onFocus={() => setFocus({ r, c: ci })}
            data-tip={c.empty ? undefined : label}
          >
            {c.kills.length > 0 && <b className="ig__k num">{c.kills.length}</b>}
            {c.died && <DeathMark className="ig__death" />}
          </div>
        );
      })}
      <div className="ig__total num" style={{ color: swing === null ? "var(--ink3)" : scoreText(swingScore(swing)) }} data-tip={swingSumTip(line.m)} tabIndex={0}>{fmtSwing(swing)}</div>
    </div>
  );
}
