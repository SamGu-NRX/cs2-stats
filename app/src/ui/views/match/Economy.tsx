// Economy: team equipment per round (with the bank left after buying), HLTV's buy classes (pistol,
// eco, half, full), saves, and how each buy converted. Reads the worker's economy view (economyOf).
import { useRef, useState, type KeyboardEvent } from "react";
import { ECO_BELOW_PER_PLAYER, FULL_FROM_PER_PLAYER, type BuyClass, type EconRound } from "../../../stats/economy";
import { Card } from "../../components/Card";
import { useWidth } from "../../components/charts";
import { rovingIndex } from "../../components/controls";
import { HoverCard } from "../../components/overlay";
import { BUY_CLASSES, BUY_CLASS_LABEL } from "../../data/engine";
import type { MatchModel as MatchView } from "../../data/match";
import { BuyIcon } from "../../icons/game";
import { fmtMoney, fmtMoneyShort, fmtPct, plural } from "../../lib/format";
import { roundColumns } from "../../lib/layout";
import { scoreText, scoreTint, toScore } from "../../lib/scale";
import { go, matchHref } from "../../router";
import { RoundCardBody, SectionAside } from "../shared";
import { Hint } from "./glyphs";
import type { TabProps } from "./MatchView";

const BUY_DEF: Record<BuyClass, string> = {
  pistol: "First round of each half.",
  eco: `Under ${fmtMoney(ECO_BELOW_PER_PLAYER)} of team equipment per player.`,
  half: "Between eco and a full buy.",
  full: `${fmtMoney(FULL_FROM_PER_PLAYER)} or more of team equipment per player.`,
};

/** One team's round in words, for the chart column's tooltip. */
const teamRound = (who: string, t: EconRound["us"]) =>
  `${who}: ${t.buy ? BUY_CLASS_LABEL[t.buy].toLowerCase() : "buy unknown"}, ${fmtMoney(t.equip)} equipment, ${fmtMoney(t.spent)} spent, ${fmtMoney(t.money)} left${t.saves ? `, ${plural(t.saves, "save")}` : ""}`;

/** A round column in words: its tooltip, its accessible name and the line under the chart while it has focus. */
const roundWords = (r: EconRound) =>
  `Round ${r.number}, ${r.winner === "us" ? "won" : r.winner === "them" ? "lost" : "winner not recorded"}. ${teamRound("You", r.us)}. ${teamRound("Them", r.them)}.`;

