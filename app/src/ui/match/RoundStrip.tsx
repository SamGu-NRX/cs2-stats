// The match as a strip of rounds: your team's wins on top, the opponents' below, and between them
// your team's chance to win each round, redrawn after every kill. The lane is where the round swing
// comes from, so it is the one place the app spends its visual boldness.
import { useState, type KeyboardEvent } from "react";
import type { MatchView, RoundView } from "../../stats/derive";
import { HOW_TEXT, HowIcon } from "../icons";
import { swingPct } from "../format";
import { ModelBadge } from "../ModelBadge";

/** Our win chance over a round: [x 0..1 by time, p] steps, ending at the result. */
function lanePoints(r: RoundView): [number, number][] | null {
  if (!r.captured) return null;
  const us = (p: number) => (r.usSide === 3 ? p : 1 - p);
  const ks = r.kills.filter((k) => k.ctWinBefore !== null && k.ctWinAfter !== null);
  const dur = r.durSecs ?? Math.max(1, ...r.kills.map((k) => k.secs ?? 0));
  const pts: [number, number][] = [[0, ks.length ? us(ks[0].ctWinBefore!) : 0.5]];
  for (const k of ks) {
    const x = Math.min(0.94, Math.max(0.04, (k.secs ?? 0) / dur));
    pts.push([x, pts[pts.length - 1][1]], [x, us(k.ctWinAfter!)]);
  }
  pts.push([0.97, pts[pts.length - 1][1]], [1, r.winner === "us" ? 1 : 0]);
  return pts;
}

function Lane({ r }: { r: RoundView }) {
  const pts = lanePoints(r);
  if (!pts) return <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden><line x1="0" x2="100" y1="50" y2="50" stroke="rgba(60,60,67,.18)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" /></svg>;
  const P = pts.map(([x, p]) => `${(x * 100).toFixed(1)},${(100 - p * 100).toFixed(1)}`);
  const line = `M${P.join("L")}`;
  const area = `M0,50L${P.join("L")}L100,50Z`;
  const id = `clip-${r.ri}`;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      <defs>
        <clipPath id={`${id}-up`}><rect x="0" y="0" width="100" height="50" /></clipPath>
        <clipPath id={`${id}-dn`}><rect x="0" y="50" width="100" height="50" /></clipPath>
      </defs>
      <line x1="0" x2="100" y1="50" y2="50" stroke="rgba(60,60,67,.16)" vectorEffect="non-scaling-stroke" />
      <path d={area} fill="rgba(0,122,255,.18)" clipPath={`url(#${id}-up)`} />
      <path d={area} fill="rgba(60,60,67,.12)" clipPath={`url(#${id}-dn)`} />
      <path d={line} fill="none" stroke={r.winner === "us" ? "var(--c-blue)" : "rgba(60,60,67,.55)"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function tipFor(v: MatchView, r: RoundView): string {
  const sw = r.captured ? ` · Your swing ${swingPct(r.swing[v.human])}` : " · Not captured";
  if (r.winner === null || r.how === null) return `Round ${r.ri + 1} · Result unknown${sw}`;
  const who = r.winner === "us" ? "Your team won" : "Opponents won";
  const left = r.left !== null ? `, ${r.left} left` : "";
  return `Round ${r.ri + 1} · ${who} by ${HOW_TEXT[r.how]}${left}${sw}`;
}

export function RoundStrip({ v, onRound }: { v: MatchView; onRound?: (ri: number) => void }) {
  const half = (v.env.maxrounds ?? 24) / 2;
  const cols = Math.max(v.nRounds, half * 2);
  const cells = Array.from({ length: cols }, (_, i) => v.rounds[i] ?? null);
  const firstSide = v.usStartSide === 3 ? "CT" : "T";
  const secondSide = firstSide === "CT" ? "T" : "CT";
  const gap = (i: number) => (i === half || (i > half * 2 && (i - half * 2) % 3 === 0) ? " is-gap" : "");
  // One tab stop for the whole strip; arrow keys walk the rounds in played order across both rows.
  const [active, setActive] = useState(0);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(v.nRounds - 1, step === -Infinity ? 0 : step === Infinity ? v.nRounds - 1 : active + step));
    setActive(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-ri="${next}"]`)?.focus();
  };

  const row = (team: "us" | "them") =>
    cells.map((r, i) => {
      if (!r) return <div key={i} className={`strip__cell${gap(i)}`}><span className="strip__empty" /></div>;
      if (r.winner === null && team === "us") {
        return (
          <div key={i} className={`strip__cell${gap(i)}`}>
            <button className="strip__btn" data-ri={r.ri} tabIndex={r.ri === active ? 0 : -1} data-tip={tipFor(v, r)} aria-label={tipFor(v, r)}
              onFocus={() => setActive(r.ri)} onClick={() => onRound?.(r.ri)}>
              <span className="strip__unknown">?</span>
            </button>
          </div>
        );
      }
      if (r.winner !== team || r.how === null) return <div key={i} className={`strip__cell${gap(i)}`}><span className="strip__lose" /></div>;
      const side = r.winSide === 3 ? "ct" : "t";
      return (
        <div key={i} className={`strip__cell${gap(i)}`}>
          <button className="strip__btn" data-ri={r.ri} tabIndex={r.ri === active ? 0 : -1} data-tip={tipFor(v, r)} aria-label={tipFor(v, r)}
            onFocus={() => setActive(r.ri)} onClick={() => onRound?.(r.ri)}>
            <span className={`strip__win strip__win--${side}`}>
              <HowIcon how={r.how} size={11} />
              {r.left !== null && <small>{r.left}</small>}
            </span>
          </button>
        </div>
      );
    });

  return (
    <div>
      <div className="strip-scroll">
      <div className="strip" role="group" aria-label="Round history. Use the arrow keys to move between rounds; Enter opens the round." onKeyDown={onKey}>
        <div className="strip__label">Your team<small>{firstSide} → {secondSide}</small></div>
        <div className="strip__rounds">{row("us")}</div>
        <div className="strip__label has-tip" tabIndex={0} data-tip={`Your team's chance to win the round, after each kill. ${v.model.kind === "stub" ? "From the alive-count stub until the trained model is added." : "From the trained win-probability model."}`}>
          Win chance<small>after each kill</small>
        </div>
        <div className="strip__rounds">
          {cells.map((r, i) => <div key={i} className={`strip__lane${gap(i)}`}>{r ? <Lane r={r} /> : null}</div>)}
        </div>
        <div className="strip__label">Opponents<small>{secondSide} → {firstSide}</small></div>
        <div className="strip__rounds">{row("them")}</div>
      </div>
      </div>
      <div className="strip__legend">
        <ModelBadge />
        <span><HowIcon how="elim" /> Elimination</span>
        <span><HowIcon how="bomb" /> Bomb exploded</span>
        <span><HowIcon how="defuse" /> Defused</span>
        <span><HowIcon how="time" /> Time ran out</span>
        <span><i className="side side--ct">CT</i><i className="side side--t">T</i> Side that won · number = players left</span>
      </div>
    </div>
  );
}
