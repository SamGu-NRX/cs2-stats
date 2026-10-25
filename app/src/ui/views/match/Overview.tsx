// Overview: both scoreboards with HLTV's columns (one sort and one side switch for both), swing per
// player, the rounds that decided the match, and you against the other nine players. Team facts
// live on the Advanced tab.
import { useMemo, useState } from "react";
import { rollup } from "../../../stats/rollup";
import { MultiBadge, Num } from "../../components/bits";
import { Card } from "../../components/Card";
import { DivergingBars } from "../../components/charts";
import { Segmented } from "../../components/controls";
import { DataTable } from "../../components/DataTable";
import { HoverCard } from "../../components/overlay";
import { matchLines, multiKillRows, RATING_LABEL, RATING_POOLED, SIDE_OPTIONS, type SideKey, type StatLine } from "../../data/engine";
import { roundSlice, type MPlayer as PlayerRow } from "../../data/match";
import { WinIcon, WIN_LABEL } from "../../icons/game";
import { fmtAdr, fmtDiff, fmtPct, fmtRating, fmtSwing } from "../../lib/format";
import { diffScore, roundSwingScore, scoreFill, scoreText, swingScore, toScore, ratingText } from "../../lib/scale";
import type { SortState } from "../../lib/sort";
import { matchHref } from "../../router";
import { PlayerName, RoundCardBody } from "../shared";
import type { TabProps } from "./MatchView";

export default function Overview({ v, file }: TabProps) {
  const [side, setSide] = useState<SideKey>("both");
  const [sort, setSort] = useState<SortState | null>({ key: "rating", dir: "desc" });
  const lines = useMemo(() => matchLines(v, side), [v, side]);
  const multi = useMemo(() => matchLines(v, "both").map((l) => Object.fromEntries(multiKillRows(l.summary.m).map((r) => [r.k, r.rounds])) as Record<2 | 3 | 4 | 5, number>), [v]);
  const team = (t: "us" | "them") => v.players.filter((p) => p.team === t);
  const usSideFirst = v.usStartSide;
  const multiScore = (pi: number) => multi[pi][2] + 2 * multi[pi][3] + 4 * multi[pi][4] + 8 * multi[pi][5];

  const columns = [
    { key: "name", label: "Player", align: "l" as const, sticky: true, sort: (p: PlayerRow) => p.name, render: (p: PlayerRow) => <span className="name-cell"><PlayerName v={v} pi={p.pi} />{p.isHuman && <small>You</small>}</span>, width: 180 },
    { key: "k", label: "K", tip: "Kills", sort: (p: PlayerRow) => lines[p.pi].kills, render: (p: PlayerRow) => lines[p.pi].kills },
    { key: "d", label: "D", tip: "Deaths", sort: (p: PlayerRow) => lines[p.pi].deaths, firstDir: "asc" as const, render: (p: PlayerRow) => lines[p.pi].deaths },
    { key: "a", label: "A", tip: "Assists, flash assists included", sort: (p: PlayerRow) => lines[p.pi].assists, render: (p: PlayerRow) => lines[p.pi].assists },
    { key: "diff", label: "+/−", colored: true, tip: "Kills minus deaths", sort: (p: PlayerRow) => lines[p.pi].diff, render: (p: PlayerRow) => <span style={{ color: scoreText(diffScore(lines[p.pi].diff)) }}>{fmtDiff(lines[p.pi].diff)}</span> },
    { key: "adr", label: "ADR", tip: "Damage to enemies per round", sort: (p: PlayerRow) => lines[p.pi].adr, render: (p: PlayerRow) => fmtAdr(lines[p.pi].adr) },
    { key: "kast", label: "KAST", tip: "Rounds with a kill, assist, survival or traded death", sort: (p: PlayerRow) => lines[p.pi].kast, render: (p: PlayerRow) => <Num v={fmtPct(lines[p.pi].kast)} /> },
    { key: "hs", label: "HS%", tip: "Headshot kills as a share of kills", sort: (p: PlayerRow) => lines[p.pi].hs, render: (p: PlayerRow) => <Num v={fmtPct(lines[p.pi].hs)} /> },
    ...(side === "both" ? [
      { key: "open", label: "FK–FD", tip: "Opening kills and opening deaths: the first kill of a round", sort: (p: PlayerRow) => lines[p.pi].summary.m.openingKills - lines[p.pi].summary.m.openingDeaths, render: (p: PlayerRow) => <span className="num">{lines[p.pi].summary.m.openingKills}<span className="faint">–</span>{lines[p.pi].summary.m.openingDeaths}</span> },
      { key: "mk", label: "Multi-kills", align: "l" as const, tip: "Rounds with 2, 3, 4 or 5 kills", sort: (p: PlayerRow) => multiScore(p.pi), render: (p: PlayerRow) => <MultiChips c={multi[p.pi]} />, width: 170 },
    ] : []),
    { key: "swing", label: "Swing", colored: true, tip: "Average change in your team's round-win probability per round, from your kills (split by damage) and deaths", sort: (p: PlayerRow) => lines[p.pi].swing, render: (p: PlayerRow) => { const x = lines[p.pi].swing; return <span style={{ color: x === null ? "var(--ink3)" : scoreText(swingScore(x)) }}><Num v={fmtSwing(x)} /></span>; } },
    { key: "rating", label: RATING_LABEL, tip: RATING_POOLED, colored: true, sort: (p: PlayerRow) => lines[p.pi].rating, render: (p: PlayerRow) => { const x = lines[p.pi].rating; return <b style={{ color: x === null ? undefined : ratingText(x) }}>{fmtRating(x)}</b>; } },
  ];

  const board = (t: "us" | "them") => {
    const first = t === "us" ? usSideFirst : usSideFirst === "T" ? "CT" : "T";
    return (
      <Card
        title={<>{t === "us" ? "Your team" : "Opponents"} <span className={`chip ${first === "T" ? "chip--t" : "chip--ct"}`}>{first} first</span></>}
        aside={<span className="board-score num" data-team={t}>{t === "us" ? v.entry.score.us : v.entry.score.them}</span>}
        flush
        className="board"
      >
        <DataTable label={t === "us" ? "Your team scoreboard" : "Opponents scoreboard"} rows={team(t)} rowKey={(p) => p.key} columns={columns} sortKey={sort} onSort={setSort} rowClass={(p) => (p.isHuman ? "is-you" : undefined)} />
      </Card>
    );
  };

  // decisive rounds: the largest swing summed over your team, each round rolled up on its own
  const key = useMemo(() => {
    const ids = v.players.filter((p) => p.team === "us").map((p) => p.key);
    return v.rounds.map((r) => ({ r, s: rollup([roundSlice(v.facts, r.ri)], { player: ids }).m }))
      .filter((x) => x.s.swingRounds > 0).map((x) => ({ r: x.r, us: x.s.swing }))
      .sort((a, b) => Math.abs(b.us) - Math.abs(a.us)).slice(0, 4);
  }, [v]);

  return (
    <div className="tabpad overview">
      <div className="overview__bar toolbar">
        <Segmented label="Side" value={side} onChange={setSide} options={SIDE_OPTIONS.map((o) => ({ ...o, label: o.value === "both" ? "Both sides" : o.label, side: o.value === "both" ? undefined : o.value }))} />
        <span className="meta">{side === "both" ? `${lines[v.human].rounds} rounds with stats` : `${lines[v.human].rounds} rounds on ${side.toUpperCase()}`}</span>
      </div>
      <div className="boards">
        {board("us")}
        {board("them")}
      </div>
      <div className="overview__cols">
        <Card title="Swing by player" aside={<span className="meta">Average per round</span>}>
          <DivergingBars
            cap={0.06}
            rows={[...v.players].sort((a, b) => (a.team === b.team ? (lines[b.pi].swing ?? 0) - (lines[a.pi].swing ?? 0) : a.team === "us" ? -1 : 1)).map((p) => {
              const x = lines[p.pi].swing;
              return { key: p.key, label: <span className={p.team === "us" ? "us-text" : "them-text"}><PlayerName v={v} pi={p.pi} /></span>, value: x, text: x === null ? "–" : fmtSwing(x), highlight: p.isHuman };
            })}
          />
        </Card>
        <div className="overview__side">
          <Lobby lines={lines} human={v.human} />
          <Card title="Rounds that decided it" aside={<span className="meta">Largest team swing</span>}>
            {key.length ? (
              <ul className="keyrounds">
                {key.map(({ r, us }) => (
                  <li key={r.ri}>
                    <HoverCard prefer="right" card={() => <RoundCardBody v={v} r={r} />} as="div" tabbable={false}>
                      <a href={matchHref(file, "rounds", { round: r.number })} className="keyround">
                        <WinIcon how={r.how} size={14} className={r.winSide === "T" ? "t-text" : "ct-text"} />
                        <b>Round {r.number}</b>
                        <span className="meta">{r.how ? WIN_LABEL[r.how] : ""}</span>
                        <span className="num faint">{r.scoreAfter ? `${r.scoreAfter.us}:${r.scoreAfter.them}` : ""}</span>
                        <b className="num" style={{ color: scoreText(roundSwingScore(us / 2)) }}>{fmtSwing(us)}</b>
                      </a>
                    </HoverCard>
                  </li>
                ))}
              </ul>
            ) : <p className="meta">No round has swing data in this match.</p>}
          </Card>
        </div>
      </div>
    </div>
  );
}