export default function Economy({ v, file }: TabProps) {
  const e = v.b.economy;
  return (
    <div className="tabpad economy">
      <Card title="Equipment per round" aside={<><SectionAside label="Your average" value={fmtMoneyShort(e.avgEquip.us)} color="var(--cream)" /><SectionAside label="Theirs" value={fmtMoneyShort(e.avgEquip.them)} /></>}>
        <EquipChart v={v} file={file} />
      </Card>
      <div className="grid-3">
        <Card title={<>Win rate by buy <Hint tip="The tick is the opponents' rate on the same buy." /></>} aside={e.unknown ? <span className="meta">{plural(e.unknown, "round")} unclassified</span> : undefined}>
          <BuyRates v={v} />
        </Card>
        <Card title="Your buy against theirs" aside={<span className="meta">Won / played</span>}>
          <BuyMatrix v={v} />
        </Card>
        <Card title="Saves" aside={<span className="meta">Lost rounds, alive at the end</span>}>
          <dl className="facts">
            <dt>Your team</dt><dd><b className="num">{e.saves.us.players}</b><span className="meta">players, {fmtMoney(e.saves.us.equip)} of equipment kept</span></dd>
            <dt>Opponents</dt><dd><b className="num">{e.saves.them.players}</b><span className="meta">players, {fmtMoney(e.saves.them.equip)} of equipment kept</span></dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function EquipChart({ v, file }: { v: MatchView; file: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const e = v.b.economy;
  const max = v.maxRounds;
  const H = 240;
  const top = 18;
  const bottom = 26;
  const left = 44;
  const ih = H - top - bottom;
  const n = e.rounds.length;
  const gap = 4;
  const halfGap = 14;
  // A round's target is its cell plus the gap, at least 24 px wide (WCAG 2.5.8); past that the chart scrolls.
  const cell = Math.max(24 - gap, Math.min(40, (w - left - 8 - (n - 1) * gap - halfGap * 2) / Math.max(1, n)));
  // half-time and overtime gaps fall by round number, not by position in the file
  const { cols, width } = roundColumns(e.rounds.map((r) => r.number), max, cell, gap, halfGap);
  const vmax = Math.max(10000, ...e.rounds.flatMap((r) => [r.us.equip ?? 0, r.them.equip ?? 0, r.us.money ?? 0, r.them.money ?? 0]));
  const step = vmax > 30000 ? 10000 : 5000;
  const ticks: number[] = [];
  for (let t = 0; t <= vmax; t += step) ticks.push(t);
  const Y = (x: number) => top + ih - (x / vmax) * ih;
  const bw = (cell - 2) / 2;
  const bank = (t: "us" | "them") => cols.map((c) => { const m = e.rounds[c.ri][t].money; return m === null ? null : `${left + c.x + (t === "us" ? bw / 2 : bw + 2 + bw / 2)},${Y(m)}`; }).filter(Boolean).join(" ");
  const peak = e.rounds.reduce((b, r) => ((r.us.equip ?? 0) > (b?.us.equip ?? -1) ? r : b), e.rounds[0]);
  // The columns are one tab stop: arrows move between rounds, Enter opens the focused one in Rounds.
  const svg = useRef<SVGSVGElement>(null);
  const [stop, setStop] = useState(0);
  const [focused, setFocused] = useState<number | null>(null);
  const open = (n: number) => go(matchHref(file, "rounds", { round: n }));
  const onKey = (ev: KeyboardEvent, j: number) => {
    if (ev.key === "Enter") { ev.preventDefault(); open(e.rounds[cols[j].ri].number); return; }
    const to = rovingIndex(ev.key, j, cols.length, false);
    if (to === null) return;
    ev.preventDefault();
    setStop(to);
    svg.current?.querySelector<SVGGElement>(`[data-j="${to}"]`)?.focus();
  };
  return (
    <div ref={ref} className="chart echart">
      <svg ref={svg} width={Math.max(w, left + width + 8)} height={H} role="group" aria-label="Equipment per round. Each round opens in the Rounds tab; arrow keys move between rounds.">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={left + width} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
            <text x={left - 6} y={Y(t) + 4} textAnchor="end" className="ax">{t === 0 ? "$0" : `$${t / 1000}k`}</text>
          </g>
        ))}
        {cols.filter((c) => c.gapBefore).map((c) => (
          <g key={`h${c.ri}`}>
            <line x1={left + c.x - halfGap / 2 - gap / 2} x2={left + c.x - halfGap / 2 - gap / 2} y1={top - 10} y2={top + ih} stroke="var(--line2)" strokeDasharray="2 3" />
            <text x={left + c.x - halfGap / 2 - gap / 2} y={top - 10} textAnchor="middle" className="ax">{c.half === 1 ? "Half" : "OT"}</text>
          </g>
        ))}
        {cols.map((c, j) => {
          const r = e.rounds[c.ri];
          const usFill = r.us.side === "T" ? "var(--t)" : "var(--ct)";
          const themFill = r.us.side === "T" ? "var(--ct)" : "var(--t)";
          const x = left + c.x;
          const won = r.winner === "us";
          return (
            <g key={c.ri} data-j={j} className="echart__col" role="link" tabIndex={j === Math.min(stop, cols.length - 1) ? 0 : -1} aria-label={roundWords(r)}
              onClick={() => open(r.number)} onKeyDown={(ev) => onKey(ev, j)} onFocus={() => { setStop(j); setFocused(c.ri); }} onBlur={() => setFocused(null)}>
              <title>{roundWords(r)}</title>
              <rect x={x - gap / 2} y={top} width={cell + gap} height={ih + bottom} fill="transparent" />
              <rect className="echart__ring" x={x - gap / 2 + 1} y={top - 9} width={cell + gap - 2} height={ih + bottom + 8} rx="4" />
              {r.us.equip !== null && <rect x={x} y={Y(r.us.equip)} width={bw} height={Math.max(1, top + ih - Y(r.us.equip))} rx="1.5" fill={usFill} opacity={won ? 1 : 0.5} />}
              {r.them.equip !== null && <rect x={x + bw + 2} y={Y(r.them.equip)} width={bw} height={Math.max(1, top + ih - Y(r.them.equip))} rx="1.5" fill={themFill} opacity={won ? 0.4 : 0.85} />}
              {won && <circle cx={x + cell / 2} cy={top - 3} r="2.5" fill="var(--cream)" />}
              {r === peak && r.us.equip !== null && <text x={x + bw / 2} y={Y(r.us.equip) - 5} textAnchor="middle" className="ax ax--cream ax--strong">{fmtMoneyShort(r.us.equip)}</text>}
              <text x={x + cell / 2} y={top + ih + 14} textAnchor="middle" className="ax">{r.number}</text>
            </g>
          );
        })}
        <polyline points={bank("us")} fill="none" stroke="var(--cream)" strokeWidth="1.25" strokeDasharray="3 3" opacity="0.8" />
        <polyline points={bank("them")} fill="none" stroke="var(--ink2)" strokeWidth="1.25" strokeDasharray="3 3" opacity="0.6" />
      </svg>
      <div className="echart__buys" style={{ marginLeft: left, width }}>
        {cols.map((c) => {
          const r = e.rounds[c.ri];
          return (
            <HoverCard key={c.ri} as="div" tabbable={false} card={() => <RoundCardBody v={v} r={v.rounds[c.ri]} />} className="echart__buy" style={{ left: c.x - gap / 2, width: cell + gap }}>
              <BuyIcon buy={r.us.buy} size={12} compact className="cream" />
              <BuyIcon buy={r.them.buy} size={12} compact className="muted" />
            </HoverCard>
          );
        })}
      </div>
      <p className="meta echart__readout" aria-hidden>{focused === null ? "" : `${roundWords(e.rounds[focused])} Enter opens it.`}</p>
      <div className="legend" style={{ marginTop: 6 }}>
        <span><i className="swatch" style={{ background: "var(--t)" }} />T</span>
        <span><i className="swatch" style={{ background: "var(--ct)" }} />CT</span>
        <span>Left bar yours, right theirs, bright when it won</span>
        <span><svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke="var(--cream)" strokeDasharray="3 3" /></svg>Your bank after buying</span>
        <span className="legend__icons">{BUY_CLASSES.map((b) => <span key={b} data-tip={BUY_DEF[b]}><BuyIcon buy={b} size={12} beside />{BUY_CLASS_LABEL[b]}</span>)}</span>
      </div>
    </div>
  );
}

