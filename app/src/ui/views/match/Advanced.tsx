// Advanced: team-level facts for both teams side by side. Rates come from the worker's rollup of each
// team's five players and its economy view (economyOf); round counts come from the round facts. Then
// every clutch of the match (ClutchList.tsx), your side's man-advantage states and bombsite outcomes
// (Situations.tsx, worker situations and bombsites).
import { useMemo, type ReactNode } from "react";
import { ClutchBadge, FirstPip } from "../../components/bits";
import { Card } from "../../components/Card";
import { BUY_CLASSES, BUY_CLASS_LABEL, clutchRows } from "../../data/engine";
import type { MatchModel, Team } from "../../data/match";
import { metric } from "../../data/meta";
import { BuyIcon, WeaponIcon, WinIcon } from "../../icons/game";
import { TradingIcon } from "../../icons/attributes";
import { fmtPct, fmtSecs } from "../../lib/format";
import { scoreText, toScore } from "../../lib/scale";
import { Hint } from "./glyphs";
import type { TabProps } from "./MatchView";
import { BombsitesCard, SituationsCard } from "./Situations";
import { Viewed } from "./Viewer";
import { ClutchList } from "./ClutchList";

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
const other = (t: Team): Team => (t === "us" ? "them" : "us");

function teamFacts(v: MatchModel, t: Team) {
  const line = v.b.teams[t];
  const e = v.b.economy;
  let tRounds = 0, tWon = 0, ctRounds = 0, ctWon = 0, winSecs = 0, winN = 0;
  const pistols: boolean[] = [];
  for (const r of v.rounds) {
    if (r.winner === null) continue;
    const side = t === "us" ? r.usSide : r.usSide === "T" ? "CT" : "T";
    const won = r.winner === t;
    if (side === "T") { tRounds++; if (won) tWon++; } else { ctRounds++; if (won) ctWon++; }
    if (won && r.durSecs !== null) { winSecs += r.durSecs; winN++; }
    if (r.buy[t] === "pistol") pistols.push(won);
  }
  return {
    fk: e.afterOpening[t].rounds, fkWon: e.afterOpening[t].wins, tradeKills: line.m.tradeKills, deathsTraded: line.v.deathsTradedPct,
    clutches: clutchRows(line.m), tRounds, tWon, ctRounds, ctWon, avgWin: winN ? winSecs / winN : null,
    plants: e.plants[t].planted, exploded: e.plants[t].exploded, defused: e.plants[other(t)].defused, pistols,
  };
}

function Pair({ label, tip, us, them, fmt, good }: { label: string; tip: string; us: number | null; them: number | null; fmt: (x: number | null) => string; good?: (x: number) => number }) {
  const total = (us ?? 0) + (them ?? 0);
  return (
    <div className="pair" data-tip={tip} tabIndex={0}>
      <span className="pair__l">{label}</span>
      <b className="num pair__us" style={good && us !== null ? { color: scoreText(good(us)) } : undefined}>{fmt(us)}</b>
      <span className="pair__bar">{total > 0 && <><i style={{ width: `${(100 * (us ?? 0)) / total}%` }} /><em style={{ width: `${(100 * (them ?? 0)) / total}%` }} /></>}</span>
      <b className="num pair__them">{fmt(them)}</b>
    </div>
  );
}

function Block({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card title={<span className="adv__title">{icon}{title}</span>} aside={<span className="adv__legend"><span className="cream">You</span><span className="faint">Them</span></span>}>
      <div className="pairs">{children}</div>
    </Card>
  );
}

