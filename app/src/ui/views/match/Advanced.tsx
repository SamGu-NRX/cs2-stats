// Advanced: team-level facts for both teams side by side. Every number comes from the engine's
// per-round details (roundDetails) and economy view.
import type { ReactNode } from "react";
import type { MatchView } from "../../../stats/derive";
import { ClutchBadge } from "../../components/bits";
import { Card } from "../../components/Card";
import { BUY_CLASSES, BUY_CLASS_LABEL } from "../../data/engine";
import { BombIcon, BuyIcon, DefuseIcon, FirstKillIcon, TimeIcon } from "../../icons/game";
import { TradingIcon } from "../../icons/attributes";
import { fmtPct, fmtSecs } from "../../lib/format";
import { scoreText, toScore } from "../../lib/scale";
import type { TabProps } from "./MatchView";

type Team = "us" | "them";
const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

function teamFacts(v: MatchView, t: Team) {
  let fk = 0, fkWon = 0, deaths = 0, traded = 0, tradeKills = 0, clutchN = 0, clutchW = 0;
  let tRounds = 0, tWon = 0, ctRounds = 0, ctWon = 0, plants = 0, exploded = 0, defused = 0, winSecs = 0, winN = 0;
  const pistols: { ri: number; won: boolean }[] = [];
  const clutchByVs = [0, 0, 0, 0, 0].map(() => ({ n: 0, w: 0 }));
  for (const r of v.roundDetails) {
    if (!r.captured) continue;
    const side = r.teams.t.team === t ? "t" : "ct";
    const tr = r.teams[side];
    const won = r.winner === t;
    if (side === "t") { tRounds++; if (won) tWon++; } else { ctRounds++; if (won) ctWon++; }
    if (won && r.durSecs !== null) { winSecs += r.durSecs; winN++; }
    if (tr.buy === "pistol") pistols.push({ ri: r.ri, won });
    if (side === "t" && r.bomb.plantTick !== null) { plants++; if (r.bomb.exploded) exploded++; }
    if (side === "ct" && r.bomb.defused) defused++;
    for (const pi of tr.players) {
      const pr = r.players[pi];
      if (!pr) continue;
      if (pr.kills.some((k) => k.opening)) { fk++; if (won) fkWon++; }
      tradeKills += pr.kills.filter((k) => k.tradeKill).length;
      if (pr.death) { deaths++; if (pr.traded) traded++; }
      if (pr.clutch) { clutchN++; clutchByVs[pr.clutch.opponents - 1].n++; if (pr.clutch.won) { clutchW++; clutchByVs[pr.clutch.opponents - 1].w++; } }
    }
  }
  return { fk, fkWon, deaths, traded, tradeKills, clutchN, clutchW, clutchByVs, tRounds, tWon, ctRounds, ctWon, plants, exploded, defused, avgWin: winN ? winSecs / winN : null, pistols };
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
  const a = teamFacts(v, "us");
  const b = teamFacts(v, "them");
  const n = (x: number) => String(x);
  const p = (x: number | null) => fmtPct(x, 0);
  return (
    <div className="tabpad advanced">
      <div className="grid-2">
        <Block title="Opening duels" icon={<FirstKillIcon size={15} />}>
          <Pair label="Opening kills" tip="Rounds where your team made the first kill" us={a.fk} them={b.fk} fmt={(x) => n(x ?? 0)} />
          <Pair label="Rounds won after the opening kill" tip="Of the rounds a team opened, the share it won" us={pct(a.fkWon, a.fk)} them={pct(b.fkWon, b.fk)} fmt={p} good={(x) => toScore(x, 65, 25)} />
        </Block>
        <Block title="Trading" icon={<TradingIcon size={15} />}>
          <Pair label="Trade kills" tip="Kills on an enemy who had made a kill less than 5 s earlier" us={a.tradeKills} them={b.tradeKills} fmt={(x) => n(x ?? 0)} />
          <Pair label="Deaths traded" tip="Share of a team's deaths avenged within 5 s" us={pct(a.traded, a.deaths)} them={pct(b.traded, b.deaths)} fmt={p} good={(x) => toScore(x, 25, 20)} />
        </Block>
        <Block title="Sides" icon={<span className="adv__sides"><i className="t-dot" /><i className="ct-dot" /></span>}>
          <Pair label="T rounds won" tip="Rounds won on T, of those played on T" us={pct(a.tWon, a.tRounds)} them={pct(b.tWon, b.tRounds)} fmt={p} good={(x) => toScore(x, 50, 30)} />
          <Pair label="CT rounds won" tip="Rounds won on CT, of those played on CT" us={pct(a.ctWon, a.ctRounds)} them={pct(b.ctWon, b.ctRounds)} fmt={p} good={(x) => toScore(x, 50, 30)} />
          <Pair label="Average winning round" tip="Seconds from freeze end to the end of rounds the team won" us={a.avgWin} them={b.avgWin} fmt={(x) => fmtSecs(x, 0)} />
        </Block>
        <Block title="The bomb" icon={<BombIcon size={15} />}>
          <Pair label="Plants as T" tip="Rounds the team planted on T" us={a.plants} them={b.plants} fmt={(x) => n(x ?? 0)} />
          <Pair label="Plants that exploded" tip="Share of a team's plants that exploded" us={pct(a.exploded, a.plants)} them={pct(b.exploded, b.plants)} fmt={p} />
          <Pair label="Defuses as CT" tip="Rounds the team defused" us={a.defused} them={b.defused} fmt={(x) => n(x ?? 0)} />
        </Block>
        <Card title={<span className="adv__title"><BuyIcon buy="full" size={15} />Buys won</span>}>
          <ul className="buyrates">
            {BUY_CLASSES.map((buy, i) => {
              const x = v.econ.winRate.us[i];
              const y = v.econ.winRate.them[i];
              if (!x.rounds && !y.rounds) return null;
              const ours = pct(x.wins, x.rounds);
              return (
                <li key={buy} data-tip={`Opponents won ${y.wins} of ${y.rounds} on this buy`}>
                  <BuyIcon buy={buy} size={16} className="cream" />
                  <b>{BUY_CLASS_LABEL[buy]}</b>
                  <span className="hbar">{ours !== null && <i style={{ width: `${ours}%`, background: ours >= 50 ? "var(--good)" : "var(--poor)" }} />}{y.rounds > 0 && <em className="hbar__ref" style={{ left: `${pct(y.wins, y.rounds)}%` }} />}</span>
                  <b className="num">{fmtPct(ours, 0)}</b>
                  <span className="num faint">{x.wins}/{x.rounds}</span>
                </li>
              );
            })}
          </ul>
          <p className="meta" style={{ marginTop: 8 }}>The tick marks the opponents' rate on the same buy. Pistol rounds: {a.pistols.map((r) => (r.won ? "won" : "lost")).join(", ") || "none"}.</p>
        </Card>
        <Card title={<span className="adv__title"><DefuseIcon size={15} />Clutches</span>} aside={<span className="meta"><span className="cream num">{a.clutchW}/{a.clutchN}</span> you, <span className="num">{b.clutchW}/{b.clutchN}</span> them</span>}>
          <ul className="clist">
            {a.clutchByVs.map((c, i) => (
              <li key={i}>
                <ClutchBadge vs={i + 1} won={c.w > 0} />
                <span className="hbar"><i style={{ width: c.n ? `${(100 * c.w) / c.n}%` : 0, background: "var(--good)" }} /></span>
                <b className="num">{c.w}<span className="faint">/{c.n}</span></b>
              </li>
            ))}
          </ul>
          <p className="meta" style={{ marginTop: 8 }}><TimeIcon size={12} className="faint" style={{ display: "inline", verticalAlign: "-2px" }} /> Your team's 1vX situations by the number of enemies left.</p>
        </Card>
      </div>
    </div>
  );
}