function BuyRates({ v }: { v: MatchView }) {
  const w = v.b.economy.winRate;
  const rows = BUY_CLASSES.map((b, i) => ({ b, us: w.us[i], them: w.them[i] })).filter((r) => r.us.rounds > 0 || r.them.rounds > 0);
  if (!rows.length) return <p className="meta">No round has a known buy: equipment values are missing.</p>;
  return (
    <ul className="buyrates">
      {rows.map((r) => {
        const pct = r.us.rounds ? (100 * r.us.wins) / r.us.rounds : null;
        const theirs = r.them.rounds ? (100 * r.them.wins) / r.them.rounds : null;
        return (
          <li key={r.b} data-tip={`Opponents won ${r.them.wins} of ${r.them.rounds} on this buy (${fmtPct(theirs, 0)})`}>
            <BuyIcon buy={r.b} size={16} beside className="cream" />
            <b>{BUY_CLASS_LABEL[r.b]}</b>
            <span className="hbar">{pct !== null && <i style={{ width: `${pct}%`, background: pct >= 50 ? "var(--good)" : "var(--poor)", opacity: 0.85 }} />}{theirs !== null && <em className="hbar__ref" style={{ left: `${theirs}%` }} />}</span>
            <b className="num" style={{ color: pct === null ? undefined : scoreText(toScore(pct, 50, 40)) }}>{fmtPct(pct, 0)}</b>
            <span className="num faint">{r.us.wins}/{r.us.rounds}</span>
          </li>
        );
      })}
    </ul>
  );
}

function BuyMatrix({ v }: { v: MatchView }) {
  const m = v.b.economy.matchup;
  const rows = BUY_CLASSES.map((b, i) => ({ b, i })).filter(({ i }) => m[i].some((c) => c.rounds > 0));
  const cols = BUY_CLASSES.map((b, j) => ({ b, j })).filter(({ j }) => m.some((row) => row[j].rounds > 0));
  if (!rows.length) return <p className="meta">No round has a known buy for both teams.</p>;
  return (
    <table className="tbl bmatrix">
      <thead>
        <tr><th className="l"><span className="th">You \ them</span></th>{cols.map(({ b }) => <th key={b}><span className="th" data-tip={`Opponents on ${BUY_CLASS_LABEL[b].toLowerCase()}`}><BuyIcon buy={b} size={12} compact /></span></th>)}</tr>
      </thead>
      <tbody>
        {rows.map(({ b, i }) => (
          <tr key={b}>
            <td className="l"><span className="bmatrix__lbl"><BuyIcon buy={b} size={13} beside />{BUY_CLASS_LABEL[b]}</span></td>
            {cols.map(({ j }) => {
              const c = m[i][j];
              if (!c.rounds) return <td key={j} className="faint">·</td>;
              const t = toScore((100 * c.wins) / c.rounds, 50, 50);
              return <td key={j} style={{ background: scoreTint(t, 0.4) }}><b className="num">{c.wins}</b><span className="faint">/{c.rounds}</span></td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