export default function Advanced({ v, file }: TabProps) {
  const a = useMemo(() => teamFacts(v, "us"), [v]);
  const b = useMemo(() => teamFacts(v, "them"), [v]);
  const rates = v.b.economy.winRate;
  const n = (x: number | null) => String(x ?? 0);
  const p = (x: number | null) => fmtPct(x, 0);
  const won = (rows: { won: number }[]) => rows.reduce((t, r) => t + r.won, 0);
  const played = (rows: { played: number }[]) => rows.reduce((t, r) => t + r.played, 0);
  return (
    <div className="tabpad advanced">
      <div className="grid-2">
        <Block title="Opening duels" icon={<FirstPip />}>
          <Pair label="Opening kills" tip="Rounds where the team made the first kill" us={a.fk} them={b.fk} fmt={n} />
          <Pair label="Rounds won after the opening kill" tip="Of the rounds a team opened, the share it won" us={pct(a.fkWon, a.fk)} them={pct(b.fkWon, b.fk)} fmt={p} good={(x) => toScore(x, 65, 25)} />
        </Block>
        <Block title="Trading" icon={<TradingIcon size={15} />}>
          <Pair label="Trade kills" tip="Kills on an enemy who had just killed a teammate" us={a.tradeKills} them={b.tradeKills} fmt={n} />
          <Pair label="Deaths traded" tip={metric("deathsTradedPct").def} us={a.deathsTraded} them={b.deathsTraded} fmt={p} good={(x) => toScore(x, 25, 20)} />
        </Block>
        <Block title="Sides" icon={<span className="adv__sides"><i className="t-dot" /><i className="ct-dot" /></span>}>
          <Pair label="T rounds won" tip="Rounds won on T, of those played on T" us={pct(a.tWon, a.tRounds)} them={pct(b.tWon, b.tRounds)} fmt={p} good={(x) => toScore(x, 50, 30)} />
          <Pair label="CT rounds won" tip="Rounds won on CT, of those played on CT" us={pct(a.ctWon, a.ctRounds)} them={pct(b.ctWon, b.ctRounds)} fmt={p} good={(x) => toScore(x, 50, 30)} />
          <Pair label="Average winning round" tip="Seconds from freeze end to the end of rounds the team won" us={a.avgWin} them={b.avgWin} fmt={(x) => fmtSecs(x, 0)} />
        </Block>
        <Block title="The bomb" icon={<WeaponIcon name="c4" height={15} beside />}>
          <Pair label="Plants as T" tip="Rounds the team planted on T" us={a.plants} them={b.plants} fmt={n} />
          <Pair label="Plants that exploded" tip="Share of a team's plants that exploded" us={pct(a.exploded, a.plants)} them={pct(b.exploded, b.plants)} fmt={p} />
          <Pair label="Defuses as CT" tip="Rounds the team defused" us={a.defused} them={b.defused} fmt={n} />
        </Block>
        <Card title={<span className="adv__title"><BuyIcon buy="full" size={15} beside />Buys won <Hint tip="The tick is the opponents' rate on the same buy." /></span>} aside={<span className="meta">Pistols: {a.pistols.map((w) => (w ? "won" : "lost")).join(", ") || "none"}</span>}>
          <ul className="buyrates">
            {BUY_CLASSES.map((buy, i) => {
              const x = rates.us[i];
              const y = rates.them[i];
              if (!x.rounds && !y.rounds) return null;
              const ours = pct(x.wins, x.rounds);
              return (
                <li key={buy} data-tip={`Opponents won ${y.wins} of ${y.rounds} on this buy`} tabIndex={0}>
                  <BuyIcon buy={buy} size={16} beside className="cream" />
                  <b>{BUY_CLASS_LABEL[buy]}</b>
                  <span className="hbar">{ours !== null && <i style={{ width: `${ours}%`, background: ours >= 50 ? "var(--good)" : "var(--poor)" }} />}{y.rounds > 0 && <em className="hbar__ref" style={{ left: `${pct(y.wins, y.rounds)}%` }} />}</span>
                  <b className="num">{fmtPct(ours, 0)}</b>
                  <span className="num faint">{x.wins}/{x.rounds}</span>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title={<span className="adv__title"><WinIcon how="defuse" size={15} beside />Clutches <Hint tip="Your team's 1vX situations by enemies left." /></span>} aside={<span className="meta"><span className="cream num">{won(a.clutches)}/{played(a.clutches)}</span> you, <span className="num">{won(b.clutches)}/{played(b.clutches)}</span> them</span>}>
          <ul className="clist">
            {a.clutches.map((c) => (
              <li key={c.vs}>
                <ClutchBadge vs={c.vs} won={c.won > 0} />
                <span className="hbar"><i style={{ width: c.played ? `${(100 * c.won) / c.played}%` : 0, background: "var(--good)" }} /></span>
                <b className="num">{c.won}<span className="faint">/{c.played}</span></b>
              </li>
            ))}
          </ul>
        </Card>
        <ClutchList v={v} file={file} />
        <Viewed v={v} what="their situations and bombsite play" pad={false}>{(w) => <><SituationsCard v={w} file={file} /><BombsitesCard v={w} file={file} /></>}</Viewed>
      </div>
    </div>
  );
}