function MultiChips({ c }: { c: Record<2 | 3 | 4 | 5, number> }) {
  const any = c[2] + c[3] + c[4] + c[5];
  if (!any) return <span className="faint">–</span>;
  return (
    <span className="mchips">
      {([5, 4, 3, 2] as const).filter((k) => c[k]).map((k) => <span key={k} className="mchip"><MultiBadge k={k} />{c[k] > 1 && <small className="num">×{c[k]}</small>}</span>)}
    </span>
  );
}

/** You against the lobby: where your number sits between the worst and best of the ten players. */
function Lobby({ lines, human }: { lines: StatLine[]; human: number }) {
  const rows: { label: string; get: (l: StatLine) => number | null; fmt: (x: number | null) => string; lower?: boolean }[] = [
    { label: "Rating", get: (l) => l.rating, fmt: fmtRating },
    { label: "ADR", get: (l) => l.adr, fmt: fmtAdr },
    { label: "KAST", get: (l) => l.kast, fmt: (x) => fmtPct(x) },
    { label: "Swing", get: (l) => (l.swing === null ? null : 100 * l.swing), fmt: (x) => (x === null ? "–" : fmtSwing(x / 100)) },
    { label: "HS%", get: (l) => l.hs, fmt: (x) => fmtPct(x) },
    { label: "Deaths per round", get: (l) => l.dpr, fmt: (x) => (x === null ? "–" : x.toFixed(2)), lower: true },
  ];
  return (
    <Card title="You against the lobby" aside={<span className="meta">All ten players</span>}>
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
            <li key={r.label} data-tip={`Lobby average ${r.fmt(avg)}, range ${r.fmt(lo)} to ${r.fmt(hi)}`}>
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
      <p className="meta lobby__note">The bar runs from the lobby's lowest to highest; the white tick is the average.</p>
    </Card>
  );
}
