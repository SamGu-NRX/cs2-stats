// Advanced: team-level facts for both teams side by side. Rates come from METRIC over a rollup of
// the team's five players; counts come from the round facts.
import { useMemo, type ReactNode } from "react";
import { METRIC } from "../../../stats/metrics";
import { rollup } from "../../../stats/rollup";
import { ClutchBadge } from "../../components/bits";
import { Card } from "../../components/Card";
import { BUY_CLASSES, BUY_CLASS_LABEL, clutchRows } from "../../data/engine";
import { buyTally, type MatchModel, type Team } from "../../data/match";
import { BombIcon, BuyIcon, DefuseIcon, FirstKillIcon, TimeIcon } from "../../icons/game";
import { TradingIcon } from "../../icons/attributes";
import { fmtPct } from "../../lib/format";
import { scoreText, toScore } from "../../lib/scale";
import type { TabProps } from "./MatchView";

function teamFacts(v: MatchModel, t: Team) {
  const s = rollup([v.facts], { player: v.players.filter((p) => p.team === t).map((p) => p.key) });
  let tWon = 0, ctWon = 0, plants = 0, exploded = 0, defused = 0;
  const pistols: boolean[] = [];
  for (const r of v.rounds) {
    const side = t === "us" ? r.usSide : r.usSide === "T" ? "CT" : "T";
    const won = r.winner === t;
    if (won) { if (side === "T") tWon++; else ctWon++; }
    if (r.buy[t] === "pistol") pistols.push(won);
    if (side === "T" && r.planted) { plants++; if (r.exploded) exploded++; }
    if (side === "CT" && r.defused) defused++;
  }
  return {
    fk: s.m.openingKills, openingSuccess: METRIC.openingSuccess.value(s), tradeKills: s.m.tradeKills, deathsTraded: METRIC.deathsTradedPct.value(s),
    clutches: clutchRows(s.m), tWon, ctWon, plants, exploded, defused, pistols,
  };
}

function Pair({ label, tip, us, them, fmt, good }: { label: string; tip: string; us: number | null; them: number | null; fmt: (x: number | null) => string; good?: (x: number) => number }) {
  const total = (us ?? 0) + (them ?? 0);
  return (
    <div className="pair" data-tip={tip}>
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

export default function Advanced({ v }: TabProps) {
  const a = useMemo(() => teamFacts(v, "us"), [v]);
  const b = useMemo(() => teamFacts(v, "them"), [v]);
  const buys = useMemo(() => buyTally(v), [v]);
  const n = (x: number | null) => String(x ?? 0);
  const p = (x: number | null) => fmtPct(x, 0);
  const won = (rows: { won: number }[]) => rows.reduce((t, r) => t + r.won, 0);
  const played = (rows: { played: number }[]) => rows.reduce((t, r) => t + r.played, 0);
  return (
    <div className="tabpad advanced">
      <div className="grid-2">
        <Block title="Opening duels" icon={<FirstKillIcon size={15} />}>
          <Pair label="Opening kills" tip="Rounds where the team made the first kill" us={a.fk} them={b.fk} fmt={n} />
          <Pair label="Opening duels won" tip={METRIC.openingSuccess.def} us={a.openingSuccess} them={b.openingSuccess} fmt={p} good={(x) => toScore(x, 50, 25)} />
        </Block>
        <Block title="Trading" icon={<TradingIcon size={15} />}>
          <Pair label="Trade kills" tip="Kills on an enemy who had just killed a teammate" us={a.tradeKills} them={b.tradeKills} fmt={n} />
          <Pair label="Deaths traded" tip={METRIC.deathsTradedPct.def} us={a.deathsTraded} them={b.deathsTraded} fmt={p} good={(x) => toScore(x, 25, 20)} />
        </Block>
        <Block title="Sides" icon={<span className="adv__sides"><i className="t-dot" /><i className="ct-dot" /></span>}>
          <Pair label="T rounds won" tip="Rounds won on T" us={a.tWon} them={b.tWon} fmt={n} />
          <Pair label="CT rounds won" tip="Rounds won on CT" us={a.ctWon} them={b.ctWon} fmt={n} />
        </Block>
        <Block title="The bomb" icon={<BombIcon size={15} />}>
          <Pair label="Plants as T" tip="Rounds the team planted on T" us={a.plants} them={b.plants} fmt={n} />
          <Pair label="Plants that exploded" tip="The team's plants that exploded" us={a.exploded} them={b.exploded} fmt={n} />
          <Pair label="Defuses as CT" tip="Rounds the team defused" us={a.defused} them={b.defused} fmt={n} />
        </Block>
        <Card title={<span className="adv__title"><BuyIcon buy="full" size={15} />Buys won</span>}>
          <ul className="buyrates">
            {BUY_CLASSES.map((buy) => {
              const x = buys.us[buy];
              const y = buys.them[buy];
              if (!x.rounds && !y.rounds) return null;
              // bar lengths only; wins and rounds are the numbers shown
              const ours = x.rounds ? (100 * x.wins) / x.rounds : null;
              return (
                <li key={buy} data-tip={`Opponents won ${y.wins} of ${y.rounds} on this buy`}>
                  <BuyIcon buy={buy} size={16} className="cream" />
                  <b>{BUY_CLASS_LABEL[buy]}</b>
                  <span className="hbar">{ours !== null && <i style={{ width: `${ours}%`, background: ours >= 50 ? "var(--good)" : "var(--poor)" }} />}{y.rounds > 0 && <em className="hbar__ref" style={{ left: `${(100 * y.wins) / y.rounds}%` }} />}</span>
                  <b className="num">{x.wins}<span className="faint">/{x.rounds}</span></b>
                </li>
              );
            })}
          </ul>
          <p className="meta" style={{ marginTop: 8 }}>The tick marks the opponents' share of wins on the same buy. Pistol rounds: {a.pistols.map((w) => (w ? "won" : "lost")).join(", ") || "none"}.</p>
        </Card>
        <Card title={<span className="adv__title"><DefuseIcon size={15} />Clutches</span>} aside={<span className="meta"><span className="cream num">{won(a.clutches)}/{played(a.clutches)}</span> you, <span className="num">{won(b.clutches)}/{played(b.clutches)}</span> them</span>}>
          <ul className="clist">
            {a.clutches.map((c) => (
              <li key={c.vs}>
                <ClutchBadge vs={c.vs} won={c.won > 0} />
                <span className="hbar"><i style={{ width: c.played ? `${(100 * c.won) / c.played}%` : 0, background: "var(--good)" }} /></span>
                <b className="num">{c.won}<span className="faint">/{c.played}</span></b>
              </li>
            ))}
          </ul>
          <p className="meta" style={{ marginTop: 8 }}><TimeIcon size={12} className="faint" style={{ display: "inline", verticalAlign: "-2px" }} /> Your team's 1vX situations by the number of enemies left.</p>
        </Card>
      </div>
    </div>
  );
}
