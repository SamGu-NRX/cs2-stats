// Duels: who killed whom (head to head), opening duels and trades per player.
import { useMemo } from "react";
import { TRADE_WINDOW_S } from "../../../stats/rules";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { DataTable } from "../../components/DataTable";
import { FirstKillIcon, TradingGlyph } from "./glyphs";
import { fmtMetric } from "../../data/engine";
import { deathOf, killMatrix, killsBy, type MPlayer as PlayerRow } from "../../data/match";
import { metric as meta } from "../../data/meta";
import { fmtDiff, fmtRatio } from "../../lib/format";
import { DeathIcon, SkullIcon } from "../../icons/game";
import { diffScore, scoreText, scoreTint, toScore } from "../../lib/scale";
import { NEEDS_DEMO, PlayerName, SectionAside } from "../shared";
import type { TabProps } from "./MatchView";

export default function Duels({ v }: TabProps) {
  const us = v.players.filter((p) => p.team === "us");
  const them = v.players.filter((p) => p.team === "them");
  const km = useMemo(() => killMatrix(v), [v]);
  const lines = v.b.lines.both;
  const m = (p: PlayerRow) => lines[p.pi].m;
  const metric = (p: PlayerRow, id: string) => lines[p.pi].v[id];
  const totalUs = us.reduce((a, p) => a + them.reduce((b, q) => b + km[p.pi][q.pi], 0), 0);
  const totalThem = them.reduce((a, q) => a + us.reduce((b, p) => b + km[q.pi][p.pi], 0), 0);
  const fk = (t: "us" | "them") => v.players.filter((p) => p.team === t).reduce((a, p) => a + m(p).openingKills, 0);
  return (
    <div className="tabpad duels">
      <Card title="Head to head" aside={<SectionAside label="Kills" value={<><span className="cream">{totalUs}</span><span className="faint">–</span>{totalThem}</>} />}>
        <div className="tbl-wrap">
          <table className="tbl h2h">
            <thead>
              <tr>
                <th className="l"><span className="th">Your team ↓ vs →</span></th>
                {them.map((q) => <th key={q.key}><span className="th"><PlayerName v={v} pi={q.pi} /></span></th>)}
                <th><span className="th">Total</span></th>
              </tr>
            </thead>
            <tbody>
              {us.map((p) => {
                const rowK = them.reduce((a, q) => a + km[p.pi][q.pi], 0);
                const rowD = them.reduce((a, q) => a + km[q.pi][p.pi], 0);
                return (
                  <tr key={p.key} className={p.isHuman ? "is-you" : undefined}>
                    <td className="l name-cell"><PlayerName v={v} pi={p.pi} /></td>
                    {them.map((q) => {
                      const k = km[p.pi][q.pi];
                      const d = km[q.pi][p.pi];
                      const t = k + d ? toScore(k - d, 0, 4) : 0;
                      return (
                        <td key={q.key} style={{ background: k + d ? scoreTint(t, 0.4) : undefined }} data-tip={`${p.name} killed ${q.name} ${k} ${k === 1 ? "time" : "times"}; ${q.name} killed ${p.name} ${d}`}>
                          <span className="num"><b>{k}</b><span className="faint">–</span>{d}</span>
                        </td>
                      );
                    })}
                    <td><b className="num" style={{ color: scoreText(diffScore(rowK - rowD)) }}>{fmtDiff(rowK - rowD)}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="meta" style={{ marginTop: 10 }}>Each cell reads your player's kills on that opponent, then the opponent's kills back.</p>
      </Card>
      <YourRounds v={v} />
      <div className="grid-2">
        <Card title="Opening duels" icon={<FirstKillIcon size={16} className="cream" />} aside={<SectionAside label="First kills" value={<><span className="cream">{fk("us")}</span><span className="faint">–</span>{fk("them")}</>} />} flush>
          <DataTable<PlayerRow>
            label="Opening duels"
            rows={v.players}
            rowKey={(p) => p.key}
            defaultSort={{ key: "fk", dir: "desc" }}
            rowClass={(p) => (p.isHuman ? "is-you" : undefined)}
            columns={[
              { key: "name", label: "Player", align: "l", sort: (p) => p.name, render: (p) => <span className={`name-cell ${p.team}-text`}><PlayerName v={v} pi={p.pi} /></span> },
              { key: "fk", label: "FK", tip: "Opening kills: the first kill of a round", sort: (p) => m(p).openingKills, render: (p) => m(p).openingKills },
              { key: "fd", label: "FD", tip: "Opening deaths", sort: (p) => m(p).openingDeaths, firstDir: "asc", render: (p) => m(p).openingDeaths },
              { key: "att", label: "Attempts", tip: meta("openingAttempts").def, sort: (p) => metric(p, "openingAttempts"), render: (p) => <Num v={fmtMetric("openingAttempts", metric(p, "openingAttempts"))} /> },
              { key: "succ", label: "Success", colored: true, tip: meta("openingSuccess").def, sort: (p) => metric(p, "openingSuccess"), render: (p) => { const x = metric(p, "openingSuccess"); return <span style={{ color: x === null ? undefined : scoreText(toScore(x, 50, 40)) }}><Num v={fmtMetric("openingSuccess", x)} /></span>; } },
              // openingWins counts the rounds won in which the player made the opening kill (scoreboard.ts)
              { key: "win", label: "Won after", tip: "Rounds won after your opening kill", sort: (p) => (m(p).openingKills ? m(p).openingWins / m(p).openingKills : null), render: (p) => <Num v={fmtRatio(m(p).openingWins, m(p).openingKills)} /> },
            ]}
          />
        </Card>
        <Card title="Trades" icon={<TradingGlyph size={16} className="cream" />} flush>
          <DataTable<PlayerRow>
            label="Trades"
            rows={v.players}
            rowKey={(p) => p.key}
            defaultSort={{ key: "tk", dir: "desc" }}
            rowClass={(p) => (p.isHuman ? "is-you" : undefined)}
            columns={[
              { key: "name", label: "Player", align: "l", sort: (p) => p.name, render: (p) => <span className={`name-cell ${p.team}-text`}><PlayerName v={v} pi={p.pi} /></span> },
              { key: "tk", label: "Trade kills", tip: `Kills on an enemy who had killed a teammate in the last ${TRADE_WINDOW_S} s`, sort: (p) => m(p).tradeKills, render: (p) => m(p).tradeKills },
              { key: "td", label: "Traded", tip: meta("deathsTradedPct").def, sort: (p) => metric(p, "deathsTradedPct"), render: (p) => <span className="num">{m(p).tradedDeaths}<span className="faint">/{m(p).deaths}</span></span> },
              { key: "saved", label: "Saved", tip: "Times you killed an enemy who had just hit a teammate, while the teammate lived", sort: (p) => m(p).savedTeammate, render: (p) => m(p).savedTeammate },
              { key: "savedby", label: "Saved by", tip: "Times a teammate did that for you", sort: (p) => m(p).savedByTeammate, render: (p) => m(p).savedByTeammate },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/** Your fights round by round: who you killed, who killed you, and how you shot. Time to damage and
 *  reaction need mesh visibility, which plugin recordings do not carry. main's footnote promised
 *  reaction per opponent "with the metrics update"; the engine keeps one median per round, so the
 *  footnote now says that. */
function YourRounds({ v }: { v: TabProps["v"] }) {
  const gated = !v.visibility;
  const gate = `${NEEDS_DEMO}: these need view angles and mesh line of sight, which this match file does not carry.`;
  const human = v.human;
  const rows = useMemo(() => v.rounds.filter((r) => killsBy(r, human).length || deathOf(r, human)).map((r) => ({
    r, kills: killsBy(r, human), death: deathOf(r, human), s: v.b.yourRounds[r.ri],
  })), [v, human]);
  const metric = (s: (typeof rows)[number]["s"], id: string) => fmtMetric(id, s[id]);
  return (
    <Card title="Your duels, round by round" aside={<span className="meta">{rows.length} rounds with a fight</span>} collapsible id="duels-rounds" flush>
      <div className="tbl-wrap">
        <table className="tbl yrounds">
          <thead><tr>
            <th className="l"><span className="th">Round</span></th>
            <th className="l"><span className="th">Killed</span></th>
            <th className="l"><span className="th">Died to</span></th>
            <th><span className="th" data-tip={meta("accuracy").def}>Accuracy</span></th>
            <th><span className="th" data-tip={meta("timeToDamage").def}>TTD</span></th>
            <th><span className="th" data-tip={meta("reactionTime").def}>Reaction</span></th>
          </tr></thead>
          <tbody>
            {rows.map(({ r, kills, death, s }) => {
              const won = r.winner === "us";
              return (
                <tr key={r.ri}>
                  <td className="l"><span className={`wl wl--${won ? "W" : "L"}`}>{r.number}</span></td>
                  <td className="l"><span className="yrounds__names">{kills.map((k, i) => <span key={i} className="yrounds__kill"><SkullIcon hs={k.headshot} size={10} className={k.headshot ? "skull skull--hs" : "skull"} />{v.players[k.victim].name}</span>)}{!kills.length && <span className="faint">–</span>}</span></td>
                  <td className="l">{death ? <span className="yrounds__kill"><DeathIcon size={10} className="poor-text" />{death.killer === null ? "World" : v.players[death.killer].name}{death.traded && <span className="chip chip--outline">traded</span>}</span> : <span className="faint">Survived</span>}</td>
                  <td><Num v={v.entry.hasAim ? metric(s, "accuracy") : "–"} /></td>
                  <td>{gated ? <span className="faint" data-tip={gate}>–</span> : <Num v={metric(s, "timeToDamage")} />}</td>
                  <td>{gated ? <span className="faint" data-tip={gate}>–</span> : <Num v={metric(s, "reactionTime")} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="meta yrounds__note">Time to damage and reaction are medians over all your sightings that round; the engine does not split them by opponent.</p>
    </Card>
  );
}
