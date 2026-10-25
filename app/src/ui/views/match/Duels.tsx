// Duels: who killed whom (head to head), opening duels and trades per player.
import type { PlayerRow } from "../../../stats/derive";
import { Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { DataTable } from "../../components/DataTable";
import { FirstKillIcon, TradingGlyph } from "./glyphs";
import { fmtDiff, fmtMs, fmtPct, fmtRatio } from "../../lib/format";
import { aimVisibility } from "../../../stats/aim";
import { DeathIcon, SkullIcon } from "../../icons/game";
import { diffScore, scoreText, scoreTint, toScore } from "../../lib/scale";
import { PlayerName, SectionAside } from "../shared";
import type { TabProps } from "./MatchView";

const pct = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);

export default function Duels({ v }: TabProps) {
  const us = v.players.filter((p) => p.team === "us");
  const them = v.players.filter((p) => p.team === "them");
  const km = v.killMatrix;
  const totalUs = us.reduce((a, p) => a + them.reduce((b, q) => b + km[p.pi][q.pi], 0), 0);
  const totalThem = them.reduce((a, q) => a + us.reduce((b, p) => b + km[q.pi][p.pi], 0), 0);
  const fk = (t: "us" | "them") => v.players.filter((p) => p.team === t).reduce((a, p) => a + p.c.openingKills, 0);
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
              { key: "fk", label: "FK", tip: "Opening kills: the first kill of a round", sort: (p) => p.c.openingKills, render: (p) => p.c.openingKills },
              { key: "fd", label: "FD", tip: "Opening deaths", sort: (p) => p.c.openingDeaths, firstDir: "asc", render: (p) => p.c.openingDeaths },
              { key: "att", label: "Attempts", tip: "Share of rounds where you took part in the first kill", sort: (p) => pct(p.c.openingKills + p.c.openingDeaths, p.c.fullRounds), render: (p) => <Num v={fmtRatio(p.c.openingKills + p.c.openingDeaths, p.c.fullRounds)} /> },
              { key: "succ", label: "Success", colored: true, tip: "Opening duels won", sort: (p) => pct(p.c.openingKills, p.c.openingKills + p.c.openingDeaths), render: (p) => { const x = pct(p.c.openingKills, p.c.openingKills + p.c.openingDeaths); return <span style={{ color: x === null ? undefined : scoreText(toScore(x, 50, 40)) }}><Num v={fmtPct(x)} /></span>; } },
              { key: "win", label: "Won after", tip: "Rounds won after your opening kill", sort: (p) => pct(p.c.openingWins, p.c.openingKills), render: (p) => <Num v={fmtRatio(p.c.openingWins, p.c.openingKills)} /> },
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
              { key: "tk", label: "Trade kills", tip: "Kills on an enemy who had made a kill less than 5 s earlier", sort: (p) => p.c.tradeKills, render: (p) => p.c.tradeKills },
              { key: "td", label: "Traded", tip: "Share of your deaths avenged within 5 s", sort: (p) => pct(p.c.tradedDeaths, p.c.fullDeaths), render: (p) => <span className="num">{p.c.tradedDeaths}<span className="faint">/{p.c.fullDeaths}</span></span> },
              { key: "saved", label: "Saved", tip: "Times you killed an enemy who had hit a teammate in the last 2 s, while the teammate lived", sort: (p) => p.c.savedTeammate, render: (p) => p.c.savedTeammate },
              { key: "savedby", label: "Saved by", tip: "Times a teammate did that for you", sort: (p) => p.c.savedByTeammate, render: (p) => p.c.savedByTeammate },
            ]}
          />
        </Card>
      </div>
    </div>
  );
}

/** Your fights round by round: who you killed, who killed you, and how you shot. Time to damage and
 *  reaction per round need the visibility gate to open; the metrics update adds reaction per opponent. */
function YourRounds({ v }: { v: TabProps["v"] }) {
  const gate = v.aim ? aimVisibility(v.aim) : null;
  const rows = v.roundDetails.filter((r) => r.captured && r.players[v.human] && (r.players[v.human]!.kills.length || r.players[v.human]!.death));
  const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null);
  return (
    <Card title="Your duels, round by round" aside={<span className="meta">{rows.length} rounds with a fight</span>} collapsible id="duels-rounds" flush>
      <div className="tbl-wrap">
        <table className="tbl yrounds">
          <thead><tr>
            <th className="l"><span className="th">Round</span></th>
            <th className="l"><span className="th">Killed</span></th>
            <th className="l"><span className="th">Died to</span></th>
            <th><span className="th" data-tip="Hits divided by shots that round">Accuracy</span></th>
            <th><span className="th" data-tip="Median time from an enemy appearing to your first damage">TTD</span></th>
            <th><span className="th" data-tip="Median time until your aim moved toward the enemy">Reaction</span></th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const pr = r.players[v.human]!;
              const h = r.human;
              const won = r.winner === "us";
              return (
                <tr key={r.ri}>
                  <td className="l"><span className={`wl wl--${won ? "W" : "L"}`}>{r.ri + 1}</span></td>
                  <td className="l"><span className="yrounds__names">{pr.kills.map((k, i) => <span key={i} className="yrounds__kill"><SkullIcon hs={k.headshot} size={10} className={k.headshot ? "skull skull--hs" : "skull"} />{v.players[k.victim].name}</span>)}{!pr.kills.length && <span className="faint">–</span>}</span></td>
                  <td className="l">{pr.death ? <span className="yrounds__kill"><DeathIcon size={10} className="poor-text" />{pr.death.killer === null ? "World" : v.players[pr.death.killer].name}{pr.death.traded && <span className="chip chip--outline">traded</span>}</span> : <span className="faint">Survived</span>}</td>
                  <td><Num v={h ? fmtRatio(h.hits, h.shots) : "–"} /></td>
                  <td>{gate && !gate.validated ? <span className="chip chip--outline" data-tip={gate.reason}>Gated</span> : <Num v={fmtMs(h ? med(h.ttdMs) : null)} />}</td>
                  <td>{gate && !gate.validated ? <span className="chip chip--outline" data-tip={gate.reason}>Gated</span> : <Num v={fmtMs(h ? med(h.reactMs) : null)} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="meta yrounds__note">Reaction against each opponent, and how it compares with theirs, arrives with the metrics update.</p>
    </Card>
  );
}
