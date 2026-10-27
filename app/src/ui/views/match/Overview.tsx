// Overview: both scoreboards with HLTV's columns (one sort and one side switch for both) and a team
// total under each, swing per player, this match against your recent ones (YourMatch), your rounds
// that decided the match, you against the other nine players, and Leetify's numbers for the match when it
// is joined to a Leetify match (leetify/LeetifyMatchCard.tsx). Team facts live on the Advanced tab.
import { useMemo, useState } from "react";
import { ClutchBadge, DeathMark, FirstPip, MultiBadge, Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { DivergingBars } from "../../components/charts";
import { Segmented } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { HoverCard } from "../../components/overlay";
import { multiKillRows, pooledRates, RATING_LABEL, SIDE_OPTIONS, statLine, type SideKey, type StatLine } from "../../data/engine";
import { decidingRounds } from "../../data/rounds";
import { useCall } from "../../data/hooks";
import { deathOf, killsBy, roundSwing, teamLabel, type MatchModel, type MRound, type Team, type ViewedMatch } from "../../data/match";
import { WeaponIcon, WIN_LABEL, WinIcon } from "../../icons/game";
import { fmtAdr, fmtDiff, fmtPct, fmtRating, fmtSwing } from "../../lib/format";
import { diffScore, roundSwingScore, scoreFill, scoreText, swingScore, toScore, ratingText } from "../../lib/scale";
import type { SortState } from "../../lib/sort";
import { matchHref, setQuery } from "../../router";
import { NeedsDemo, PlayerName, RoundCardBody, swingSumTip, YouTag } from "../shared";
import { Hint } from "./glyphs";
import type { TabProps } from "./MatchView";
import { YourMatch } from "./YourMatch";
import { Viewed, viewerName } from "./Viewer";
import { LeetifyMatchCard } from "../leetify/LeetifyMatchCard";

type Multi = Record<2 | 3 | 4 | 5, number>;
/** A scoreboard row: a player, or the team total under the five players (pi null). */
interface Row { key: string; pi: number | null; team: Team; isHuman: boolean; l: StatLine; multi: Multi | null; rated: boolean }

/** The team total: counts summed over the five rows shown; rates from the team's rollup (both sides) or pooled from the rows (one side). */
function teamRow(v: MatchModel, t: Team, rows: Row[], side: SideKey): Row {
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const m = { ...rows[0].l.m };
  for (const k of ["kills", "deaths", "assists", "flashAssists", "tradedDeaths", "openingKills", "openingDeaths"] as const) m[k] = sum((r) => r.l.m[k]);
  const team = side === "both" ? statLine(v.b.teams[t]) : null;
  // one side: the team's rates pooled from the five players' summed measures
  const pooled = team ? null : pooledRates(rows.map((r) => r.l.m));
  const l: StatLine = {
    ...(team ?? rows[0].l), m, kills: m.kills, deaths: m.deaths, assists: m.assists, diff: m.kills - m.deaths,
    ...(team ? { adr: team.adr, kast: team.kast, hs: team.hs, swing: team.swing } : pooled!), rating: null,
  };
  const multi = rows.every((r) => r.multi) ? ([2, 3, 4, 5] as const).reduce((o, k) => ({ ...o, [k]: sum((r) => r.multi![k]) }), {} as Multi) : null;
  return { key: `total-${t}`, pi: null, team: t, isHuman: false, l, multi, rated: false };
}

export default function Overview({ v, file }: TabProps) {
  const [side, setSide] = useState<SideKey>("both");
  const [sort, setSort] = useState<SortState | null>({ key: "rating", dir: "desc" });
  const lines = useMemo(() => v.b.lines[side].map(statLine), [v, side]);
  const multi = useMemo(() => v.b.lines.both.map((l) => Object.fromEntries(multiKillRows(l.m).map((r) => [r.k, r.rounds])) as Multi), [v]);
  const rowsOf = (t: Team): Row[] => v.players.filter((p) => p.team === t).map((p) => ({ key: p.key, pi: p.pi, team: t, isHuman: p.isHuman, l: lines[p.pi], multi: multi[p.pi], rated: true }));
  const usSideFirst = v.usStartSide;
  const multiScore = (c: Multi | null) => (c ? c[2] + 2 * c[3] + 4 * c[4] + 8 * c[5] : 0);
  const paren = (n: number) => <small className="faint"> ({n})</small>;

  const columns = [
    { key: "name", label: "Player", align: "l" as const, sticky: true, sort: (r: Row) => (r.pi === null ? "" : v.players[r.pi].name), render: (r: Row) => (r.pi === null ? <span className="name-cell faint">Team total</span> : <span className="name-cell"><PlayerName v={v} pi={r.pi} /><YouTag v={v} pi={r.pi} /></span>), width: 180 },
    { key: "k", label: "K", tip: "Kills", sort: (r: Row) => r.l.kills, render: (r: Row) => r.l.kills },
    { key: "d", label: <>D <span className="th-lc">(t)</span></>, tip: "Deaths; traded deaths in brackets", sort: (r: Row) => r.l.deaths, firstDir: "asc" as const, render: (r: Row) => <span className="num">{r.l.deaths}{paren(r.l.m.tradedDeaths)}</span> },
    { key: "a", label: <>A <span className="th-lc">(f)</span></>, tip: "Assists; flash assists in brackets", sort: (r: Row) => r.l.assists, render: (r: Row) => <span className="num">{r.l.assists}{paren(r.l.m.flashAssists)}</span> },
    { key: "diff", label: "+/−", colored: true, tip: "Kills minus deaths", sort: (r: Row) => r.l.diff, render: (r: Row) => <span style={{ color: scoreText(diffScore(r.l.diff)) }}>{fmtDiff(r.l.diff)}</span> },
    { key: "adr", label: "ADR", tip: "Damage to enemies per round", sort: (r: Row) => r.l.adr, render: (r: Row) => fmtAdr(r.l.adr) },
    { key: "kast", label: "KAST", tip: "Rounds with a kill, assist, survival or traded death", sort: (r: Row) => r.l.kast, render: (r: Row) => <Num v={fmtPct(r.l.kast)} /> },
    { key: "hs", label: "HS%", tip: "Share of kills that were headshots", sort: (r: Row) => r.l.hs, render: (r: Row) => <Num v={fmtPct(r.l.hs)} /> },
    ...(side === "both" ? [
      { key: "open", label: "FK–FD", tip: "Opening kills and deaths: each round's first kill", sort: (r: Row) => r.l.m.openingKills - r.l.m.openingDeaths, render: (r: Row) => <span className="num">{r.l.m.openingKills}<span className="faint">–</span>{r.l.m.openingDeaths}</span> },
      { key: "mk", label: "Multi-kills", align: "l" as const, tip: "Rounds with 2, 3, 4 or 5 kills", sort: (r: Row) => multiScore(r.multi), render: (r: Row) => (r.multi ? <MultiChips c={r.multi} /> : null), width: 170 },
    ] : []),
    { key: "swing", label: "Swing", colored: true, tip: "Average change in round-win chance per round", sort: (r: Row) => r.l.swing, render: (r: Row) => { const x = r.l.swing; return <span style={{ color: x === null ? "var(--ink3)" : scoreText(swingScore(x)) }} data-tip={r.pi === null ? undefined : swingSumTip(r.l.m)} tabIndex={r.pi === null ? undefined : 0}><Num v={fmtSwing(x)} /></span>; } },
    { key: "rating", label: RATING_LABEL, tip: "Rated per side over the rounds it can value", colored: true, sort: (r: Row) => r.l.rating, render: (r: Row) => { if (!r.rated) return null; const x = r.l.rating; return <b style={{ color: x === null ? undefined : ratingText(x) }}>{fmtRating(x)}</b>; } },
  ];

  const board = (t: Team) => {
    const first = t === "us" ? usSideFirst : usSideFirst === "T" ? "CT" : "T";
    const rows = rowsOf(t);
    return (
      <Card
        title={<>{teamLabel(v, t)} <span className={`chip ${first === "T" ? "chip--t" : "chip--ct"}`}>{first} first</span></>}
        aside={<span className="board-score num" data-team={t}>{t === "us" ? v.entry.score.us : v.entry.score.them}</span>}
        flush
        className="board"
      >
        <DataTable label={`${teamLabel(v, t)} scoreboard`} rows={rows} foot={[teamRow(v, t, rows, side)]} rowKey={(r) => r.key} columns={columns} sortKey={sort} onSort={setSort} rowClass={(r) => (r.isHuman ? "is-you" : undefined)}
          onOpen={v.pro ? (r) => setQuery("as", r.isHuman || r.pi === null ? null : String(r.pi)) : undefined} />
      </Card>
    );
  };

  return (
    <div className="tabpad overview">
      <div className="overview__bar toolbar">
        <Segmented label="Side" value={side} onChange={setSide} options={SIDE_OPTIONS.map((o) => ({ ...o, label: o.value === "both" ? "Both sides" : o.label, side: o.value === "both" ? undefined : o.value }))} />
        <span className="meta">{v.human === null
          ? `${v.nRounds} rounds`
          : side === "both" ? `${lines[v.human].rounds} rounds with stats` : `${lines[v.human].rounds} rounds on ${side.toUpperCase()}`}</span>
      </div>
      <div className="boards">
        {board("us")}
        {board("them")}
      </div>
      <div className="overview__cols">
        <div className="overview__side">
          <Card title="Swing by player" aside={<span className="meta">Average per round</span>}>
            <DivergingBars
              cap={0.06}
              rows={[...v.players].sort((a, b) => (a.team === b.team ? (lines[b.pi].swing ?? 0) - (lines[a.pi].swing ?? 0) : a.team === "us" ? -1 : 1)).map((p) => {
                const x = lines[p.pi].swing;
                return { key: p.key, label: <span className={p.team === "us" ? "us-text" : "them-text"}><PlayerName v={v} pi={p.pi} /></span>, value: x, text: x === null ? "–" : fmtSwing(x), highlight: p.isHuman };
              })}
            />
          </Card>
          {!v.pro && <Viewed v={v} what="this match against your recent ones" pad={false}>{(w) => <YourMatch v={w} file={file} />}</Viewed>}
        </div>
        <div className="overview__side">
          <Viewed v={v} what="how they did against the lobby, and the rounds they decided" pad={false}>{(w) => <>
            <Lobby lines={lines} human={w.human} who={viewerName(w)} />
            <DecidingRounds v={w} file={file} side={side} />
          </>}</Viewed>
        </div>
      </div>
      <LeetifyMatchCard v={v} />
    </div>
  );
}

const DECIDING = 5;

/** Your rounds with the largest swing either way, each with what you did in it; a row opens the round. */
function DecidingRounds({ v, file, side }: { v: ViewedMatch; file: string; side: SideKey }) {
  const human = v.human;
  const clutches = useCall("clutches", [{ files: [file], filter: { player: v.players[human].key } }]).data;
  const rows = useMemo(() => decidingRounds(v.rounds, (r: MRound) => roundSwing(r.pr[human]), side, DECIDING), [v, human, side]);
  return (
    <Card title="Rounds that decided it" aside={<span className="meta">Your largest swings</span>}>
      {rows.length ? (
        <ul className="keyrounds">
          {rows.map(({ r, sw }) => {
            const kills = killsBy(r, human);
            const died = deathOf(r, human) !== null;
            const opened = r.kills.find((k) => k.opening)?.killer === human;
            const clutch = clutches?.find((c) => c.round === r.number) ?? null;
            const side = r.winSide === "T" ? "t-text" : r.winSide === "CT" ? "ct-text" : "faint";
            return (
              <li key={r.ri}>
                <HoverCard prefer="right" card={() => <RoundCardBody v={v} r={r} />} as="div" tabbable={false}>
                  <a href={matchHref(file, "rounds", { round: r.number })} className="keyround" data-tip={r.how ? WIN_LABEL[r.how] : undefined} aria-label={`Round ${r.number}${r.how ? `, ${WIN_LABEL[r.how].toLowerCase()}` : ""}: ${kills.length} kills${died ? ", died" : ""}, swing ${fmtSwing(sw)}`}>
                    <span className={side}><WinIcon how={r.how} size={14} compact /></span>
                    <b>Round {r.number}</b>
                    <span className="keyround__what">
                      {kills.slice(0, 5).map((k, i) => <WeaponIcon key={i} name={k.weapon} height={12} />)}
                      {kills.length > 1 && <MultiBadge k={kills.length} />}
                      {clutch && <ClutchBadge vs={clutch.opponents} won={clutch.won} />}
                      {opened && <FirstPip label="First kill of the round" />}
                      {died && <DeathMark label="Died" className="faint" />}
                    </span>
                    <span className="num faint">{r.scoreAfter ? `${r.scoreAfter.us}:${r.scoreAfter.them}` : ""}</span>
                    <b className="num" style={{ color: scoreText(roundSwingScore(sw)) }}>{fmtSwing(sw)}</b>
                  </a>
                </HoverCard>
              </li>
            );
          })}
        </ul>
      ) : <p className="meta"><NeedsDemo detail="No round has swing: equipment is unknown in this log." /></p>}
    </Card>
  );
}

function MultiChips({ c }: { c: Multi }) {
  const any = c[2] + c[3] + c[4] + c[5];
  if (!any) return <span className="faint">–</span>;
  return (
    <span className="mchips">
      {([5, 4, 3, 2] as const).filter((k) => c[k]).map((k) => <span key={k} className="mchip"><MultiBadge k={k} />{c[k] > 1 && <small className="num">×{c[k]}</small>}</span>)}
    </span>
  );
}

/** You against the lobby: where your number sits between the worst and best of the ten players. */
function Lobby({ lines, human, who }: { lines: StatLine[]; human: number; who: string }) {
  const rows: { label: string; get: (l: StatLine) => number | null; fmt: (x: number | null) => string; lower?: boolean }[] = [
    { label: "Rating", get: (l) => l.rating, fmt: fmtRating },
    { label: "ADR", get: (l) => l.adr, fmt: fmtAdr },
    { label: "KAST", get: (l) => l.kast, fmt: (x) => fmtPct(x) },
    { label: "Swing", get: (l) => (l.swing === null ? null : 100 * l.swing), fmt: (x) => (x === null ? "–" : fmtSwing(x / 100)) },
    { label: "HS%", get: (l) => l.hs, fmt: (x) => fmtPct(x) },
    { label: "Deaths per round", get: (l) => l.dpr, fmt: (x) => (x === null ? "–" : x.toFixed(2)), lower: true },
  ];
  return (
    <Card title={<>{who} against the lobby <Hint tip="Bar spans the lobby's lowest to highest; the tick is the average." /></>} aside={<span className="meta">All ten players</span>}>
      <ul className="lobby">
        {rows.map((r) => {
          const vals = lines.map(r.get).filter((x): x is number => x !== null);
          const you = r.get(lines[human]);
          if (you === null || vals.length < 2) return null;
          const lo = Math.min(...vals);
          const hi = Math.max(...vals);
          const avg = vals.reduce((a, x) => a + x, 0) / vals.length;
          const pos = (x: number) => (hi === lo ? 50 : ((x - lo) / (hi - lo)) * 100);
          const rank = [...vals].sort((a, b) => (r.lower ? a - b : b - a)).indexOf(you) + 1;
          const t = toScore(you, avg, Math.max(1e-6, (hi - lo) / 2), r.lower);
          return (
            <li key={r.label} data-tip={`Lobby average ${r.fmt(avg)}, range ${r.fmt(lo)} to ${r.fmt(hi)}`} tabIndex={0}>
              <span className="lobby__l">{r.label}</span>
              <span className="lobby__track">
                <i className="lobby__avg" style={{ left: `${pos(avg)}%` }} />
                <i className="lobby__you" style={{ left: `${pos(you)}%`, background: scoreFill(t) }} />
              </span>
              <b className="num" style={{ color: scoreText(t) }}>{r.fmt(you)}</b>
              <span className="lobby__rank num faint">#{rank}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
