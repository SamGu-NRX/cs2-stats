// Economy: team equipment per round, HLTV's buy classes (pistol, eco, half, full), saves, and how
// each buy converted, counted from the round facts.
import { useMemo } from "react";
import { ECO_BELOW_PER_PLAYER, FULL_FROM_PER_PLAYER, type BuyClass } from "../../../stats/economy";
import { rollup } from "../../../stats/rollup";
import { Card } from "../../components/Card";
import { useWidth } from "../../components/charts";
import { HoverCard } from "../../components/overlay";
import { BUY_CLASSES, BUY_CLASS_LABEL } from "../../data/engine";
import { buyTally, type MatchModel as MatchView } from "../../data/match";
import { BuyIcon } from "../../icons/game";
import { fmtMoney, fmtMoneyShort, plural } from "../../lib/format";
import { roundColumns } from "../../lib/layout";
import { scoreTint, toScore } from "../../lib/scale";
import { go, matchHref } from "../../router";
import { RoundCardBody } from "../shared";
import type { TabProps } from "./MatchView";

const BUY_DEF: Record<BuyClass, string> = {
  pistol: "First round of each half.",
  eco: `Under ${fmtMoney(ECO_BELOW_PER_PLAYER)} of team equipment per player.`,
  half: "Between eco and a full buy.",
  full: `${fmtMoney(FULL_FROM_PER_PLAYER)} or more of team equipment per player.`,
};

