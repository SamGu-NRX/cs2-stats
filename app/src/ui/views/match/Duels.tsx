// Duels: head to head by kills, damage, first kills and blinds (HeadToHead), your duels round by round,
// opening duels and trades per player, the match's first kills round by round (Openings), and every clutch.
import { useEffect, useMemo, useState } from "react";
import { TRADE_WINDOW_S } from "../../../stats/rules";
import { ClutchBadge, FirstPip, Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { DataTable } from "../../components/DataTable";
import { TradingGlyph } from "./glyphs";
import { HeadToHead } from "./HeadToHead";
import { Openings } from "./Openings";
import { fmtMetric } from "../../data/engine";
import { deathOf, killsBy, sideWord, teamLabel, type MPlayer as PlayerRow, type ViewedMatch } from "../../data/match";
import { Viewed } from "./Viewer";
import { metric as meta } from "../../data/meta";
import { useData } from "../../data/provider";
import { FlagIcon, WinIcon } from "../../icons/game";
import { matchHref } from "../../router";
import type { ClutchRow } from "../../../worker/protocol";
import { scoreText, toScore } from "../../lib/scale";
import { NEEDS_DEMO, PlayerName, SectionAside } from "../shared";
import type { TabProps } from "./MatchView";

export default function Duels({ v }: TabProps) {
  const lines = v.b.lines.both;
  const m = (p: PlayerRow) => lines[p.pi].m;
  const metric = (p: PlayerRow, id: string) => lines[p.pi].v[id];
  const fk = (t: "us" | "them") => v.players.filter((p) => p.team === t).reduce((a, p) => a + m(p).openingKills, 0);
  return (
    <div className="tabpad duels">
      <HeadToHead v={v} />
      <Viewed v={v} what="their kills and deaths round by round" pad={false}>{(w) => <YourRounds v={w} />}</Viewed>
      <div className="grid-2">
        <Card title="Opening duels" icon={<FirstPip />} aside={<SectionAside label="First kills" value={<><span className="cream">{fk("us")}</span><span className="faint">–</span>{fk("them")}</>} />} flush>
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
              { key: "tk", label: "Trade kills", tip: `Killed an enemy within ${TRADE_WINDOW_S} s of a teammate's death`, sort: (p) => m(p).tradeKills, render: (p) => m(p).tradeKills },
              { key: "td", label: "Traded", tip: meta("deathsTradedPct").def, sort: (p) => metric(p, "deathsTradedPct"), render: (p) => <span className="num">{m(p).tradedDeaths}<span className="faint">/{m(p).deaths}</span></span> },
              { key: "saved", label: "Saved", tip: "Killed an enemy hurting a teammate, who then lived", sort: (p) => m(p).savedTeammate, render: (p) => m(p).savedTeammate },
              { key: "savedby", label: "Saved by", tip: "Times a teammate did that for you", sort: (p) => m(p).savedByTeammate, render: (p) => m(p).savedByTeammate },
            ]}
          />
        </Card>
      </div>
      <Viewed v={v} what="their opening duels" pad={false}>{(w) => <Openings v={w} file={v.file} />}</Viewed>
      <Clutches v={v} file={v.file} />
    </div>
  );
}

type Clutch = ClutchRow & { pi: number };

/** Every clutch in the match from the engine's clutch list (stats/closing.ts), both teams; a row opens
 *  the round. The engine's rows carry no player, so it is asked once per player. */
function Clutches({ v, file }: { v: TabProps["v"]; file: string }) {
  const { client, version } = useData();
  const [rows, setRows] = useState<Clutch[] | null>(null);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    void Promise.all(v.players.map((p) => client.clutches({ files: [file], filter: { player: p.key } }).then((rs) => rs.map((r) => ({ ...r, pi: p.pi })))))
      .then((all) => alive && setRows(all.flat().sort((a, b) => a.round - b.round || a.pi - b.pi)), () => alive && setRows([]));
    return () => { alive = false; };
  }, [client, version, file, v.players]);
  const of = (t: "us" | "them") => (rows ?? []).filter((c) => v.players[c.pi].team === t);
  const score = (t: "us" | "them") => <>{of(t).filter((c) => c.won).length}<span className="faint">/{of(t).length}</span></>;
  return (
    <Card title="Clutches" icon={<span className="cream"><WinIcon how="defuse" size={16} beside /></span>} aside={<><SectionAside label={sideWord(v, "us")} value={score("us")} color="var(--cream)" /><SectionAside label={sideWord(v, "them")} value={score("them")} /></>}>
      {rows === null ? <div className="skel" style={{ height: 120 }} /> : (
        <div className="clutches">
          {(["us", "them"] as const).map((t) => (
            <section key={t} aria-label={`Clutches: ${teamLabel(v, t)}`}>
              <h3 className="caps clutches__h">{teamLabel(v, t)}</h3>
              {of(t).length ? (
                <ul className="clutches__list">
                  {of(t).map((c) => (
                    <li key={`${c.round}-${c.pi}`}>
                      <a className={`clutch-row ${v.players[c.pi].isHuman ? "is-you" : ""}`} href={matchHref(file, "rounds", { round: c.round })} aria-label={`Round ${c.round}: ${v.players[c.pi].name}, 1 against ${c.opponents}, ${c.won ? "won" : "lost"}`}>
                        <span className="num faint">R{c.round}</span>
                        <ClutchBadge vs={c.opponents} won={c.won} />
                        <span className={`clutch-row__name ${c.side === "T" ? "t-text" : "ct-text"}`}>{v.players[c.pi].name}</span>
                        <span className={c.won ? "cream" : "faint"}>{c.won ? "Won" : "Lost"}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : <p className="meta">No clutches.</p>}
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Your fights round by round: who you killed, who killed you, and how you shot. Time to damage and
 *  reaction need mesh visibility, which plugin recordings do not carry. */
function YourRounds({ v }: { v: ViewedMatch }) {
  const gated = !v.visibility;
  const gate = `${NEEDS_DEMO}: this file lacks view angles and line of sight`;
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
            <th><span className="th" data-tip={meta("accuracy").def} tabIndex={0}>Accuracy</span></th>
            <th><span className="th" data-tip={meta("timeToDamage").def} tabIndex={0}>TTD</span></th>
            <th><span className="th" data-tip={meta("reactionTime").def} tabIndex={0}>Reaction</span></th>
          </tr></thead>
          <tbody>
            {rows.map(({ r, kills, death, s }) => {
              const won = r.winner === "us";
              return (
                <tr key={r.ri}>
                  <td className="l"><span className={`wl wl--${won ? "W" : "L"}`}>{r.number}</span></td>
                  <td className="l"><span className="yrounds__names">{kills.map((k, i) => <span key={i} className="yrounds__kill">{v.players[k.victim].name}{k.headshot && <FlagIcon id="headshot" label="Headshot" size={11} />}</span>)}{!kills.length && <span className="faint">–</span>}</span></td>
                  <td className="l">{death ? <span className="yrounds__kill">{death.killer === null ? "World" : v.players[death.killer].name}{death.traded && <span className="chip chip--outline">traded</span>}</span> : <span className="faint">Survived</span>}</td>
                  <td><Num v={v.entry.hasAim ? metric(s, "accuracy") : "–"} /></td>
                  <td>{gated ? <span className="faint" data-tip={gate} tabIndex={0}>–</span> : <Num v={metric(s, "timeToDamage")} />}</td>
                  <td>{gated ? <span className="faint" data-tip={gate} tabIndex={0}>–</span> : <Num v={metric(s, "reactionTime")} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