export default function Economy({ v, file }: TabProps) {
  const unknown = v.rounds.filter((r) => !r.buy.us).length;
  const saves = useMemo(() => (["us", "them"] as const).map((t) => rollup([v.facts], { player: v.players.filter((p) => p.team === t).map((p) => p.key) }).m.saves), [v]);
  return (
    <div className="tabpad economy">
      <Card title="Equipment per round">
        <EquipChart v={v} file={file} />
      </Card>
      <div className="grid-3">
        <Card title="Wins by buy" aside={unknown ? <span className="meta">{plural(unknown, "round")} unclassified</span> : undefined}>
          <BuyRates v={v} />
        </Card>
        <Card title="Your buy against theirs" aside={<span className="meta">Won / played</span>}>
          <BuyMatrix v={v} />
        </Card>
        <Card title="Saves" aside={<span className="meta">Lost rounds, alive at the end</span>}>
          <dl className="facts">
            <dt>Your team</dt><dd><b className="num">{saves[0]}</b><span className="meta">player saves</span></dd>
            <dt>Opponents</dt><dd><b className="num">{saves[1]}</b><span className="meta">player saves</span></dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function EquipChart({ v, file }: { v: MatchView; file: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const max = v.maxRounds;
  const H = 240;
  const top = 18;
  const bottom = 26;
  const left = 44;
  const ih = H - top - bottom;
  const n = v.rounds.length;
  const gap = 4;
  const halfGap = 14;
  const cell = Math.max(14, Math.min(40, (w - left - 8 - (n - 1) * gap - halfGap * 2) / Math.max(1, n)));
  const { cols, width } = roundColumns(n, max, cell, gap, halfGap);
  const vmax = Math.max(10000, ...v.rounds.flatMap((r) => [r.equip.us ?? 0, r.equip.them ?? 0]));
  const step = vmax > 30000 ? 10000 : 5000;
  const ticks: number[] = [];
  for (let t = 0; t <= vmax; t += step) ticks.push(t);
  const Y = (x: number) => top + ih - (x / vmax) * ih;
  const bw = (cell - 2) / 2;
  const peak = v.rounds.reduce((b, r) => ((r.equip.us ?? 0) > (b?.equip.us ?? -1) ? r : b), v.rounds[0]);
  return (
    <div ref={ref} className="chart echart">
      <svg width={Math.max(w, left + width + 8)} height={H} role="img" aria-label={`Equipment per round. ${v.rounds.map((r) => `Round ${r.number}: you ${fmtMoney(r.equip.us)}, them ${fmtMoney(r.equip.them)}`).join("; ")}`}>
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
        {cols.map((c) => {
          const r = v.rounds[c.ri];
          const usFill = r.usSide === "T" ? "var(--t)" : "var(--ct)";
          const themFill = r.usSide === "T" ? "var(--ct)" : "var(--t)";
          const x = left + c.x;
          const won = r.winner === "us";
          return (
            <g key={c.ri} className="echart__col" onClick={() => go(matchHref(file, "rounds", { round: r.number }))}>
              <rect x={x - gap / 2} y={top} width={cell + gap} height={ih + bottom} fill="transparent" />
              {r.equip.us !== null && <rect x={x} y={Y(r.equip.us)} width={bw} height={Math.max(1, top + ih - Y(r.equip.us))} rx="1.5" fill={usFill} opacity={won ? 1 : 0.5} />}
              {r.equip.them !== null && <rect x={x + bw + 2} y={Y(r.equip.them)} width={bw} height={Math.max(1, top + ih - Y(r.equip.them))} rx="1.5" fill={themFill} opacity={won ? 0.4 : 0.85} />}
              {won && <circle cx={x + cell / 2} cy={top - 3} r="2.5" fill="var(--cream)" />}
              {r === peak && r.equip.us !== null && <text x={x + bw / 2} y={Y(r.equip.us) - 5} textAnchor="middle" className="ax ax--cream ax--strong">{fmtMoneyShort(r.equip.us)}</text>}
              <text x={x + cell / 2} y={top + ih + 14} textAnchor="middle" className="ax">{r.number}</text>
            </g>
          );
        })}
      </svg>
      <div className="echart__buys" style={{ marginLeft: left, width }}>
        {cols.map((c) => {
          const r = v.rounds[c.ri];
          return (
            <HoverCard key={c.ri} as="div" tabbable={false} card={() => <RoundCardBody v={v} r={r} />} className="echart__buy" style={{ left: c.x, width: cell }}>
              <BuyIcon buy={r.buy.us} size={12} className="cream" />
              <BuyIcon buy={r.buy.them} size={12} className="muted" />
            </HoverCard>
          );
        })}
      </div>
      <div className="legend" style={{ marginTop: 12 }}>
        <span><i className="swatch" style={{ background: "var(--t)" }} />T</span>
        <span><i className="swatch" style={{ background: "var(--ct)" }} />CT</span>
        <span>Left bar yours, right theirs, bright when it won</span>
        <span className="legend__icons">{BUY_CLASSES.map((b) => <span key={b} data-tip={BUY_DEF[b]}><BuyIcon buy={b} size={12} />{BUY_CLASS_LABEL[b]}</span>)}</span>
      </div>
    </div>
  );
}

function BuyRates({ v }: { v: MatchView }) {
  const t = useMemo(() => buyTally(v), [v]);
  const rows = BUY_CLASSES.map((b) => ({ b, us: t.us[b], them: t.them[b] })).filter((r) => r.us.rounds > 0 || r.them.rounds > 0);
  if (!rows.length) return <p className="meta">No round has a known buy: equipment values are missing.</p>;
  return (
    <ul className="buyrates">
      {rows.map((r) => {
        // bar lengths only; wins and rounds are the numbers shown
        const ours = r.us.rounds ? (100 * r.us.wins) / r.us.rounds : null;
        const theirs = r.them.rounds ? (100 * r.them.wins) / r.them.rounds : null;
        return (
          <li key={r.b} data-tip={`${BUY_DEF[r.b]} Opponents won ${r.them.wins} of ${r.them.rounds} on this buy.`}>
            <BuyIcon buy={r.b} size={16} className="cream" />
            <b>{BUY_CLASS_LABEL[r.b]}</b>
            <span className="hbar">{ours !== null && <i style={{ width: `${ours}%`, background: ours >= 50 ? "var(--good)" : "var(--poor)", opacity: 0.85 }} />}{theirs !== null && <em className="hbar__ref" style={{ left: `${theirs}%` }} />}</span>
            <b className="num">{r.us.wins}<span className="faint">/{r.us.rounds}</span></b>
          </li>
        );
      })}
      <li className="buyrates__note meta">The tick marks the opponents' share of wins on the same buy.</li>
    </ul>
  );
}

function BuyMatrix({ v }: { v: MatchView }) {
  const m = useMemo(() => buyTally(v).matchup, [v]);
  const rows = BUY_CLASSES.filter((b) => BUY_CLASSES.some((c) => m[b][c].rounds > 0));
  const cols = BUY_CLASSES.filter((c) => BUY_CLASSES.some((b) => m[b][c].rounds > 0));
  if (!rows.length) return <p className="meta">No round has a known buy for both teams.</p>;
  return (
    <table className="tbl bmatrix">
      <thead>
        <tr><th className="l"><span className="th">You \ them</span></th>{cols.map((b) => <th key={b}><span className="th" data-tip={`Opponents on ${BUY_CLASS_LABEL[b].toLowerCase()}`}><BuyIcon buy={b} size={12} /></span></th>)}</tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b}>
            <td className="l"><span className="bmatrix__lbl"><BuyIcon buy={b} size={13} />{BUY_CLASS_LABEL[b]}</span></td>
            {cols.map((c) => {
              const x = m[b][c];
              if (!x.rounds) return <td key={c} className="faint">·</td>;
              const t = toScore((100 * x.wins) / x.rounds, 50, 50);
              return <td key={c} style={{ background: scoreTint(t, 0.4) }}><b className="num">{x.wins}</b><span className="faint">/{x.rounds}</span></td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
